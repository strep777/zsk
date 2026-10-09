import fs from "node:fs/promises";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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
  safeJoin,
  toPosix,
  writeQueue,
  writeJson,
  writeSources,
  writeSettings
} from "./lib/storage.js";
import { extractDocument, readTextSourceFile } from "./lib/extract.js";
import {
  getActivity,
  importUploadedSources,
  importWebClip,
  processProjectQueue,
  recordFailedUploadedSources,
  rescanSources,
  withProjectLock,
  isProjectQueueRunning,
  assertSupportedUploadName
} from "./lib/ingest.js";
import { listWikiFilesPage, readWikiFile, writeWikiFile, updateIndex, updateOverview, removeSourceEvidence } from "./lib/wiki.js";
import { answerQuestion, deleteChat, listChats, saveLatestChatAnswer, searchProject } from "./lib/search.js";
import { buildKnowledgeGraph } from "./lib/graph.js";
import { lintProject } from "./lib/lint.js";
import { createResearchTask, deleteResearchTask, listResearchTasks, readResearchTask, runResearchTask } from "./lib/research.js";
import { cleanUnknownGlyphRuns, isUnknownGlyphText, readableTextOrFallback } from "./lib/text.js";
import { nowIso } from "./lib/time.js";
import { Project, SourceRecord } from "./types.js";
import { diagnosticModel, discoverModels } from "./lib/modelDiscovery.js";
import { testModelConnection, resolveModelSettings } from "./lib/llm.js";
import { discoverMcp } from "./lib/mcpClient.js";
import { testExternalSearch } from "./lib/webSearch.js";
import { discoverExternalTypesense } from "./lib/externalTypesense.js";
import { testTypesense } from "./lib/typesense.js";
import { diagnosticError, serviceUrl } from "./lib/serviceHttp.js";
import { booleanInput, identifierInput, invalidInput, objectInput, textInput, validateSettingsInput } from "./lib/validation.js";

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
const uploadSessionLocks = new Map<string, Promise<void>>();

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

  router.post("/session", (_req, res) => { res.json({ ok: true }); });

  router.post("/projects/:projectId/attachments/extract", express.raw({ type: "application/octet-stream", limit: "20mb" }), asyncHandler(async (req, res) => {
    await getProject(req.params.projectId);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw Object.assign(new Error("附件内容不能为空。"), { status: 400 });
    const directory = path.join(projectRoot("_tmp"), "attachments");
    await fs.mkdir(directory, { recursive: true });
    const temporary = await fs.mkdtemp(path.join(directory, "attachment-"));
    try {
      const filePath = path.join(temporary, safeUploadFileName(String(req.query.fileName || "attachment.txt")));
      await fs.writeFile(filePath, req.body);
      const extracted = await extractDocument(filePath);
      if (extracted.metadataOnly) invalidInput(extracted.warnings.join(" ") || "附件未能提取正文，无法参与回答。");
      res.json({ text: extracted.text, warnings: extracted.warnings });
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }));

  router.get("/projects", asyncHandler(async (_req, res) => {
    res.json({ projects: (await listProjects()).map(publicProject) });
  }));

  router.post("/projects", asyncHandler(async (req, res) => {
    const body = objectInput(req.body);
    const project = await createProject({
      name: textInput(body.name, "知识库名称", { required: true, max: 200, singleLine: true }),
      description: textInput(body.description, "知识库用途", { max: 4000 })
    });
    res.status(201).json({ project: publicProject(project) });
  }));

  router.get("/projects/:projectId/files", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const scope = String(req.query.scope || "wiki");
    if (!["wiki", "raw", "all"].includes(scope)) invalidInput("请选择有效的文件范围：wiki、raw 或 all。");
    if (scope === "wiki") {
      const limit = readOptionalQueryInteger(req.query.limit);
      const page = await listWikiFilesPage(project, {
        limit,
        offset: readOptionalQueryInteger(req.query.offset, 0) ?? 0,
        query: req.query.query ? String(req.query.query) : undefined,
        includeTotal: String(req.query.includeTotal || "") === "1" || (!limit && !req.query.query)
      });
      res.json(page);
      return;
    }
    if (scope === "raw") {
      const sources = await readSources(project);
      const limit = readOptionalQueryInteger(req.query.limit) ?? defaultRawListLimit;
      const offset = readOptionalQueryInteger(req.query.offset, 0) ?? 0;
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
    const relativePath = normalizePublicFilePath(String(req.query.path || ""));
    if (!relativePath) throw Object.assign(new Error("Missing path"), { status: 400 });
    if (relativePath.startsWith("wiki/")) {
      await assertReadableProjectFile(project, relativePath);
      res.json({ path: relativePath, content: await readWikiFile(project, relativePath) });
      return;
    }
    if (relativePath.startsWith("raw/sources/")) {
      await assertReadableProjectFile(project, relativePath);
      res.json({ path: relativePath, content: await readRawSourceForDisplay(project, relativePath) });
      return;
    }
    throw Object.assign(new Error("Unsupported file path"), { status: 400 });
  }));

  router.get("/projects/:projectId/assets", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const relativePath = normalizePublicFilePath(String(req.query.path || ""));
    if (!relativePath.startsWith("raw/assets/")) {
      throw Object.assign(new Error("Only extracted assets can be served."), { status: 400 });
    }
    res.sendFile(safeJoin(project.root, relativePath));
  }));

  router.put("/projects/:projectId/files/content", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const body = objectInput(req.body);
    if (body.content === undefined) invalidInput("请提供文档内容，空文档请使用空字符串。");
    await writeWikiFile(project, textInput(body.path, "文件路径", { required: true, max: 2000 }), textInput(body.content, "文档内容", { max: 10 * 1024 * 1024 }));
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
          ...pendingUploadResult(files.length, "文件已上传，后台正在解包并自动摄入。"),
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
    const responseActivity = async () => req.query.deferRefresh === "1" ? {} : { activity: await compactActivitySnapshot(project) };
    const rawUploadId = textInput(req.query.uploadId, "上传会话 ID", { required: true, max: maxUploadTokenBytes });
    const uploadId = safeUploadToken(rawUploadId);
    if (uploadId !== rawUploadId) invalidInput("上传会话 ID 格式不正确。");
    const index = readQueryInteger(req.query.index, "index", 0);
    const totalChunks = readQueryInteger(req.query.totalChunks, "totalChunks", 1);
    const offset = readQueryInteger(req.query.offset, "offset", 0);
    const fileSize = readQueryInteger(req.query.fileSize, "fileSize", 0);
    const chunkSize = readQueryInteger(req.query.chunkSize, "chunkSize", 0);
    const fileName = safeUploadFileName(String(req.query.fileName || "source"));
    assertSupportedUploadName(fileName);
    if (!fileSize || !chunkSize) invalidInput("上传文件和分片不能为空。");

    if (!uploadId) throw Object.assign(new Error("Missing uploadId"), { status: 400 });
    if (fileSize > maxUploadSizeMb * 1024 * 1024) {
      throw Object.assign(new Error(`上传文件超过大小限制：${maxUploadSizeMb} MB`), { status: 413 });
    }
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
    return withUploadSessionLock(sessionDir, async () => {
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
    const previousChunk = meta.chunks?.[String(index - 1)];
    const expectedOffset = index === 0 ? 0 : previousChunk ? previousChunk.offset + previousChunk.size : (await fs.stat(payloadPath).catch(() => null))?.size;
    const storedChunk = meta.chunks?.[String(index)];
    if ((!alreadyReceived && (index !== meta.received.length || offset !== expectedOffset)) ||
        (alreadyReceived && storedChunk && (storedChunk.offset !== offset || storedChunk.size !== chunkSize))) {
      throw Object.assign(new Error("上传分片顺序或偏移不正确，请重新上传。"), { status: 409 });
    }
    const stagedPath = path.join(sessionDir, `chunk-${randomUUID()}.tmp`);
    let sha256: string;
    try {
      const writtenBytes = await writeRequestChunk(req, stagedPath, 0, "w", maxUploadChunkBytes);
      if (writtenBytes !== chunkSize) throw Object.assign(new Error("上传分片大小校验失败，请重新上传。"), { status: 400 });
      sha256 = createHash("sha256").update(await fs.readFile(stagedPath)).digest("hex");
      if (alreadyReceived) {
        let previousHash = storedChunk?.sha256;
        if (!previousHash) {
          const handle = await fs.open(payloadPath, "r");
          try {
            const buffer = Buffer.alloc(chunkSize);
            const { bytesRead } = await handle.read(buffer, 0, chunkSize, offset);
            previousHash = bytesRead === chunkSize ? createHash("sha256").update(buffer).digest("hex") : undefined;
          } finally { await handle.close(); }
        }
        if (previousHash !== sha256) throw Object.assign(new Error("重复上传分片的内容不一致，请重新上传。"), { status: 409 });
      } else {
        await pipeline(createReadStream(stagedPath), createWriteStream(payloadPath, { flags: index === 0 ? "w" : "r+", start: offset }));
      }
    } finally { await fs.rm(stagedPath, { force: true }); }
    if (!alreadyReceived) meta.received.push(index);
    meta.chunks = { ...meta.chunks, [String(index)]: { offset, size: chunkSize, sha256 } };
    meta.received = [...new Set(meta.received)].sort((a, b) => a - b);
    meta.updatedAt = nowIso();
    await writeUploadSessionMeta(metaPath, meta);

    if (meta.completed) {
      res.status(meta.completed.status).json({ ...meta.completed.result, ...await responseActivity() });
      return;
    }

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
    if (stat.size !== fileSize) {
      throw Object.assign(new Error("上传文件大小校验失败，请重新上传。"), { status: 400 });
    }

    const finalPath = path.join(projectRoot("_tmp"), "uploads", `${randomUUID()}-${fileName}`);
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.rename(payloadPath, finalPath);
    const completedFile = toMulterFile(finalPath, fileName, stat.size);
    if (!isArchiveUpload(completedFile)) {
      const result = await importUploadedSources(project, [completedFile]);
      const completedResult = {
        done: true,
        receivedChunks: totalChunks,
        totalChunks,
        fileName,
        ...result
      };
      meta.completed = { status: 201, result: completedResult };
      await writeUploadSessionMeta(metaPath, meta);
      res.status(201).json({ ...completedResult, ...await responseActivity() });
      return;
    }

    const completedResult = {
      done: true,
      receivedChunks: totalChunks,
      totalChunks,
      fileName,
      ...pendingUploadResult(1, "文件已上传，后台正在解包并自动摄入。")
    };
    meta.completed = { status: 202, result: completedResult };
    await writeUploadSessionMeta(metaPath, meta);
    importUploadedSourcesInBackground(project, [completedFile]);
    res.status(202).json({ ...completedResult, ...await responseActivity() });
    });
  }));

  router.delete("/projects/:projectId/sources/upload-session", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const rawUploadId = textInput(req.query.uploadId, "上传会话 ID", { required: true, max: maxUploadTokenBytes });
    const uploadId = safeUploadToken(rawUploadId);
    if (uploadId !== rawUploadId) invalidInput("上传会话 ID 格式不正确。");
    if (!uploadId) throw Object.assign(new Error("Missing uploadId"), { status: 400 });
    const sessionDir = path.join(projectRoot("_tmp"), "upload-sessions", project.id, uploadId);
    await withUploadSessionLock(sessionDir, () => fs.rm(sessionDir, { recursive: true, force: true }));
    res.json({ ok: true });
  }));

  router.post("/projects/:projectId/sources/clip", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const body = objectInput(req.body);
    const content = textInput(body.content, "剪藏内容", { required: true, max: 10 * 1024 * 1024 });
    const title = textInput(body.title, "剪藏标题", { max: 200, singleLine: true });
    const url = textInput(body.url, "剪藏链接", { max: 2000, singleLine: true });
    if (url) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw Object.assign(new Error("剪藏链接需要是有效的 HTTP 或 HTTPS 地址。"), { status: 400 }); }
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw Object.assign(new Error("剪藏链接需要是有效的 HTTP 或 HTTPS 地址。"), { status: 400 });
    }
    const source = await importWebClip(project, {
      title: title || "网页剪藏",
      url: url || undefined,
      content
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
    res.json({ hits: await searchProject(project, textInput(objectInput(req.body).query, "检索问题", { max: 16000 }), { includeRaw: true }) });
  }));

  router.post("/projects/:projectId/chat", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const body = objectInput(req.body);
    for (const field of ["save", "useHistory", "webSearch"]) booleanInput(body[field], field);
    res.json(
      await answerQuestion(project, {
        query: textInput(body.query ?? body.message, "问题", { required: true, max: 16000 }),
        chatId: body.chatId ? identifierInput(body.chatId, "会话 ID") : undefined,
        save: body.save === true,
        attachments: body.attachments,
        useHistory: body.useHistory !== false,
        webSearch: body.webSearch === true,
        modelId: body.modelId ? identifierInput(body.modelId, "模型 ID") : undefined
      })
    );
  }));

  router.get("/projects/:projectId/chats", asyncHandler(async (req, res) => {
    res.json({ chats: await listChats(await getProject(req.params.projectId)) });
  }));

  router.delete("/projects/:projectId/chats/:chatId", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    res.json({ deleted: await deleteChat(project, req.params.chatId) });
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
    const body = objectInput(req.body);
    const task = await createResearchTask(project, {
      topic: textInput(body.topic, "研究主题", { required: true, max: 200, singleLine: true }),
      queries: body.queries as string[] | undefined,
      modelId: body.modelId ? identifierInput(body.modelId, "模型 ID") : undefined
    });
    runResearchTask(project, task.id).catch((error) => console.error("[research] task failed", error));
    res.status(202).json({ task });
  }));

  router.get("/projects/:projectId/research", asyncHandler(async (req, res) => {
    res.json({ tasks: await listResearchTasks(await getProject(req.params.projectId)) });
  }));

  router.get("/projects/:projectId/research/:taskId", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    res.json({ task: await readResearchTask(project, req.params.taskId) });
  }));

  router.delete("/projects/:projectId/research/:taskId", asyncHandler(async (req, res) => {
    res.json({ deleted: await deleteResearchTask(await getProject(req.params.projectId), req.params.taskId) });
  }));

  router.get("/projects/:projectId/settings", asyncHandler(async (req, res) => {
    const settings = await readSettings(await getProject(req.params.projectId));
    res.json({ settings });
  }));

  router.put("/projects/:projectId/settings", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    res.json({ settings: await writeSettings(project, req.body || {}) });
  }));

  router.post("/projects/:projectId/settings/diagnostics/:action", asyncHandler(async (req, res) => {
    const project = await getProject(req.params.projectId);
    const body = objectInput(req.body || {});
    if (body.settings !== undefined) validateSettingsInput(body.settings);
    if (body.profile !== undefined) objectInput(body.profile, "模型卡片");
    if (body.server !== undefined) objectInput(body.server, "MCP 卡片");
    const diagnosticBody = body as { settings?: import("./types.js").ProjectSettings; profile?: import("./types.js").ModelProfile; server?: import("./types.js").McpServerConfig; prompt?: unknown };
    const secrets = [diagnosticBody.profile?.apiKey, diagnosticBody.server?.apiKey, diagnosticBody.settings?.typesenseApiKey, diagnosticBody.settings?.webSearchApiKey, ...(diagnosticBody.settings?.modelProfiles || []).map((profile) => profile.apiKey)];
    try {
      switch (req.params.action) {
        case "builtin-search": {
          const sources = await readSources(project);
          await Promise.all(["wiki", "raw/sources"].map((directory) => fs.access(safeJoin(project.root, directory))));
          res.json({ message: `本地文件目录和来源索引读取正常，共 ${sources.length} 份来源。` }); return;
        }
        case "models":
          res.json(await discoverModels(diagnosticBody.profile || {})); return;
        case "model-test": {
          const profile = diagnosticModel(diagnosticBody.profile || {});
          res.json(await testModelConnection({ ...profile, systemPrompt: "" })); return;
        }
        case "mcp":
          res.json(await discoverMcp(diagnosticBody.server!)); return;
        case "typesense":
          res.json(await testTypesense(project, diagnosticBody.settings || {})); return;
        case "typesense-sync":
          throw Object.assign(new Error("知识库使用内置搜索；Typesense 外部网页集合由其数据采集服务维护，应用不会上传知识库资料。"), { status: 400 });
        case "web-search-collections":
          res.json(await discoverExternalTypesense({ ...await readSettings(project), ...diagnosticBody.settings })); return;
        case "web-search": {
          const settings = { ...await readSettings(project), ...diagnosticBody.settings };
          if (!["none", "typesense", "searxng", "tavily", "serpapi"].includes(settings.webSearchProvider)) throw Object.assign(new Error("请选择有效的外部搜索服务。"), { status: 400 });
          if (settings.webSearchUrl) serviceUrl(settings.webSearchUrl);
          res.json(await testExternalSearch(settings)); return;
        }
        case "prompt-test": {
          const settings = { ...await readSettings(project), ...diagnosticBody.settings };
          const runtime = resolveModelSettings(settings);
          serviceUrl(runtime.baseUrl);
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : settings.systemPrompt.trim();
          if (!prompt) throw Object.assign(new Error("请先填写指令或系统提示词。"), { status: 400 });
          if (prompt.length > 32000) throw Object.assign(new Error("测试指令过长，请限制在 32000 字符内。"), { status: 400 });
          res.json(await testModelConnection(runtime, "请简要说明你会如何遵循系统指令，回复不超过 100 字。", prompt)); return;
        }
        default: throw Object.assign(new Error("诊断操作不存在。"), { status: 404 });
      }
    } catch (error) { throw diagnosticError(error, secrets); }
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
    const { sources: next, queue: nextQueue, deleted } = await deleteProjectSource(project, req.params.sourceId);
    const page = selectSourcePage(next, { limit: defaultRawListLimit, compact: true });
    res.json({
      sources: page.files,
      files: page.files,
      total: next.length,
      queueTotal: nextQueue.length,
      deleted
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
  const cookieValue = req.header("cookie")?.split(";").map((item) => item.trim()).find((item) => item.startsWith("llm_wiki_auth="))?.slice("llm_wiki_auth=".length);
  const expectedCookie = createHash("sha256").update(`llm-wiki-session:${expected}`).digest("hex");
  const validCookie = Boolean(cookieValue && /^[a-f0-9]{64}$/.test(cookieValue) && timingSafeEqual(Buffer.from(cookieValue), Buffer.from(expectedCookie)));
  if (provided === expected || validCookie) {
    if (req.method === "POST" && req.path === "/session" && provided === expected) {
      res.cookie("llm_wiki_auth", expectedCookie, { httpOnly: true, sameSite: "strict", secure: req.secure, maxAge: 8 * 60 * 60 * 1000, path: "/api" });
    }
    next();
    return;
  }
  res.status(401).json({ error: "请填写有效的 API Token 后登录。" });
}

export function normalizePublicFilePath(value: string): string {
  const normalized = path.posix.normalize(toPosix(value));
  if (!normalized.startsWith("wiki/") && !normalized.startsWith("raw/sources/") && !normalized.startsWith("raw/assets/")) {
    throw Object.assign(new Error("文件路径超出允许访问的目录。"), { status: 400 });
  }
  return normalized;
}

export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (isRequestAbortedError(error, req)) {
    if (!res.headersSent && !res.destroyed && res.writable) {
      const message = isUploadRequest(req)
        ? "上传连接已中断。请保持页面打开，或将超大批量文件压成 ZIP 后上传。"
        : "请求连接已中断，请重新发送。";
      res.status(499).json({
        error: message,
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
  const safeStatus = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
  const type = typeof error === "object" && error && "type" in error ? error.type : "";
  res.status(safeStatus).json({ error: type === "entity.parse.failed" ? "请求内容不是有效的 JSON，请检查格式。" : type === "entity.too.large" ? "请求内容超过大小限制，请减少附件或分批上传。" : cleanUnknownGlyphRuns(message) });
}

function isRequestAbortedError(error: unknown, req: Request): boolean {
  if (req.aborted || (req.destroyed && !req.complete)) return true;
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as NodeJS.ErrnoException).code || "") : "";
  return code === "ECONNRESET" || code === "ECONNABORTED" || /request aborted/i.test(error.message);
}

function isUploadRequest(req: Request): boolean {
  const url = `${req.originalUrl || ""} ${req.path || ""}`;
  return /\/sources\/upload(?:-chunk|-session)?(?:\b|[/?#])/i.test(url);
}

interface UploadSessionMeta {
  completed?: { status: number; result: Record<string, unknown> };
  uploadId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  received: number[];
  chunks?: Record<string, { offset: number; size: number; sha256?: string }>;
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

export async function assertReadableProjectFile(project: Project, relativePath: string): Promise<void> {
  try {
    const stat = await fs.stat(safeJoin(project.root, relativePath));
    if (!stat.isFile()) {
      throw Object.assign(new Error(`路径不是文件：${relativePath}`), { status: 400 });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error(`文件不存在或已被移除：${relativePath}。请刷新列表或重新扫描来源。`), { status: 404 });
    }
    throw error;
  }
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
  await writeJson(filePath, meta);
}

async function withUploadSessionLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const previous = uploadSessionLocks.get(directory) || Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => pending);
  uploadSessionLocks.set(directory, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (uploadSessionLocks.get(directory) === tail) uploadSessionLocks.delete(directory);
  }
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

const rawTextDisplayExtensions = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".log",
  ".html",
  ".htm",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml"
]);

export function canDisplayRawSourceAsText(relativePath: string): boolean {
  return rawTextDisplayExtensions.has(path.extname(relativePath).toLowerCase());
}

export async function readRawSourceForDisplay(project: Project, relativePath: string): Promise<string> {
  const sources = await readSources(project);
  const source = sources.find((item) => item.relativePath === relativePath);
  if (!canDisplayRawSourceAsText(relativePath)) {
    const fileName = source?.fileName || path.basename(relativePath);
    const kind = source?.kind || "binary";
    const converted = source?.convertedPath ? `\n\n- 已抽取全文：${source.convertedPath}` : "";
    const wiki = source?.wikiPath ? `\n- 来源页：${source.wikiPath}` : "";
    return [
      `# ${readableTextOrFallback(fileName, "非文本文件")}`,
      "",
      `这个原文是 ${kind} 文件，不能按纯文本直接打开。为了避免页面显示乱码，系统已隐藏二进制内容。`,
      "",
      "请回到文件管理页打开“全文”或“来源页”查看抽取后的可读内容。",
      `${converted}${wiki}`.trim()
    ]
      .filter(Boolean)
      .join("\n");
  }
  return cleanUnknownGlyphRuns(await readTextSourceFile(safeJoin(project.root, relativePath)));
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
  if (!Number.isSafeInteger(number) || number < min) {
    throw Object.assign(new Error(`Invalid ${name}`), { status: 400 });
  }
  return number;
}

function readOptionalQueryInteger(value: unknown, min = 1): number | undefined {
  if (value === undefined) return undefined;
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > (min === 0 ? Number.MAX_SAFE_INTEGER : 100000)) invalidInput(`分页或扫描参数必须是 ${min} 到 ${min === 0 ? Number.MAX_SAFE_INTEGER : 100000} 之间的整数。`);
  return number;
}

function readOptionalBodyInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 100000) invalidInput("扫描数量必须是 1 到 100000 之间的整数。");
  return value;
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
  const ordered = orderSourcesForFileManager(sources);
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
  const selected = orderSourcesForFileManager(sources).slice(0, safeLimit);
  return compactSources(selected, compact);
}

function orderSourcesForFileManager(sources: SourceRecord[]): SourceRecord[] {
  return sources.slice().sort((a, b) => {
    const rank = sourceListRank(a.status) - sourceListRank(b.status);
    if (rank !== 0) return rank;
    const time = (b.updatedAt || b.importedAt || "").localeCompare(a.updatedAt || a.importedAt || "");
    if (time !== 0) return time;
    return a.fileName.localeCompare(b.fileName, "zh-CN");
  });
}

function sourceListRank(status: SourceRecord["status"]): number {
  return {
    ready: 0,
    ingesting: 1,
    queued: 2,
    failed: 3,
    skipped: 4
  }[status];
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

export function sourceMatchesQuery(source: SourceRecord, needle: string): boolean {
  return [
    source.title,
    source.fileName,
    source.relativePath,
    source.kind,
    source.status,
    sourceStatusSearchText(source.status),
    source.error
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function sourceStatusSearchText(status: SourceRecord["status"]): string {
  return {
    queued: "queued 排队摄入 待摄入 排队 等待 待处理 处理中 摄入队列",
    ingesting: "ingesting 摄入中 正在摄入 处理中 正在处理",
    ready: "ready 可用 已完成 完成 已摄入 可用文件",
    skipped: "skipped 跳过 已跳过 忽略",
    failed: "failed 失败 摄入失败 错误 需要处理 异常"
  }[status];
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

export async function deleteProjectSource(project: Project, sourceId: string) {
  return withProjectLock(project.id, async () => {
    if (isProjectQueueRunning(project.id)) throw Object.assign(new Error("知识库正在摄入文件，请等待摄入完成后再移除来源。"), { status: 409 });
    const [sources, queue] = await Promise.all([readSources(project), readQueue(project)]);
    const source = sources.find((item) => item.id === sourceId);
    if (source) {
      await removeSourceEvidence(project, [source.relativePath, source.wikiPath, source.convertedPath].filter((value): value is string => Boolean(value)));
      await removeSourceFiles(project, source);
    }
    const next = sources.filter((item) => item.id !== sourceId);
    const nextQueue = queue.filter((item) => item.sourceId !== sourceId);
    await Promise.all([writeSources(project, next), writeQueue(project, nextQueue)]);
    if (source) { await updateOverview(project); await updateIndex(project); }
    return { sources: next, queue: nextQueue, deleted: Boolean(source) };
  });
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
