import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { Project, QueueItem, SourceRecord } from "../types.js";
import { extractDocument, sourceKind } from "./extract.js";
import { analyzeOffline, analyzeWithModel } from "./llm.js";
import { firstParagraph, isUnknownGlyphText, normalizeText, readableTextOrFallback } from "./text.js";
import { idFrom, slugify } from "./slug.js";
import { nowIso } from "./time.js";
import {
  listFiles,
  readQueue,
  readSettings,
  readSources,
  safeJoin,
  toPosix,
  touchProject,
  writeQueue,
  writeSources,
  writeText
} from "./storage.js";
import {
  appendLog,
  updateIndex,
  updateOverview,
  upsertConceptPages,
  upsertEntityPages,
  writeConvertedSourcePage,
  writeSourcePage
} from "./wiki.js";

const runningProjects = new Set<string>();
const projectLocks = new Map<string, Promise<void>>();
const queueFlushInterval = readPositiveInteger("LLM_WIKI_QUEUE_FLUSH_INTERVAL", 20);
const maxArchivePathSegmentBytes = readPositiveInteger("LLM_WIKI_MAX_ARCHIVE_PATH_SEGMENT_BYTES", 180);
const zipUtf8FileNameFlag = 0x0800;
const ARCHIVE_EXTENSIONS = new Set([".zip"]);
const BULK_SOURCE_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".pdf",
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".htm",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".log",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff"
]);

export interface BulkImportResult {
  sources: SourceRecord[];
  total: number;
  queued: number;
  skipped: number;
  archives: Array<{ fileName: string; extracted: number; directory: string }>;
}

