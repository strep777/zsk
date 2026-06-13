import fs from "node:fs/promises";
import { createWriteStream, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import express, { NextFunction, Request, Response, Router } from "express";
import multer from "multer";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createProject,
  getProject,
  listFiles,
  listProjects,
  projectRoot,
  publicProject,
  readQueue,
  readSettings,
  readSources,
  readText,
  safeJoin,
  toPosix,
  writeQueue,
  writeSources,
  writeSettings
} from "./lib/storage.js";
import {
  getActivity,
  importUploadedSources,
  importWebClip,
  processProjectQueue,
  recordFailedUploadedSources,
  rescanSources
} from "./lib/ingest.js";
import { listWikiFilesPage, readWikiFile, writeWikiFile } from "./lib/wiki.js";
import { answerQuestion, listChats, saveLatestChatAnswer, searchProject } from "./lib/search.js";
import { buildKnowledgeGraph } from "./lib/graph.js";
import { lintProject } from "./lib/lint.js";
import { runResearch } from "./lib/research.js";
import { isUnknownGlyphText, readableTextOrFallback } from "./lib/text.js";
import { nowIso } from "./lib/time.js";
import { Project, SourceRecord } from "./types.js";

const maxUploadFiles = readPositiveInteger("LLM_WIKI_MAX_UPLOAD_FILES", 30000);
const maxUploadSizeMb = readPositiveInteger("LLM_WIKI_MAX_UPLOAD_SIZE_MB", 10240);
const maxUploadChunkMb = readPositiveInteger("LLM_WIKI_UPLOAD_CHUNK_MB", 8);
const maxUploadChunks = readPositiveInteger("LLM_WIKI_MAX_UPLOAD_CHUNKS", 1000000);
const maxUploadChunkBytes = maxUploadChunkMb * 1024 * 1024;
const defaultRawListLimit = readPositiveInteger("LLM_WIKI_RAW_LIST_LIMIT", 500);
const defaultRawTreeLimit = readPositiveInteger("LLM_WIKI_RAW_TREE_LIMIT", 5000);
const maxUploadPathSegmentBytes = 240;
const maxUploadTokenBytes = 48;
const maxUploadFileNameBytes = Math.min(
  readPositiveInteger("LLM_WIKI_MAX_UPLOAD_FILE_NAME_BYTES", 180),
  maxUploadPathSegmentBytes - maxUploadTokenBytes - 1,
  maxUploadPathSegmentBytes - Buffer.byteLength("payload-", "utf8")
);

