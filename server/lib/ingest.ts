import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isUtf8 } from "node:buffer";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import {
  ArchiveImportProgress,
  IngestProgress,
  Project,
  QueueItem,
  QueueStats,
  SourceRecord,
  SourceStats
} from "../types.js";
import { extractDocument, sourceKind } from "./extract.js";
import { analyzeOffline, analyzeWithModel, hasLiveModel } from "./llm.js";
import { firstParagraph, isUnknownGlyphText, normalizeText, readableTextOrFallback } from "./text.js";
import { idFrom, slugify } from "./slug.js";
import { nowIso } from "./time.js";
import { withResourceLock } from "./locks.js";
import {
  listFiles,
  readText,
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
import { parseMarkdown } from "./markdown.js";
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
const queueRuns = new Map<string, Promise<void>>();
const queueRunRequested = new Set<string>();
const projectLocks = new Map<string, Promise<void>>();
const archiveProgressByProject = new Map<string, Map<string, ArchiveImportProgress>>();
const archiveProgressRetentionMs = 5 * 60 * 1000;
const maxArchivePathSegmentBytes = readPositiveInteger("LLM_WIKI_MAX_ARCHIVE_PATH_SEGMENT_BYTES", 180);
const maxArchiveEntries = readPositiveInteger("LLM_WIKI_MAX_ARCHIVE_ENTRIES", 100000);
const maxArchiveFileBytes = readPositiveInteger("LLM_WIKI_MAX_ARCHIVE_FILE_SIZE_MB", 256) * 1024 * 1024;
const maxArchiveBytes = readPositiveInteger("LLM_WIKI_MAX_ARCHIVE_SIZE_MB", 10240) * 1024 * 1024;
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
  assertSupportedUploadName(safeName);
  const destinationRelative = await withResourceLock(`${project.root}:source-files`, async () => {
    const relative = await uniqueRawPath(project, safeName);
    const destination = safeJoin(project.root, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(file.path, destination);
    return relative;
  });
  const result = await registerSourcesBulk(project, [destinationRelative]);
  if (result.queued > 0) processProjectQueue(project).catch((error) => console.error("[ingest] queue failed", error));
  return result.sources[0];
}

export async function importUploadedSources(project: Project, files: Express.Multer.File[]): Promise<BulkImportResult> {
  if (!files.length) throw Object.assign(new Error("请选择需要上传的文件。"), { status: 400 });
  for (const file of files) assertSupportedUploadName(file.originalname);
  const relativePaths: string[] = [];
  const archives: BulkImportResult["archives"] = [];
  const archiveProgressIds: Array<{ id: string; extracted: number }> = [];

  for (const file of files) {
    const originalName = normalizeUploadedFileName(file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    if (ARCHIVE_EXTENSIONS.has(ext)) {
      const progressId = startArchiveProgress(project, originalName);
      const archive = await extractUploadedArchive(project, file, originalName, progressId);
      updateArchiveProgress(project, progressId, {
        status: "registering",
        directory: archive.directory,
        extractedFiles: archive.extracted,
        detail: `已解包 ${archive.extracted} 个可摄入文件，正在登记队列。`
      });
      archives.push({
        fileName: archive.fileName,
        extracted: archive.extracted,
        directory: archive.directory
      });
      archiveProgressIds.push({ id: progressId, extracted: archive.extracted });
      relativePaths.push(...archive.extractedFiles.map((item) => toPosix(path.posix.join(archive.directory, item))));
      continue;
    }

    const destinationRelative = await withResourceLock(`${project.root}:source-files`, async () => {
      const relative = await uniqueRawPath(project, originalName);
      const destination = safeJoin(project.root, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(file.path, destination);
      return relative;
    });
    relativePaths.push(destinationRelative);
  }

  let result: Omit<BulkImportResult, "archives">;
  try {
    result = await registerSourcesBulk(project, relativePaths);
  } catch (error) {
    for (const archive of archiveProgressIds) {
      updateArchiveProgress(project, archive.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        detail: "ZIP 已解包，但登记到摄入队列失败。"
      });
    }
    throw error;
  }
  for (const archive of archiveProgressIds) {
    updateArchiveProgress(project, archive.id, {
      status: "done",
      queued: result.queued,
      skipped: result.skipped,
      detail: `解包完成：${archive.extracted} 个文件，${result.queued} 个入队，${result.skipped} 个跳过。`
    });
  }
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
  let content = input.content.replace(/\r\n?/g, "\n").trim();
  const heading = content.match(/^#\s+([^\n]+)\n*/);
  if (heading?.[1].trim() === title) content = content.slice(heading[0].length);
  const body = [`# ${title}`, input.url ? `URL: ${input.url}` : "", content].filter(Boolean).join("\n\n");
  const relative = await withResourceLock(`${project.root}:source-files`, async () => {
    const candidate = await uniqueRawPath(project, `web-clips/${slugify(title)}.md`);
    await writeText(safeJoin(project.root, candidate), body);
    return candidate;
  });
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
  queueStats: QueueStats;
  sourceStats: SourceStats;
  ingestProgress: IngestProgress;
  archiveProgress: ArchiveImportProgress[];
}> {
  const [queue, sources] = await Promise.all([readQueue(project), readSources(project)]);
  if (queue.some((item) => item.status === "queued" || item.status === "running")) {
    processProjectQueue(project).catch((error) => console.error("[activity] queue resume failed", error));
  }
  const sourceLimit = normalizeLimit(options.sourceLimit, 500);
  const queueLimit = normalizeLimit(options.queueLimit, 500);
  const visibleQueue = selectQueueActivity(queue, queueLimit);
  const visibleSources = selectRecentWithActive(sources, sourceLimit);
  return {
    queue: visibleQueue,
    sources: options.compact ? visibleSources.map(compactSourceRecord) : visibleSources,
    queueTotal: queue.length,
    sourceTotal: sources.length,
    sourceBytesTotal: sources.reduce((sum, source) => sum + source.size, 0),
    queueStats: countQueueStats(queue),
    sourceStats: countSourceStats(sources),
    ingestProgress: buildIngestProgress(queue, sources),
    archiveProgress: activeArchiveProgress(project)
  };
}

function startArchiveProgress(project: Project, fileName: string): string {
  const timestamp = nowIso();
  const id = idFrom(`${project.id}-${fileName}-${timestamp}-${Math.random().toString(36).slice(2)}`);
  updateArchiveProgress(project, id, {
    id,
    fileName,
    status: "extracting",
    totalEntries: 0,
    processedEntries: 0,
    extractedFiles: 0,
    queued: 0,
    skipped: 0,
    startedAt: timestamp,
    updatedAt: timestamp,
    detail: "等待开始解包。"
  });
  return id;
}

function updateArchiveProgress(
  project: Project,
  id: string,
  patch: Partial<ArchiveImportProgress>
): void {
  const currentProject = archiveProgressByProject.get(project.id) ?? new Map<string, ArchiveImportProgress>();
  archiveProgressByProject.set(project.id, currentProject);
  const current = currentProject.get(id);
  const timestamp = nowIso();
  if (!current) {
    currentProject.set(id, {
      id,
      fileName: "archive.zip",
      status: "extracting",
      totalEntries: 0,
      processedEntries: 0,
      extractedFiles: 0,
      queued: 0,
      skipped: 0,
      startedAt: timestamp,
      updatedAt: timestamp,
      ...patch
    } as ArchiveImportProgress);
    return;
  }
  currentProject.set(id, { ...current, ...patch, updatedAt: timestamp });
}

function activeArchiveProgress(project: Project): ArchiveImportProgress[] {
  const currentProject = archiveProgressByProject.get(project.id);
  if (!currentProject) return [];
  const cutoff = Date.now() - archiveProgressRetentionMs;
  for (const [id, progress] of currentProject) {
    const isActive = progress.status === "extracting" || progress.status === "registering";
    const updatedAt = Date.parse(progress.updatedAt);
    if (!isActive && Number.isFinite(updatedAt) && updatedAt < cutoff) {
      currentProject.delete(id);
    }
  }
  return [...currentProject.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
  const selectedKeys = new Set<string>();
  const active = items.filter((item) => isActiveActivityStatus(item.status)).slice(-limit);
  for (const item of active) selectedKeys.add(activityItemKey(item));
  for (let index = items.length - 1; index >= 0 && selectedKeys.size < limit; index -= 1) {
    selectedKeys.add(activityItemKey(items[index]));
  }
  return items.filter((item) => selectedKeys.has(activityItemKey(item)));
}

function selectQueueActivity(queue: QueueItem[], limit: number): QueueItem[] {
  if (queue.length <= limit) return queue;
  const selected = new Map<string, QueueItem>();
  const add = (item: QueueItem) => {
    if (selected.size < limit) selected.set(item.id, item);
  };

  for (const item of queue.filter((candidate) => candidate.status === "running")) add(item);
  for (const item of queue.filter((candidate) => candidate.status === "failed").slice(-Math.ceil(limit * 0.2)).reverse()) {
    add(item);
  }
  for (const item of queue.filter((candidate) => candidate.status === "done").slice(-Math.ceil(limit * 0.25)).reverse()) {
    add(item);
  }
  for (const item of queue.filter((candidate) => candidate.status === "queued")) add(item);

  return [...selected.values()].sort((a, b) => {
    const rank = queueDisplayRank(a.status) - queueDisplayRank(b.status);
    if (rank !== 0) return rank;
    if (a.status === "queued") return a.createdAt.localeCompare(b.createdAt);
    return (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt);
  });
}

function queueDisplayRank(status: QueueItem["status"]): number {
  return {
    running: 0,
    failed: 1,
    done: 2,
    queued: 3
  }[status];
}

function countQueueStats(queue: QueueItem[]): QueueStats {
  return queue.reduce<QueueStats>(
    (stats, item) => {
      stats[item.status] += 1;
      return stats;
    },
    { total: queue.length, queued: 0, running: 0, done: 0, failed: 0 }
  );
}

function countSourceStats(sources: SourceRecord[]): SourceStats {
  return sources.reduce<SourceStats>(
    (stats, source) => {
      stats[source.status] += 1;
      return stats;
    },
    { total: sources.length, queued: 0, ingesting: 0, ready: 0, skipped: 0, failed: 0 }
  );
}

function buildIngestProgress(queue: QueueItem[], sources: SourceRecord[]): IngestProgress {
  const stats = countQueueStats(queue);
  const processed = stats.done + stats.failed;
  const active = queue.find((item) => item.status === "running");
  const next = queue.find((item) => item.status === "queued");
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const current = active || next;
  const currentIndex = current ? Math.min(stats.total, processed + 1) : processed;
  const updatedAt = queue.reduce<string | undefined>((latest, item) => {
    if (!latest || item.updatedAt > latest) return item.updatedAt;
    return latest;
  }, undefined);

  return {
    total: stats.total,
    processed,
    queued: stats.queued,
    running: stats.running,
    done: stats.done,
    failed: stats.failed,
    percent: stats.total > 0 ? Math.floor((processed / stats.total) * 100) : 0,
    currentIndex,
    active: active ? toIngestProgressItem(active, sourceById.get(active.sourceId)) : undefined,
    next: next ? toIngestProgressItem(next, sourceById.get(next.sourceId)) : undefined,
    updatedAt
  };
}

function toIngestProgressItem(item: QueueItem, source?: SourceRecord) {
  return {
    id: item.id,
    sourceId: item.sourceId,
    relativePath: item.relativePath,
    fileName: source?.fileName || path.posix.basename(item.relativePath),
    title: source?.title,
    kind: source?.kind,
    size: source?.size,
    status: item.status,
    updatedAt: item.updatedAt,
    error: item.error
  };
}

function isActiveActivityStatus(status: string): boolean {
  return status === "queued" || status === "running" || status === "ingesting";
}

function activityItemKey(item: { id?: string; status: string; updatedAt?: string; createdAt?: string }): string {
  return item.id || `${item.status}-${item.updatedAt || item.createdAt || ""}-${JSON.stringify(item).slice(0, 120)}`;
}

export function processProjectQueue(project: Project): Promise<void> {
  const active = queueRuns.get(project.root);
  if (active) { queueRunRequested.add(project.root); return active; }
  const running = executeProjectQueue(project);
  queueRuns.set(project.root, running);
  return running;
}

async function executeProjectQueue(project: Project): Promise<void> {
  runningProjects.add(project.id);
  const failedModelConfigurations = new Set<string>();
  try {
    do {
      queueRunRequested.delete(project.root);
      let processed = 0;
      await prepareQueueForProcessing(project);
      while (true) {
        const queue = await readQueue(project);
        const activeItem = queue.find((candidate) => candidate.status === "queued" || candidate.status === "running");
        if (!activeItem) break;

        const sources = await readSources(project);
        const sourceById = new Map(sources.map((source) => [source.id, source]));
        const queuePatches = new Map<string, Partial<QueueItem>>();
        const sourcePatches = new Map<string, Partial<SourceRecord>>();
        const source = sourceById.get(activeItem.sourceId);

        if (!source) {
          queuePatches.set(activeItem.id, {
            status: "failed",
            updatedAt: nowIso(),
            error: `Source not found: ${activeItem.sourceId}`
          });
          await flushQueueProgress(project, queuePatches, sourcePatches);
          continue;
        }

        queuePatches.set(activeItem.id, { status: "running", updatedAt: nowIso(), error: undefined });
        sourcePatches.set(source.id, { status: "ingesting", updatedAt: nowIso(), error: undefined });
        await flushQueueProgress(project, queuePatches, sourcePatches);
        queuePatches.clear();
        sourcePatches.clear();

        try {
          const result = await ingestQueueItem(project, source, failedModelConfigurations);
          queuePatches.set(activeItem.id, { status: "done", updatedAt: nowIso(), error: undefined });
          sourcePatches.set(source.id, result.sourcePatch);
          await appendLog(project, result.logEntry);
          await flushQueueProgress(project, queuePatches, sourcePatches);
          queuePatches.clear();
          sourcePatches.clear();
          processed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const patch: Partial<SourceRecord> = { status: "failed", error: message, updatedAt: nowIso() };
          queuePatches.set(activeItem.id, { status: "failed", updatedAt: nowIso(), error: message });
          sourcePatches.set(source.id, patch);
          await flushQueueProgress(project, queuePatches, sourcePatches);
          queuePatches.clear();
          sourcePatches.clear();
        }

        await flushQueueProgress(project, queuePatches, sourcePatches);
      }
      if (processed > 0) {
        await updateOverview(project);
        await updateIndex(project);
        await touchProject(project);
      }
    } while (queueRunRequested.has(project.root));
  } finally {
    runningProjects.delete(project.id);
    queueRuns.delete(project.root);
    queueRunRequested.delete(project.root);
  }
}

async function prepareQueueForProcessing(project: Project): Promise<void> {
  await withProjectLock(project.id, async () => {
    const [sources, queue] = await Promise.all([readSources(project), readQueue(project)]);
    const now = nowIso();
    let queueChanged = false;
    let sourcesChanged = false;
    const activeSourceIds = new Set(
      queue
        .filter((item) => item.status === "queued" || item.status === "running")
        .map((item) => item.sourceId)
    );
    const nextQueue = queue.map((item) => {
      if (item.status !== "running") return item;
      queueChanged = true;
      return { ...item, status: "queued" as const, updatedAt: now, error: undefined };
    });
    const nextSources = sources.map((source) => {
      if (source.status !== "ingesting" || !activeSourceIds.has(source.id)) return source;
      sourcesChanged = true;
      return { ...source, status: "queued" as const, updatedAt: now, error: undefined };
    });
    if (queueChanged) await writeQueue(project, nextQueue);
    if (sourcesChanged) await writeSources(project, nextSources);
  });
}

export async function repairProjectActivity(project: Project): Promise<{ repaired: number; reset: number }> {
  return withProjectLock(project.id, async () => {
    const [sources, queue] = await Promise.all([readSources(project), readQueue(project)]);
    const now = nowIso();
    const repairedSourceIds = new Set<string>();
    const sourcePatches = new Map<string, Partial<SourceRecord>>();

    for (const source of sources) {
      if (source.status === "ready" || !source.wikiPath) continue;
      if (await generatedSourcePageMatches(project, source)) {
        sourcePatches.set(source.id, { status: "ready", updatedAt: now, error: undefined });
        repairedSourceIds.add(source.id);
      }
    }

    let reset = 0;
    const nextQueue = queue.map((item) => {
      if (repairedSourceIds.has(item.sourceId) && item.status !== "done") {
        return { ...item, status: "done" as const, updatedAt: now, error: undefined };
      }
      if (item.status === "running") {
        reset += 1;
        return { ...item, status: "queued" as const, updatedAt: now, error: undefined };
      }
      return item;
    });

    for (const item of queue) {
      if (item.status === "running" && !repairedSourceIds.has(item.sourceId)) {
        sourcePatches.set(item.sourceId, { status: "queued", updatedAt: now, error: undefined });
      }
    }

    if (sourcePatches.size) {
      await writeSources(
        project,
        sources.map((source) => {
          const patch = sourcePatches.get(source.id);
          return patch ? { ...source, ...patch } : source;
        })
      );
    }
    if (repairedSourceIds.size || reset) {
      await writeQueue(project, nextQueue);
    }

    return { repaired: repairedSourceIds.size, reset };
  });
}

async function generatedSourcePageMatches(project: Project, source: SourceRecord): Promise<boolean> {
  if (!source.wikiPath) return false;
  try {
    const parsed = parseMarkdown(await readText(safeJoin(project.root, source.wikiPath)));
    return (
      parsed.frontmatter.source_id === source.id &&
      parsed.frontmatter.source_path === source.relativePath &&
      parsed.frontmatter.source_sha256 === source.sha256
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
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
  source: SourceRecord,
  failedModelConfigurations: Set<string>
): Promise<{ sourcePatch: Partial<SourceRecord>; logEntry: string }> {
  const fullPath = safeJoin(project.root, source.relativePath);
  const assetRelativeDir = `raw/assets/${source.id}`;
  const extracted = await extractDocument(fullPath, {
    assetDir: safeJoin(project.root, assetRelativeDir),
    assetRelativeDir,
    assetUrl: (relativePath) => `/api/v1/projects/${project.id}/assets?path=${encodeURIComponent(relativePath)}`
  });
  if (extracted.metadataOnly) throw new Error(extracted.warnings.join(" ") || "文件未能提取正文，不能生成知识库内容。");
  const text = extracted.text || `${source.fileName}\n无可抽取文本。`;
  const settings = await readSettings(project);
  const modelConfiguration = JSON.stringify([settings.provider, settings.baseUrl, settings.model, settings.apiKey, settings.systemPrompt]);
  const modelConfigured = hasLiveModel(settings);
  const modelAnalysis = modelConfigured && !failedModelConfigurations.has(modelConfiguration)
    ? await analyzeWithModel(settings, extracted.title, text)
    : null;
  if (modelConfigured && !modelAnalysis) failedModelConfigurations.add(modelConfiguration);
  // A failed model must not impose the same timeout on every remaining document.
  // A new queue run or a changed configuration can attempt model analysis again.
  const analysis = modelAnalysis ?? analyzeOffline(extracted.title, text);
  const warnings = modelConfigured && !modelAnalysis
    ? [...extracted.warnings, "模型摘要未生成，已使用离线规则。本轮队列中相同配置的模型分析已暂停，可在批次结束或修改模型配置后重新尝试。"]
    : extracted.warnings;
  const excerpt = firstParagraph(text, 1200);
  const convertedPath = await writeConvertedSourcePage(project, {
    title: extracted.title,
    sourcePath: source.relativePath,
    sourceId: source.id,
    sha256: source.sha256,
    kind: extracted.kind,
    markdown: extracted.markdown,
    assets: extracted.assets,
    warnings,
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
    warnings,
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
    const sourceIndexById = new Map(sources.map((source, index) => [source.id, index]));
    const activeSourceIds = new Set(queue.filter((item) => item.status === "queued" || item.status === "running").map((item) => item.sourceId));
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
        const index = sourceIndexById.get(sourceValue.id)!;
        nextSources[index] = sourceValue;
      } else {
        sourceIndexById.set(sourceValue.id, nextSources.length);
        nextSources.push(sourceValue);
      }
      sourceMap.set(sourceValue.relativePath, sourceValue);
      imported.push(sourceValue);

      if (!activeSourceIds.has(sourceValue.id)) {
        queue.push({
          id: idFrom(`${sourceValue.id}-${sourceValue.sha256}-${Date.now()}-${queue.length}`),
          sourceId: sourceValue.id,
          relativePath: sourceValue.relativePath,
          status: "queued",
          createdAt: timestamp,
          updatedAt: timestamp
        });
        activeSourceIds.add(sourceValue.id);
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
  originalName = normalizeUploadedFileName(file.originalname),
  progressId?: string
): Promise<{ fileName: string; extracted: number; directory: string; extractedFiles: string[] }> {
  const ext = path.extname(originalName).toLowerCase();
  if (ext !== ".zip") throw Object.assign(new Error(`Unsupported archive: ${originalName}`), { status: 400 });

  const base = slugify(path.basename(originalName, ext), "archive");
  const directory = `raw/sources/imports/${base}-${crypto.randomUUID()}`;
  const destination = safeJoin(project.root, directory);
  await fs.mkdir(destination, { recursive: true });

  try {
    if (progressId) {
      updateArchiveProgress(project, progressId, {
        status: "extracting",
        directory,
        detail: `正在解包到 ${directory}。`
      });
    }
    await unzipArchive(file.path, destination, (progress) => {
      if (!progressId) return;
      updateArchiveProgress(project, progressId, {
        status: "extracting",
        totalEntries: progress.totalEntries,
        processedEntries: progress.processedEntries,
        extractedFiles: progress.extractedFiles,
        currentEntry: progress.currentEntry,
        detail: archiveProgressDetail(progress)
      });
    });
    const extractedFiles = (await listFiles(destination)).filter((relative) => isSupportedBulkSource(relative));
    if (!extractedFiles.length) {
      throw Object.assign(new Error("ZIP 中没有可摄入的文件，请放入受支持的文档后重新上传。"), { status: 400 });
    }
    return { fileName: originalName, extracted: extractedFiles.length, directory, extractedFiles };
  } catch (error) {
    if (progressId) {
      updateArchiveProgress(project, progressId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        detail: "ZIP 解包失败。"
      });
    }
    await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await fs.rm(file.path, { force: true });
  }
}

async function unzipArchive(
  zipPath: string,
  destination: string,
  onProgress?: (progress: { totalEntries: number; processedEntries: number; extractedFiles: number; currentEntry?: string }) => void
): Promise<void> {
  // Use a reversible byte representation for adm-zip's internal entry keys.
  // Its default UTF-8 decoder collapses different legacy GBK names to the same
  // replacement characters before resolveArchiveEntryName can decode them.
  const zipOptions = {
    noSort: true,
    decoder: {
      encode: (name: string) => Buffer.from(name, "latin1"),
      decode: (name: Buffer) => name.toString("latin1"),
      efs: false
    }
  };
  const zip = new AdmZip(zipPath, zipOptions);
  const resolvedDestination = path.resolve(destination);
  const usedRelativePaths = new Set<string>();
  let entries: AdmZip.IZipEntry[];
  try {
    entries = zip.getEntries();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ADM-ZIP: Duplicate entry name")) {
      throw Object.assign(new Error("ZIP 包含完全相同的重复条目，请先去重后重新压缩。"), { status: 400 });
    }
    throw error;
  }
  let processedEntries = 0;
  let extractedFiles = 0;
  if (entries.length > maxArchiveEntries) throw Object.assign(new Error(`ZIP 条目超过限制：${maxArchiveEntries}。`), { status: 413 });
  let declaredBytes = 0;
  for (const entry of entries) {
    const size = entry.header.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > maxArchiveFileBytes) throw Object.assign(new Error(`ZIP 单文件解包大小超过限制：${maxArchiveFileBytes / 1024 / 1024} MB。`), { status: 413 });
    declaredBytes += size;
    if (declaredBytes > maxArchiveBytes) throw Object.assign(new Error(`ZIP 解包总大小超过限制：${maxArchiveBytes / 1024 / 1024} MB。`), { status: 413 });
  }
  let extractedBytes = 0;
  onProgress?.({ totalEntries: entries.length, processedEntries, extractedFiles });
  for (const entry of entries) {
    processedEntries += 1;
    if (entry.isDirectory) {
      onProgress?.({ totalEntries: entries.length, processedEntries, extractedFiles });
      continue;
    }
    const entryName = resolveArchiveEntryName(entry);
    if (isUnsafeZipEntry(entryName)) {
      throw Object.assign(new Error(`Zip contains unsafe path: ${entryName}`), { status: 400 });
    }
    if (!isSupportedBulkSource(entryName)) {
      onProgress?.({ totalEntries: entries.length, processedEntries, extractedFiles, currentEntry: entryName });
      continue;
    }
    const normalized = uniqueArchiveRelativePath(sanitizeArchiveRelativePath(entryName), usedRelativePaths);
    if (!normalized) continue;
    const target = path.resolve(destination, normalized);
    if (target !== resolvedDestination && !target.startsWith(`${resolvedDestination}${path.sep}`)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    const data = entry.getData();
    extractedBytes += data.length;
    if (data.length !== entry.header.size || data.length > maxArchiveFileBytes || extractedBytes > maxArchiveBytes) throw Object.assign(new Error("ZIP 实际解包大小异常或超过限制。"), { status: 413 });
    await fs.writeFile(target, data);
    extractedFiles += 1;
    onProgress?.({ totalEntries: entries.length, processedEntries, extractedFiles, currentEntry: entryName });
  }
}

function archiveProgressDetail(progress: {
  totalEntries: number;
  processedEntries: number;
  extractedFiles: number;
  currentEntry?: string;
}): string {
  const entry = progress.currentEntry ? `，当前：${truncateProgressText(progress.currentEntry, 120)}` : "";
  return `正在解包 ${progress.processedEntries} / ${progress.totalEntries} 个条目${entry}。`;
}

function truncateProgressText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
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

export function assertSupportedUploadName(fileName: string): void {
  if (!isSupportedBulkSource(fileName) && path.extname(fileName).toLowerCase() !== ".zip") throw Object.assign(new Error("不支持此文件格式，请上传文档、文本、图片或 ZIP。"), { status: 400 });
}

function resolveArchiveEntryName(entry: AdmZip.IZipEntry): string {
  const raw = entry.rawEntryName;
  const decodedEntryName = decodeZipUnicodeEscapes(entry.entryName);
  if (!raw?.length) return decodedEntryName;

  const utf8Name = decodeZipUnicodeEscapes(raw.toString("utf8"));
  const repairedUtf8Name = repairLatin1Utf8Mojibake(utf8Name);
  const gbkName = decodeZipUnicodeEscapes(iconv.decode(raw, "gb18030"));
  // UTF-8 names remain UTF-8 even when an older archiver omitted the flag.
  if (isUtf8(raw)) return repairedUtf8Name;
  const candidates = [repairedUtf8Name, utf8Name, gbkName];
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
  return /\uFFFD/.test(value) || /\u951f\u65a4\u62f7/.test(value);
}

function scoreFileName(value: string): number {
  const han = [...value.matchAll(/\p{Script=Han}/gu)].length;
  const replacement = [...value.matchAll(/\uFFFD/g)].length;
  const mojibake = [...value.matchAll(/[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝ]/g)].length;
  const corrupted = [...value.matchAll(/\u951f\u65a4\u62f7/g)].length;
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

export function isProjectQueueRunning(projectId: string): boolean { return runningProjects.has(projectId); }

export async function withProjectLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
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
