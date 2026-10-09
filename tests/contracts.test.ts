import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import express from "express";
import AdmZip from "adm-zip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Project } from "../server/types.js";

let directory: string;
let base: string;
let server: Server;
let project: Project;
let storage: typeof import("../server/lib/storage.js");
const call = (suffix: string, body: unknown, method = "POST") => fetch(`${base}${suffix}`, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});

beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(process.cwd(), "tests", ".tmp-contracts-"));
  vi.stubEnv("LLM_WIKI_DATA_DIR", directory);
  vi.stubEnv("LLM_WIKI_DIRECT_WEB_SEARCH", "0");
  vi.stubEnv("LLM_WIKI_MAX_ARCHIVE_ENTRIES", "2");
  vi.stubEnv("LLM_WIKI_MAX_ARCHIVE_FILE_SIZE_MB", "1");
  vi.stubEnv("LLM_WIKI_MAX_ARCHIVE_SIZE_MB", "1");
  vi.resetModules();
  storage = await import("../server/lib/storage.js");
  const { createApiRouter, errorHandler } = await import("../server/routes.js");
  project = await storage.createProject({ name: "异常操作验证" });
  await storage.writeSettings(project, { modelProfiles: [] });
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use(createApiRouter());
  app.use(errorHandler);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  const { isProjectQueueRunning } = await import("../server/lib/ingest.js");
  for (let attempt = 0; attempt < 200 && (await storage.listProjects()).some((item) => isProjectQueueRunning(item.id)); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

describe("HTTP contracts protect persisted data", () => {
  it.each([
    { name: "" }, { name: "   " }, { name: { title: "bad" } }, { name: "名".repeat(201) }
  ])("rejects invalid project input without creating a project: %j", async (body) => {
    const response = await call("/projects", body);
    expect(response.status).toBe(400);
    expect(await storage.listProjects()).toHaveLength(1);
  });

  it.each([
    { path: "wiki/index.md", content: { text: "bad" } },
    { path: "wiki/assets/image.png", content: "corrupt image" },
    { path: "wiki/concepts/CON.md", content: "Windows reserved path" },
    { path: "wiki/index.md", content: "损坏\uFFFD文字" }
  ])("rejects invalid writes without changing the original document: %j", async (body) => {
    const original = await fs.readFile(path.join(project.root, "wiki/index.md"), "utf8");
    const response = await call(`/projects/${project.id}/files/content`, body, "PUT");
    expect(response.status).toBe(400);
    expect(await fs.readFile(path.join(project.root, "wiki/index.md"), "utf8")).toBe(original);
  });

  it.each([
    { skills: [null] }, { skills: [{ prompt: 42, enabled: true }] },
    { modelProfiles: "replace everything" }, { systemPrompt: { text: "bad" } },
    { skills: [{ name: "bad", prompt: "test", enabled: "false" }] },
    { modelProfiles: [{ id: "broken", provider: "invalid", model: "x", baseUrl: "http://localhost", enabled: true }] }
  ])("rejects malformed settings and preserves existing settings: %j", async (body) => {
    const original = await storage.readSettings(project);
    const response = await call(`/projects/${project.id}/settings`, body, "PUT");
    expect(response.status).toBe(400);
    expect(await storage.readSettings(project)).toEqual(original);
  });

  it("rejects string booleans and object questions before saving chat output", async () => {
    for (const body of [{ query: { text: "bad" } }, { query: "问题", save: "false" }]) {
      expect((await call(`/projects/${project.id}/chat`, body)).status).toBe(400);
    }
    const { listChats } = await import("../server/lib/search.js");
    expect(await listChats(project)).toHaveLength(0);
  });

  it("rejects malformed or excessive research queries before creating tasks", async () => {
    for (const body of [{ topic: "研究", queries: [{}] }, { topic: "研究", queries: Array(9).fill("query") }]) {
      expect((await call(`/projects/${project.id}/research`, body)).status).toBe(400);
    }
    const { listResearchTasks } = await import("../server/lib/research.js");
    expect(await listResearchTasks(project)).toHaveLength(0);
  });
  it.each([
    { query: "问题", attachments: [null] },
    { query: "问题", attachments: [{ name: "bad.png", mimeType: "image/png", kind: "image", dataUrl: "data:image/png;base64,broken===" }] },
    { query: "问题", attachments: Array(7).fill({ name: "note.txt", kind: "text", text: "材料" }) },
    { query: "问题", attachments: [{ name: "big.png", mimeType: "image/png", kind: "image", dataUrl: `data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}` }] }
  ])("rejects invalid attachments instead of silently removing supplied evidence ($query)", async (body) => {
    expect((await call(`/projects/${project.id}/chat`, body)).status).toBe(400);
  });
  it.each([{ content: {} }, { content: "正文", url: "javascript:alert(1)" }, { content: "正文", title: "标题\n# 注入标题" }])("rejects invalid clips: %j", async (body) => {
    expect((await call(`/projects/${project.id}/sources/clip`, body)).status).toBe(400);
  });
  it("rejects missing content rather than erasing a document", async () => {
    expect((await call(`/projects/${project.id}/files/content`, { path: "wiki/index.md" }, "PUT")).status).toBe(400);
  });
  it.each(["limit=-1", "limit=1.5", "offset=invalid", "scope=private", "limit=1000000000"])("rejects invalid pagination parameters: %s", async (query) => {
    expect((await fetch(`${base}/projects/${project.id}/files?${query}`)).status).toBe(400);
  });
  it("rejects unsupported, empty and invalidly identified chunk uploads", async () => {
    for (const overrides of [{ fileName: "program.exe" }, { uploadId: "invalid../id" }, { fileSize: "0", chunkSize: "0" }]) {
      const params = new URLSearchParams({ uploadId: "boundary-check", fileName: "source.txt", index: "0", totalChunks: "1", offset: "0", fileSize: "1", chunkSize: "1", ...overrides });
      const response = await fetch(`${base}/projects/${project.id}/sources/upload-chunk?${params}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: overrides.fileSize === "0" ? "" : "x" });
      expect(response.status).toBe(400);
    }
  });
  it.each(["entry-size", "total-size", "entry-count"])("rejects archives exceeding configured %s before registering any sources", async (kind) => {
    const isolated = await storage.createProject({ name: `archive-${kind}` });
    const zip = new AdmZip();
    if (kind === "entry-size") zip.addFile("large.txt", Buffer.alloc(2 * 1024 * 1024, "a"));
    else if (kind === "total-size") { zip.addFile("one.txt", Buffer.alloc(700000, "a")); zip.addFile("two.txt", Buffer.alloc(700000, "b")); }
    else for (const name of ["one.txt", "two.txt", "three.txt"]) zip.addFile(name, Buffer.from("content"));
    const filePath = path.join(isolated.root, "archive.zip");
    await fs.writeFile(filePath, zip.toBuffer());
    const { importUploadedSources } = await import("../server/lib/ingest.js");
    await expect(importUploadedSources(isolated, [{ path: filePath, originalname: "archive.zip" } as Express.Multer.File])).rejects.toMatchObject({ status: 413 });
    expect(await storage.readSources(isolated)).toHaveLength(0);
  });
  it("makes completed chunk retries idempotent and rejects changed retry contents", async () => {
    const params = new URLSearchParams({ uploadId: "retry-completed", fileName: "retry.txt", index: "0", totalChunks: "1", offset: "0", fileSize: "3", chunkSize: "3" });
    const send = (body: string) => fetch(`${base}/projects/${project.id}/sources/upload-chunk?${params}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body });
    expect((await send("abc")).status).toBe(201);
    expect((await send("abc")).status).toBe(201);
    expect((await storage.readSources(project)).filter((source) => /retry/.test(source.fileName))).toHaveLength(1);
    expect((await send("xyz")).status).toBe(409);
  });
  it("defers activity snapshots for browser uploads, including completed retries", async () => {
    const params = new URLSearchParams({ uploadId: "defer-refresh", fileName: "deferred.txt", index: "0", totalChunks: "1", offset: "0", fileSize: "3", chunkSize: "3", deferRefresh: "1" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${base}/projects/${project.id}/sources/upload-chunk?${params}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: "abc" });
      expect(response.status).toBe(201);
      const result = await response.json(); expect(result.done).toBe(true); expect(result).not.toHaveProperty("activity");
    }
    expect((await storage.readSources(project)).filter((source) => source.fileName === "deferred.txt")).toHaveLength(1);
  });
  it.each(["empty", "unsupported"])("rejects a %s ZIP instead of reporting an empty successful import", async (kind) => {
    const isolated = await storage.createProject({ name: `archive-${kind}` });
    const zip = new AdmZip();
    if (kind === "unsupported") zip.addFile("program.exe", Buffer.from("unsupported"));
    const filePath = path.join(isolated.root, "archive.zip");
    await fs.writeFile(filePath, zip.toBuffer());
    const { importUploadedSources } = await import("../server/lib/ingest.js");
    await expect(importUploadedSources(isolated, [{ path: filePath, originalname: "archive.zip" } as Express.Multer.File])).rejects.toMatchObject({ status: 400 });
    expect(await storage.readSources(isolated)).toHaveLength(0);
  });
});