export function createApiRouter(): Router {
  const router = Router();
  mkdirSync(path.join(projectRoot("_tmp"), "uploads"), { recursive: true });
  const upload = multer({
    dest: path.join(projectRoot("_tmp"), "uploads"),
    limits: {
      fileSize: maxUploadSizeMb * 1024 * 1024,
      files: maxUploadFiles
    }
  });

  router.get("/health", (_req, res) => {
    res.json({ ok: true, time: nowIso(), version: "0.1.0" });
  });

  router.get("/projects", asyncHandler(async (_req, res) => {
    res.json({ projects: (await listProjects()).map(publicProject) });
  }));

  router.post("/projects", asyncHandler(async (req, res) => {
    const project = await createProject({
      name: String(req.body?.name || "新知识库"),
      description: String(req.body?.description || "")
    });
    res.status(201).json({ project: publicProject(project) });
  }));

  router.get("/projects/:projectId/files", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const scope = String(req.query.scope || "wiki");
    if (scope === "wiki") {
      const page = await listWikiFilesPage(project, {
        limit: readOptionalQueryInteger(req.query.limit),
        offset: readOptionalQueryInteger(req.query.offset) ?? 0,
        query: req.query.query ? String(req.query.query) : undefined,
        includeTotal: true
      });
      res.json(page);
      return;
    }
    if (scope === "raw") {
      const sources = await readSources(project);
      const limit = readOptionalQueryInteger(req.query.limit) ?? defaultRawListLimit;
      const offset = readOptionalQueryInteger(req.query.offset) ?? 0;
      const query = req.query.query ? String(req.query.query) : undefined;
      const compact = String(req.query.compact || "") === "1";
      res.json(selectSourcePage(sources, { limit, offset, query, compact }));
      return;
    }
    const limit = readOptionalQueryInteger(req.query.limit) ?? defaultRawListLimit;
    const compact = String(req.query.compact || "") === "1";
    const [wiki, raw] = await Promise.all([
      listWikiFilesPage(project, { limit, includeTotal: true }),
      readSources(project)
    ]);
    res.json({
      wiki: wiki.files,
      raw: selectRecentSources(raw, limit, compact),
      wikiTotal: wiki.total,
      rawTotal: raw.length,
      limit
    });
  }));

  router.get("/projects/:projectId/files/content", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const relativePath = String(req.query.path || "");
    if (!relativePath) throw Object.assign(new Error("Missing path"), { status: 400 });
    if (relativePath.startsWith("wiki/") || ["purpose.md", "schema.md"].includes(relativePath)) {
      res.json({ path: relativePath, content: await readWikiFile(project, relativePath) });
      return;
    }
    if (relativePath.startsWith("raw/sources/")) {
      res.json({ path: relativePath, content: await readText(safeJoin(project.root, relativePath)) });
      return;
    }
    throw Object.assign(new Error("Unsupported file path"), { status: 400 });
  }));

  router.get("/projects/:projectId/assets", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const relativePath = toPosix(String(req.query.path || ""));
    if (!relativePath.startsWith("raw/assets/")) {
      throw Object.assign(new Error("Only extracted assets can be served."), { status: 400 });
    }
    res.sendFile(safeJoin(project.root, relativePath));
  }));

  router.put("/projects/:projectId/files/content", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    await writeWikiFile(project, String(req.body.path), String(req.body.content ?? ""));
    res.json({ ok: true });
  }));

  router.post(
    "/projects/:projectId/sources/upload",
    upload.array("files", maxUploadFiles),
    asyncHandler(async (req, res) => {
      const project = await getProject(req.params.projectId);
      const files = (req.files || []) as Express.Multer.File[];
      if (files.some(isArchiveUpload)) {
        importUploadedSourcesInBackground(project, files);
        res.status(202).json({
          ...pendingUploadResult(files.length, "文件已上传，后台正在解包并登记到摄入队列。"),
          activity: await compactActivitySnapshot(project)
        });
        return;
      }
      const result = await importUploadedSources(project, files);
      res.status(201).json({ ...result, activity: await compactActivitySnapshot(project) });
    })
  );

  router.put("/projects/:projectId/sources/upload-chunk", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const uploadId = safeUploadToken(String(req.query.uploadId || ""));
    const index = readQueryInteger(req.query.index, "index", 0);
    const totalChunks = readQueryInteger(req.query.totalChunks, "totalChunks", 1);
    const offset = readQueryInteger(req.query.offset, "offset", 0);
    const fileSize = readQueryInteger(req.query.fileSize, "fileSize", 0);
    const chunkSize = readQueryInteger(req.query.chunkSize, "chunkSize", 0);
    const fileName = safeUploadFileName(String(req.query.fileName || "source"));

    if (!uploadId) throw Object.assign(new Error("Missing uploadId"), { status: 400 });
    if (totalChunks > maxUploadChunks) {
      throw Object.assign(new Error(`上传分片数量超过限制：${maxUploadChunks}`), { status: 413 });
    }
    if (index >= totalChunks) throw Object.assign(new Error("Invalid chunk index"), { status: 400 });
    if (chunkSize > maxUploadChunkBytes) {
      throw Object.assign(new Error(`单个上传分片超过限制：${maxUploadChunkMb} MB`), { status: 413 });
    }

    const contentLength = Number(req.header("content-length") || chunkSize);
    if (Number.isFinite(contentLength) && contentLength > maxUploadChunkBytes + 1024 * 1024) {
      throw Object.assign(new Error(`单个上传分片超过限制：${maxUploadChunkMb} MB`), { status: 413 });
    }

    const sessionDir = path.join(projectRoot("_tmp"), "upload-sessions", project.id, uploadId);
    const metaPath = path.join(sessionDir, "meta.json");
    const payloadPath = path.join(sessionDir, `payload-${fileName}`);
    await fs.mkdir(sessionDir, { recursive: true });
    const meta = await readUploadSessionMeta(metaPath, {
      uploadId,
      fileName,
      fileSize,
      totalChunks,
      received: []
    });
    if (meta.fileName !== fileName || meta.fileSize !== fileSize || meta.totalChunks !== totalChunks) {
      throw Object.assign(new Error("上传分片元数据不一致，请重新上传。"), { status: 409 });
    }

    if (offset + chunkSize > fileSize) {
      throw Object.assign(new Error("上传分片超出文件大小，请重新上传。"), { status: 400 });
    }

    const alreadyReceived = meta.received.includes(index);
    const writtenBytes = await writeRequestChunk(
      req,
      payloadPath,
      offset,
      alreadyReceived ? "r+" : index === 0 ? "w" : "r+",
      maxUploadChunkBytes
    );
    if (writtenBytes !== chunkSize) {
      throw Object.assign(new Error("上传分片大小校验失败，请重新上传。"), { status: 400 });
    }
    if (!alreadyReceived) meta.received.push(index);
    meta.received = [...new Set(meta.received)].sort((a, b) => a - b);
    meta.updatedAt = nowIso();
    await writeUploadSessionMeta(metaPath, meta);

    if (meta.received.length < totalChunks) {
      res.json({
        done: false,
        receivedChunks: meta.received.length,
        totalChunks,
        fileName
      });
      return;
    }

    const stat = await fs.stat(payloadPath);
    if (fileSize > 0 && stat.size !== fileSize) {
      throw Object.assign(new Error("上传文件大小校验失败，请重新上传。"), { status: 400 });
    }

    const finalPath = path.join(projectRoot("_tmp"), "uploads", `${uploadId}-${fileName}`);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.rename(payloadPath, finalPath);
    await fs.rm(sessionDir, { recursive: true, force: true });
    const completedFile = toMulterFile(finalPath, fileName, stat.size);
    importUploadedSourcesInBackground(project, [completedFile]);
    res.status(202).json({
      done: true,
      receivedChunks: totalChunks,
      totalChunks,
      fileName,
      ...pendingUploadResult(1, "文件已上传，后台正在解包并登记到摄入队列。"),
      activity: await compactActivitySnapshot(project)
    });
  }));

  router.delete("/projects/:projectId/sources/upload-session", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const uploadId = safeUploadToken(String(req.query.uploadId || ""));
    if (!uploadId) throw Object.assign(new Error("Missing uploadId"), { status: 400 });
    const sessionDir = path.join(projectRoot("_tmp"), "upload-sessions", project.id, uploadId);
    await fs.rm(sessionDir, { recursive: true, force: true });
    res.json({ ok: true });
  }));

  router.post("/projects/:projectId/sources/clip", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const source = await importWebClip(project, {
      title: String(req.body.title || req.body.url || "web-clip"),
      url: req.body.url ? String(req.body.url) : undefined,
      content: String(req.body.content || "")
    });
    res.status(201).json({ source });
  }));

  router.post("/projects/:projectId/sources/rescan", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    res.json(await rescanSources(project));
  }));

  router.get("/projects/:projectId/activity", asyncHandler(async (req, res) => {
    res.json(
      await getActivity(await getProject(req.params.projectId), {
        sourceLimit: readOptionalQueryInteger(req.query.sourceLimit),
        queueLimit: readOptionalQueryInteger(req.query.queueLimit),
        compact: String(req.query.compact || "") === "1"
      })
    );
  }));

  router.post("/projects/:projectId/search", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    res.json({ hits: await searchProject(project, String(req.body.query || ""), { includeRaw: true }) });
  }));

  router.post("/projects/:projectId/chat", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    res.json(
      await answerQuestion(project, {
        query: String(req.body.query || req.body.message || ""),
        chatId: req.body.chatId ? String(req.body.chatId) : undefined,
        save: Boolean(req.body.save),
        attachments: req.body.attachments,
        useHistory: req.body.useHistory !== false
      })
    );
  }));

  router.get("/projects/:projectId/chats", asyncHandler(async (req, res) => {
    res.json({ chats: await listChats(await getProject(req.params.projectId)) });
  }));

  router.post("/projects/:projectId/chats/:chatId/save", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    res.json({ savedPath: await saveLatestChatAnswer(project, req.params.chatId) });
  }));

  router.get("/projects/:projectId/graph", asyncHandler(async (req, res) => {
    res.json(await buildKnowledgeGraph(await getProject(req.params.projectId)));
  }));

  router.post("/projects/:projectId/lint", asyncHandler(async (req, res) => {
    res.json({
      issues: await lintProject(await getProject(req.params.projectId), {
        limit: readOptionalQueryInteger(req.query.limit) || readOptionalBodyInteger(req.body?.limit)
      })
    });
  }));

  router.post("/projects/:projectId/research", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    res.json(await runResearch(project, {
      topic: String(req.body.topic || ""),
      queries: Array.isArray(req.body.queries) ? req.body.queries.map(String) : undefined
    }));
  }));

  router.get("/projects/:projectId/settings", asyncHandler(async (req, res) => {
    const settings = await readSettings(await getProject(req.params.projectId));
    res.json({ settings });
  }));

  router.put("/projects/:projectId/settings", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    res.json({ settings: await writeSettings(project, req.body || {}) });
  }));

  router.post("/projects/:projectId/queue/resume", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    processProjectQueue(project).catch((error) => console.error("[queue] resume failed", error));
    res.json({ ok: true });
  }));

  router.get("/projects/:projectId/raw-tree", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const root = safeJoin(project.root, "raw/sources");
    const limit = readOptionalQueryInteger(req.query.limit) ?? defaultRawTreeLimit;
    const files = await listFiles(root, { limit: limit + 1 });
    const visibleFiles = files.slice(0, limit);
    res.json({
      files: visibleFiles.map((file) => `raw/sources/${toPosix(file)}`),
      limit,
      limited: files.length > limit
    });
  }));

  router.delete("/projects/:projectId/sources/:sourceId", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const [sources, queue] = await Promise.all([readSources(project), readQueue(project)]);
    const source = sources.find((item) => item.id === req.params.sourceId);
    if (source) {
      await removeSourceFiles(project, source);
    }
    const next = sources.filter((item) => item.id !== req.params.sourceId);
    const nextQueue = queue.filter((item) => item.sourceId !== req.params.sourceId);
    await Promise.all([writeSources(project, next), writeQueue(project, nextQueue)]);
    const page = selectSourcePage(next, { limit: defaultRawListLimit, compact: true });
    res.json({
      sources: page.files,
      files: page.files,
      total: next.length,
      queueTotal: nextQueue.length,
      deleted: Boolean(source)
    });
  }));

  return router;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.LLM_WIKI_API_TOKEN;
  if (!expected || req.path.endsWith("/health")) {
    next();
    return;
  }
  const provided = req.header("x-api-token") || req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (provided === expected) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}