export async function importUploadedSource(
  project: Project,
  file: Express.Multer.File,
  requestedPath?: string
): Promise<SourceRecord> {
  const safeName = normalizeUploadedFileName(requestedPath || file.originalname);
  const destinationRelative = await uniqueRawPath(project, safeName);
  const destination = safeJoin(project.root, destinationRelative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(file.path, destination);
  const result = await registerSourcesBulk(project, [destinationRelative]);
  if (result.queued > 0) processProjectQueue(project).catch((error) => console.error("[ingest] queue failed", error));
  return result.sources[0];
}

export async function importUploadedSources(project: Project, files: Express.Multer.File[]): Promise<BulkImportResult> {
  const relativePaths: string[] = [];
  const archives: BulkImportResult["archives"] = [];

  for (const file of files) {
    const originalName = normalizeUploadedFileName(file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    if (ARCHIVE_EXTENSIONS.has(ext)) {
      const archive = await extractUploadedArchive(project, file, originalName);
      archives.push({
        fileName: archive.fileName,
        extracted: archive.extracted,
        directory: archive.directory
      });
      relativePaths.push(...archive.extractedFiles.map((item) => toPosix(path.posix.join(archive.directory, item))));
      continue;
    }

    const destinationRelative = await uniqueRawPath(project, originalName);
    const destination = safeJoin(project.root, destinationRelative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(file.path, destination);
    relativePaths.push(destinationRelative);
  }

  const result = await registerSourcesBulk(project, relativePaths);
  if (result.queued > 0) processProjectQueue(project).catch((error) => console.error("[ingest] queue failed", error));
  return { ...result, archives };
}

export async function recordFailedUploadedSources(
  project: Project,
  files: Express.Multer.File[],
  reason: unknown
): Promise<void> {
  const timestamp = nowIso();
  const message = reason instanceof Error ? reason.message : String(reason);
  await withProjectLock(project.id, async () => {
    const sources = await readSources(project);
    const next = [...sources];
    for (const file of files) {
      const fileName = normalizeUploadedFileName(file.originalname || file.filename || "upload");
      const parsed = path.posix.parse(fileName);
      const base = slugify(parsed.name || "failed-upload", "failed-upload");
      const ext = parsed.ext || ".upload";
      const relativePath = `raw/sources/_failed/${base}-${Date.now().toString(36)}-${next.length}${ext}`;
      const id = idFrom(`failed-${relativePath}`);
      next.push({
        id,
        fileName,
        relativePath,
        kind: sourceKind(fileName),
        size: file.size || 0,
        sha256: `failed-${id}`,
        importedAt: timestamp,
        updatedAt: timestamp,
        status: "failed",
        error: message.slice(0, 1000)
      });
    }
    await writeSources(project, next);
  });
}

export async function importWebClip(
  project: Project,
  input: { title: string; url?: string; content: string }
): Promise<SourceRecord> {
  const title = input.title?.trim() || input.url || "web-clip";
  const body = [`# ${title}`, "", input.url ? `URL: ${input.url}` : "", "", normalizeText(input.content)].join("\n");
  const relative = await uniqueRawPath(project, `web-clips/${slugify(title)}.md`);
  await writeText(safeJoin(project.root, relative), body);
  const result = await registerSourcesBulk(project, [relative]);
  if (result.queued > 0) processProjectQueue(project).catch((error) => console.error("[ingest] queue failed", error));
  return result.sources[0];
}

export async function rescanSources(project: Project): Promise<{ queued: number; total: number }> {
  const rawRoot = safeJoin(project.root, "raw/sources");
  const files = await listFiles(rawRoot);
  const result = await registerSourcesBulk(
    project,
    files.map((file) => `raw/sources/${file}`)
  );
  if (result.queued > 0) processProjectQueue(project).catch((error) => console.error("[ingest] queue failed", error));
  return { queued: result.queued, total: files.length };
}

export async function getActivity(
  project: Project,
  options: { sourceLimit?: number; queueLimit?: number; compact?: boolean } = {}
): Promise<{
  queue: QueueItem[];
  sources: SourceRecord[];
  queueTotal: number;
  sourceTotal: number;
  sourceBytesTotal: number;
}> {
  const [queue, sources] = await Promise.all([readQueue(project), readSources(project)]);
  const sourceLimit = normalizeLimit(options.sourceLimit, 500);
  const queueLimit = normalizeLimit(options.queueLimit, 500);
  const visibleQueue = selectRecentWithActive(queue, queueLimit);
  const visibleSources = selectRecentWithActive(sources, sourceLimit);
  return {
    queue: visibleQueue,
    sources: options.compact ? visibleSources.map(compactSourceRecord) : visibleSources,
    queueTotal: queue.length,
    sourceTotal: sources.length,
    sourceBytesTotal: sources.reduce((sum, source) => sum + source.size, 0)
  };
}

function compactSourceRecord(source: SourceRecord): SourceRecord {
  const { summary: _summary, ...rest } = source;
  return {
    ...rest,
    error: source.error ? source.error.slice(0, 500) : undefined
  };
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.min(5000, Math.floor(value));
}

function selectRecentWithActive<T extends { id?: string; status: string; updatedAt?: string; createdAt?: string }>(
  items: T[],
  limit: number
): T[] {
  if (items.length <= limit) return items;
  const active = items.filter((item) => ["queued", "running", "ingesting"].includes(item.status));
  const recent = items.slice(-limit);
  const byKey = new Map<string, T>();
  for (const item of [...recent, ...active]) {
    const key = item.id || `${item.status}-${item.updatedAt || item.createdAt || ""}-${JSON.stringify(item).slice(0, 120)}`;
    byKey.set(key, item);
  }
  return [...byKey.values()].slice(-limit);
}

export async function processProjectQueue(project: Project): Promise<void> {
  if (runningProjects.has(project.id)) return;
  runningProjects.add(project.id);
  let processed = 0;
  try {
    while (true) {
      const queue = await readQueue(project);
      const activeItems = queue.filter((candidate) => candidate.status === "queued" || candidate.status === "running");
      if (!activeItems.length) break;

      const sources = await readSources(project);
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const queuePatches = new Map<string, Partial<QueueItem>>();
      const sourcePatches = new Map<string, Partial<SourceRecord>>();
      let pending = 0;

      for (const item of activeItems) {
        const source = sourceById.get(item.sourceId);
        if (!source) {
          queuePatches.set(item.id, {
            status: "failed",
            updatedAt: nowIso(),
            error: `Source not found: ${item.sourceId}`
          });
          pending += 1;
        } else {
          queuePatches.set(item.id, { status: "running", updatedAt: nowIso(), error: undefined });
          sourcePatches.set(source.id, { status: "ingesting", updatedAt: nowIso(), error: undefined });
          try {
            const result = await ingestQueueItem(project, source);
            queuePatches.set(item.id, { status: "done", updatedAt: nowIso(), error: undefined });
            sourcePatches.set(source.id, result.sourcePatch);
            sourceById.set(source.id, { ...source, ...result.sourcePatch });
            await appendLog(project, result.logEntry);
            processed += 1;
            pending += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const patch: Partial<SourceRecord> = { status: "failed", error: message, updatedAt: nowIso() };
            queuePatches.set(item.id, { status: "failed", updatedAt: nowIso(), error: message });
            sourcePatches.set(source.id, patch);
            sourceById.set(source.id, { ...source, ...patch });
            pending += 1;
          }
        }

        if (pending >= queueFlushInterval) {
          await flushQueueProgress(project, queuePatches, sourcePatches);
          queuePatches.clear();
          sourcePatches.clear();
          pending = 0;
        }
      }

      await flushQueueProgress(project, queuePatches, sourcePatches);
    }
  } finally {
    runningProjects.delete(project.id);
  }

  if (processed > 0) {
    await updateOverview(project);
    await updateIndex(project);
    await touchProject(project);
  }
}

export async function enqueueSource(project: Project, source: SourceRecord): Promise<void> {
  await enqueueSourceLocked(project, source);
  processProjectQueue(project).catch((error) => console.error("[ingest] queue failed", error));
}

async function enqueueSourceLocked(project: Project, source: SourceRecord): Promise<void> {
  await withProjectLock(project.id, async () => {
    const queue = await readQueue(project);
    const hasActiveItem = queue.some(
      (item) => item.sourceId === source.id && (item.status === "queued" || item.status === "running")
    );
    if (!hasActiveItem) {
      queue.push({
        id: idFrom(`${source.id}-${source.sha256}-${Date.now()}`),
        sourceId: source.id,
        relativePath: source.relativePath,
        status: "queued",
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      await writeQueue(project, queue);
    }
    const sources = await readSources(project);
    await writeSources(
      project,
      sources.map((item) =>
        item.id === source.id ? { ...item, status: "queued", updatedAt: nowIso(), error: undefined } : item
      )
    );
  });
}

async function ingestQueueItem(
  project: Project,
  source: SourceRecord
): Promise<{ sourcePatch: Partial<SourceRecord>; logEntry: string }> {
  const fullPath = safeJoin(project.root, source.relativePath);
  const assetRelativeDir = `raw/assets/${source.id}`;
  const extracted = await extractDocument(fullPath, {
    assetDir: safeJoin(project.root, assetRelativeDir),
    assetRelativeDir,
    assetUrl: (relativePath) => `/api/v1/projects/${project.id}/assets?path=${encodeURIComponent(relativePath)}`
  });
  const text = extracted.text || `${source.fileName}\n无可抽取文本。`;
  const settings = await readSettings(project);
  const analysis = (await analyzeWithModel(settings, extracted.title, text)) ?? analyzeOffline(extracted.title, text);
  const excerpt = firstParagraph(text, 1200);
  const convertedPath = await writeConvertedSourcePage(project, {
    title: extracted.title,
    sourcePath: source.relativePath,
    sourceId: source.id,
    sha256: source.sha256,
    kind: extracted.kind,
    markdown: extracted.markdown,
    assets: extracted.assets,
    warnings: extracted.warnings,
    existingPath: source.convertedPath
  });
  const wikiPath = await writeSourcePage(project, {
    analysis,
    sourcePath: source.relativePath,
    sourceId: source.id,
    sha256: source.sha256,
    kind: extracted.kind,
    excerpt,
    convertedPath,
    assets: extracted.assets,
    warnings: extracted.warnings,
    wikiPath: source.wikiPath
  });

  await upsertConceptPages(project, analysis.concepts, wikiPath, analysis.title, analysis.summary);
  await upsertEntityPages(project, analysis.entities, wikiPath, analysis.title, analysis.summary);
  return {
    sourcePatch: {
      title: analysis.title,
      summary: analysis.summary,
      wikiPath,
      convertedPath,
      kind: extracted.kind,
      status: "ready",
      updatedAt: nowIso(),
      error: undefined
    },
    logEntry: `摄入 \`${source.relativePath}\` -> [[${analysis.title}]]`
  };
}

async function registerSourcesBulk(project: Project, relativePaths: string[]): Promise<Omit<BulkImportResult, "archives">> {
  const timestamp = nowIso();
  const candidates: Array<{ normalized: string; size: number; sha256: string }> = [];

  for (const relativePath of [...new Set(relativePaths.map(toPosix))]) {
    const normalized = relativePath.startsWith("raw/sources/") ? relativePath : `raw/sources/${relativePath}`;
    if (!isSupportedBulkSource(normalized)) continue;
    const fullPath = safeJoin(project.root, normalized);
    const stat = await fs.lstat(fullPath);
    if (!stat.isFile()) continue;
    candidates.push({
      normalized,
      size: stat.size,
      sha256: await hashFile(fullPath)
    });
  }

  return withProjectLock(project.id, async () => {
    const sources = await readSources(project);
    const queue = await readQueue(project);
    const sourceMap = new Map(sources.map((source) => [source.relativePath, source]));
    const nextSources = [...sources];
    const imported: SourceRecord[] = [];
    let queued = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      const existing = sourceMap.get(candidate.normalized);
      if (existing && existing.sha256 === candidate.sha256 && existing.status === "ready" && existing.convertedPath) {
        imported.push(existing);
        skipped += 1;
        continue;
      }

      const sourceValue: SourceRecord = existing
        ? {
            ...existing,
            sha256: candidate.sha256,
            size: candidate.size,
            kind: sourceKind(candidate.normalized),
            status: "queued",
            updatedAt: timestamp,
            error: undefined
          }
        : {
            id: idFrom(candidate.normalized),
            fileName: path.basename(candidate.normalized),
            relativePath: candidate.normalized,
            kind: sourceKind(candidate.normalized),
            size: candidate.size,
            sha256: candidate.sha256,
            importedAt: timestamp,
            updatedAt: timestamp,
            status: "queued"
          };

      if (existing) {
        const index = nextSources.findIndex((source) => source.id === sourceValue.id);
        nextSources[index] = sourceValue;
      } else {
        nextSources.push(sourceValue);
      }
      sourceMap.set(sourceValue.relativePath, sourceValue);
      imported.push(sourceValue);

      const hasActiveItem = queue.some(
        (item) => item.sourceId === sourceValue.id && (item.status === "queued" || item.status === "running")
      );
      if (!hasActiveItem) {
        queue.push({
          id: idFrom(`${sourceValue.id}-${sourceValue.sha256}-${Date.now()}-${queue.length}`),
          sourceId: sourceValue.id,
          relativePath: sourceValue.relativePath,
          status: "queued",
          createdAt: timestamp,
          updatedAt: timestamp
        });
        queued += 1;
      }
    }

    await writeSources(project, nextSources);
    await writeQueue(project, queue);
    return {
      sources: imported,
      total: candidates.length,
      queued,
      skipped
    };
  });
}

async function extractUploadedArchive(
  project: Project,
  file: Express.Multer.File,
  originalName = normalizeUploadedFileName(file.originalname)
): Promise<{ fileName: string; extracted: number; directory: string; extractedFiles: string[] }> {
  const ext = path.extname(originalName).toLowerCase();
  if (ext !== ".zip") throw Object.assign(new Error(`Unsupported archive: ${originalName}`), { status: 400 });

  const base = slugify(path.basename(originalName, ext), "archive");
  const directory = `raw/sources/imports/${base}-${Date.now().toString(36)}`;
  const destination = safeJoin(project.root, directory);
  await fs.mkdir(destination, { recursive: true });

  try {
    await unzipArchive(file.path, destination);
    const extractedFiles = (await listFiles(destination)).filter((relative) => isSupportedBulkSource(relative));
    return { fileName: originalName, extracted: extractedFiles.length, directory, extractedFiles };
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(file.path, { force: true });
  }
}

async function unzipArchive(zipPath: string, destination: string): Promise<void> {
  const zip = new AdmZip(zipPath);
  const resolvedDestination = path.resolve(destination);
  const usedRelativePaths = new Set<string>();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const entryName = resolveArchiveEntryName(entry);
    if (isUnsafeZipEntry(entryName)) {
      throw Object.assign(new Error(`Zip contains unsafe path: ${entryName}`), { status: 400 });
    }
    const normalized = uniqueArchiveRelativePath(sanitizeArchiveRelativePath(entryName), usedRelativePaths);
    if (!normalized) continue;
    const target = path.resolve(destination, normalized);
    if (target !== resolvedDestination && !target.startsWith(`${resolvedDestination}${path.sep}`)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.getData());
  }
}

async function uniqueRawPath(project: Project, requested: string): Promise<string> {
  const normalized = toPosix(requested).replace(/^raw\/sources\//, "");
  const parsed = path.posix.parse(normalized);
  const base = slugify(parsed.name || "source");
  const ext = parsed.ext || ".txt";
  const dir = parsed.dir ? `${parsed.dir}/` : "";
  let candidate = `raw/sources/${dir}${base}${ext}`;
  let index = 2;
  while (true) {
    try {
      await fs.access(safeJoin(project.root, candidate));
      candidate = `raw/sources/${dir}${base}-${index++}${ext}`;
    } catch {
      return candidate;
    }
  }
}

async function flushQueueProgress(
  project: Project,
  queuePatches: Map<string, Partial<QueueItem>>,
  sourcePatches: Map<string, Partial<SourceRecord>>
): Promise<void> {
  if (!queuePatches.size && !sourcePatches.size) return;

  await withProjectLock(project.id, async () => {
    if (queuePatches.size) {
      const queue = await readQueue(project);
      await writeQueue(
        project,
        queue.map((item) => {
          const patch = queuePatches.get(item.id);
          return patch ? { ...item, ...patch } : item;
        })
      );
    }

    if (sourcePatches.size) {
      const sources = await readSources(project);
      await writeSources(
        project,
        sources.map((source) => {
          const patch = sourcePatches.get(source.id);
          return patch ? { ...source, ...patch } : source;
        })
      );
    }
  });
}

function isUnsafeZipEntry(entry: string): boolean {
  const normalized = toPosix(decodeZipUnicodeEscapes(entry));
  return (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  );
}

function isSupportedBulkSource(relativePath: string): boolean {
  return BULK_SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function resolveArchiveEntryName(entry: AdmZip.IZipEntry): string {
  const raw = entry.rawEntryName;
  const decodedEntryName = decodeZipUnicodeEscapes(entry.entryName);
  if (!raw?.length) return decodedEntryName;

  const utf8Name = decodeZipUnicodeEscapes(raw.toString("utf8"));
  const repairedUtf8Name = repairLatin1Utf8Mojibake(utf8Name);
  const gbkName = decodeZipUnicodeEscapes(iconv.decode(raw, "gbk"));
  const candidates = [repairedUtf8Name, decodedEntryName, utf8Name, gbkName];
  const utf8Flagged = (entry.header.flags & zipUtf8FileNameFlag) !== 0;

  if (utf8Flagged && !looksBrokenFileName(repairedUtf8Name)) return repairedUtf8Name;
  if (looksBrokenFileName(repairedUtf8Name) && !looksBrokenFileName(gbkName)) return gbkName;

  return candidates.reduce((best, candidate) => {
    const bestScore = scoreFileName(best);
    const candidateScore = scoreFileName(candidate);
    return candidateScore > bestScore ? candidate : best;
  }, repairedUtf8Name);
}

function sanitizeArchiveRelativePath(entryName: string): string {
  return decodeZipUnicodeEscapes(toPosix(entryName))
    .split("/")
    .map((segment) => sanitizeArchivePathSegment(segment))
    .filter(Boolean)
    .join("/");
}

function uniqueArchiveRelativePath(relativePath: string, used: Set<string>): string {
  const parsed = path.posix.parse(relativePath);
  const directory = parsed.dir
    ? `${parsed.dir
        .split("/")
        .map((segment) => shortenPathSegment(segment, maxArchivePathSegmentBytes))
        .filter(Boolean)
        .join("/")}/`
    : "";
  const base = parsed.name || "file";
  const ext = parsed.ext;
  let candidate = `${directory}${shortenArchiveFileName(base, ext)}`;
  let index = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${directory}${shortenArchiveFileName(base, ext, `-${index++}`)}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function decodeZipUnicodeEscapes(value: string): string {
  return value.replace(/#U([0-9a-fA-F]{4,6})/g, (_match, hex: string) => {
    const codePoint = Number.parseInt(hex, 16);
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return _match;
    return String.fromCodePoint(codePoint);
  });
}

function sanitizeArchivePathSegment(segment: string): string {
  return segment.replace(/[<>:"|?*\x00-\x1F]/g, "_").trim();
}

function shortenArchiveFileName(base: string, ext: string, suffix = ""): string {
  const safeBase = base || "file";
  const safeExt = shortenArchiveExtension(ext);
  const candidate = `${safeBase}${suffix}${safeExt}`;
  if (Buffer.byteLength(candidate, "utf8") <= maxArchivePathSegmentBytes) return candidate;

  const hash = crypto.createHash("sha256").update(`${safeBase}${safeExt}`).digest("hex").slice(0, 8);
  const trailer = `-${hash}${suffix}${safeExt}`;
  const budget = Math.max(0, maxArchivePathSegmentBytes - Buffer.byteLength(trailer, "utf8"));
  const shortened = `${truncateUtf8(safeBase, budget)}${trailer}`;
  return truncateUtf8(shortened, maxArchivePathSegmentBytes);
}

function shortenArchiveExtension(ext: string): string {
  const safe = ext.replace(/[<>:"|?*\x00-\x1F]/g, "");
  const limit = Math.max(0, Math.min(48, maxArchivePathSegmentBytes - 16));
  if (!safe || Buffer.byteLength(safe, "utf8") <= limit) return safe;
  if (limit <= 1) return "";
  const hash = crypto.createHash("sha256").update(safe).digest("hex").slice(0, 8);
  const trailer = `-${hash}`;
  const budget = Math.max(0, limit - Buffer.byteLength(trailer, "utf8"));
  return `${truncateUtf8(safe, budget)}${trailer}`;
}

function shortenPathSegment(segment: string, maxBytes: number): string {
  const safe = segment || "file";
  if (Buffer.byteLength(safe, "utf8") <= maxBytes) return safe;
  const hash = crypto.createHash("sha256").update(safe).digest("hex").slice(0, 8);
  const trailer = `-${hash}`;
  const budget = Math.max(12, maxBytes - Buffer.byteLength(trailer, "utf8"));
  return `${truncateUtf8(safe, budget)}${trailer}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let output = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    output += char;
    bytes += charBytes;
  }
  return output || value.slice(0, 1);
}

function normalizeUploadedFileName(name: string): string {
  const normalized = toPosix(name).split("/").filter(Boolean).pop() || "source";
  const repaired = repairLatin1Utf8Mojibake(normalized);
  return sanitizeFileName(repaired || normalized);
}

function repairLatin1Utf8Mojibake(value: string): string {
  if (!/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝßà-ÿ]/.test(value)) return value;
  const repaired = Buffer.from(value, "latin1").toString("utf8");
  if (scoreFileName(repaired) > scoreFileName(value)) return repaired;
  return value;
}

function looksBrokenFileName(value: string): boolean {
  return /\uFFFD/.test(value) || /锟斤拷/.test(value);
}

function scoreFileName(value: string): number {
  const han = [...value.matchAll(/\p{Script=Han}/gu)].length;
  const replacement = [...value.matchAll(/\uFFFD/g)].length;
  const mojibake = [...value.matchAll(/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝ]/g)].length;
  const corrupted = [...value.matchAll(/锟斤拷/g)].length;
  const legalTerms = [...value.matchAll(/人民|政府|法院|条例|规定|办法|决定|法律|法规|管理|实施|委员会|代表大会/gu)].length;
  return han * 4 + legalTerms * 10 - replacement * 20 - corrupted * 20 - mojibake * 3;
}

function sanitizeFileName(name: string): string {
  const parsed = path.posix.parse(toPosix(name));
  const base = readableTextOrFallback(parsed.name || "source", "source")
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .trim() || "source";
  const ext = parsed.ext.replace(/[<>:"|?*\x00-\x1F]/g, "");
  return `${isUnknownGlyphText(base) ? "source" : base}${ext || ".txt"}`;
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function withProjectLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  projectLocks.set(projectId, chained);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (projectLocks.get(projectId) === chained) {
      projectLocks.delete(projectId);
    }
  }
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