export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (isRequestAbortedError(error, req)) {
    if (!res.headersSent && !res.destroyed && res.writable) {
      res.status(499).json({
        error: "上传连接已中断。请保持页面打开，或将超大批量文件压成 ZIP 后上传。",
        code: "REQUEST_ABORTED"
      });
    }
    return;
  }
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" || error.code === "LIMIT_FILE_COUNT" ? 413 : 400;
    const detail =
      error.code === "LIMIT_FILE_COUNT"
        ? `一次上传的文件数量超过限制。可通过 LLM_WIKI_MAX_UPLOAD_FILES 调整，当前默认 ${maxUploadFiles}。`
        : error.code === "LIMIT_FILE_SIZE"
          ? `上传文件超过大小限制。可通过 LLM_WIKI_MAX_UPLOAD_SIZE_MB 调整，当前限制 ${maxUploadSizeMb} MB。`
        : error.message;
    res.status(status).json({ error: detail, code: error.code });
    return;
  }
  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
  const message = error instanceof Error ? error.message : String(error);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: message });
}

function isRequestAbortedError(error: unknown, req: Request): boolean {
  if (req.aborted || req.destroyed) return true;
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as NodeJS.ErrnoException).code || "") : "";
  return code === "ECONNRESET" || code === "ECONNABORTED" || /request aborted/i.test(error.message);
}

interface UploadSessionMeta {
  uploadId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  received: number[];
  updatedAt?: string;
}

function importUploadedSourcesInBackground(project: Awaited<ReturnType<typeof getProject>>, files: Express.Multer.File[]): void {
  void importUploadedSources(project, files).catch(async (error) => {
    console.error("[upload] background import failed", error);
    await recordFailedUploadedSources(project, files, error).catch((recordError) =>
      console.error("[upload] failed to record background import failure", recordError)
    );
    await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => undefined)));
  });
}

function pendingUploadResult(total: number, message: string) {
  return {
    async: true,
    message,
    sources: [],
    total,
    queued: 0,
    skipped: 0,
    archives: [] as Array<{ fileName: string; extracted: number; directory: string }>
  };
}

function isArchiveUpload(file: Express.Multer.File): boolean {
  return path.extname(file.originalname).toLowerCase() === ".zip";
}

async function writeRequestChunk(
  req: Request,
  filePath: string,
  offset: number,
  flags: "w" | "r+",
  maxBytes: number
): Promise<number> {
  if (flags === "r+") {
    await fs.access(filePath).catch((error) => {
      throw Object.assign(new Error("上传分片顺序错误，请重新上传。"), {
        status: (error as NodeJS.ErrnoException).code === "ENOENT" ? 409 : 500
      });
    });
  }
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(Object.assign(new Error(`单个上传分片超过限制：${maxUploadChunkMb} MB`), { status: 413 }));
        return;
      }
      callback(null, chunk);
    }
  });
  await pipeline(req, limiter, createWriteStream(filePath, { flags, start: offset }));
  return bytes;
}

async function readUploadSessionMeta(filePath: string, fallback: UploadSessionMeta): Promise<UploadSessionMeta> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as UploadSessionMeta;
    return {
      ...fallback,
      ...parsed,
      received: Array.isArray(parsed.received) ? parsed.received.map(Number).filter(Number.isFinite) : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeUploadSessionMeta(filePath: string, meta: UploadSessionMeta): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

function toMulterFile(filePath: string, originalName: string, size: number): Express.Multer.File {
  return {
    fieldname: "files",
    originalname: originalName,
    encoding: "7bit",
    mimetype: "application/octet-stream",
    destination: path.dirname(filePath),
    filename: path.basename(filePath),
    path: filePath,
    size,
    stream: undefined as unknown as Express.Multer.File["stream"],
    buffer: undefined as unknown as Express.Multer.File["buffer"]
  };
}

export function safeUploadToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, maxUploadTokenBytes);
}

export function safeUploadFileName(value: string): string {
  const parsed = path.posix.parse(toPosix(value).split("/").filter(Boolean).pop() || "source");
  const base = readableTextOrFallback(parsed.name || "source", "source")
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .trim() || "source";
  const ext = parsed.ext.replace(/[<>:"|?*\x00-\x1F]/g, "");
  return shortenUploadFileName(isUnknownGlyphText(base) ? "source" : base, ext || ".txt");
}

function shortenUploadFileName(base: string, ext: string): string {
  const candidate = `${base}${ext}`;
  if (Buffer.byteLength(candidate, "utf8") <= maxUploadFileNameBytes) return candidate;

  const hash = createHash("sha256").update(candidate).digest("hex").slice(0, 8);
  const safeExt = shortenUploadExtension(ext);
  const trailer = `-${hash}${safeExt}`;
  const budget = Math.max(1, maxUploadFileNameBytes - Buffer.byteLength(trailer, "utf8"));
  return `${truncateUtf8(base, budget)}${trailer}`;
}

function shortenUploadExtension(ext: string): string {
  const limit = Math.max(0, Math.min(32, maxUploadFileNameBytes - 16));
  if (!ext || Buffer.byteLength(ext, "utf8") <= limit) return ext;
  return truncateUtf8(ext, limit);
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

function readQueryInteger(value: unknown, name: string, min: number): number {
  const number = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isFinite(number) || number < min) {
    throw Object.assign(new Error(`Invalid ${name}`), { status: 400 });
  }
  return Math.floor(number);
}

function readOptionalQueryInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function readOptionalBodyInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function compactActivitySnapshot(project: Project) {
  return getActivity(project, { sourceLimit: 500, queueLimit: 500, compact: true });
}

function selectSourcePage(
  sources: SourceRecord[],
  options: { limit: number; offset?: number; query?: string; compact: boolean }
): { files: SourceRecord[]; total: number; offset: number; limit: number } {
  const safeLimit = Math.min(5000, Math.max(1, Math.floor(options.limit)));
  const safeOffset = Math.max(0, Math.floor(options.offset ?? 0));
  const needle = normalizeSourceQuery(options.query);
  const ordered = sources.slice().reverse();
  const filtered = needle ? ordered.filter((source) => sourceMatchesQuery(source, needle)) : ordered;
  const page = filtered.slice(safeOffset, safeOffset + safeLimit);
  return {
    files: compactSources(page, options.compact),
    total: filtered.length,
    offset: safeOffset,
    limit: safeLimit
  };
}

function selectRecentSources(sources: SourceRecord[], limit: number, compact: boolean): SourceRecord[] {
  const safeLimit = Math.min(5000, Math.max(1, Math.floor(limit)));
  const selected = sources.slice(-safeLimit).reverse();
  return compactSources(selected, compact);
}

function compactSources(sources: SourceRecord[], compact: boolean): SourceRecord[] {
  if (!compact) return sources;
  return sources.map((source) => {
    const { summary: _summary, ...rest } = source;
    return {
      ...rest,
      error: source.error ? source.error.slice(0, 500) : undefined
    };
  });
}

function normalizeSourceQuery(query: string | undefined): string {
  return String(query || "").trim().toLowerCase();
}

function sourceMatchesQuery(source: SourceRecord, needle: string): boolean {
  return [
    source.title,
    source.fileName,
    source.relativePath,
    source.kind,
    source.status,
    source.error
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

async function removeSourceFiles(project: Project, source: SourceRecord): Promise<void> {
  const paths = [
    source.relativePath,
    isGeneratedSourcePage(source.wikiPath) ? source.wikiPath : undefined,
    isGeneratedSourcePage(source.convertedPath) ? source.convertedPath : undefined
  ].filter(Boolean) as string[];

  await Promise.all(paths.map((relativePath) => fs.rm(safeJoin(project.root, relativePath), { force: true })));
  await fs.rm(safeJoin(project.root, `raw/assets/${source.id}`), { recursive: true, force: true });
}

function isGeneratedSourcePage(value: string | undefined): value is string {
  return Boolean(value && (value.startsWith("wiki/sources/") || value.startsWith("wiki/sources/converted/")));
}

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): express.RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
