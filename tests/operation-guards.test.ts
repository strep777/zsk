import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, writeSettings } from "../server/lib/storage.js";
import { runExternalSearch, testExternalSearch } from "../server/lib/webSearch.js";
import { answerQuestion, deleteChat, listChats } from "../server/lib/search.js";
import { makeProject } from "./helpers.js";
import fs from "node:fs/promises";
import path from "node:path";
import { listWikiFilesPage, writeWikiFile } from "../server/lib/wiki.js";
import { discoverModels } from "../server/lib/modelDiscovery.js";
import { discoverMcp, invokeMcpQueryTool } from "../server/lib/mcpClient.js";

afterEach(() => { vi.restoreAllMocks(); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const typesense = { ...DEFAULT_SETTINGS, webSearchUrl: "http://localhost:8108", webSearchApiKey: "read-key", webSearchCollection: "pages", webSearchQueryBy: "article.title,article.body" };

describe("unexpected operation guards", () => {
  it("never sends network requests when external search is disabled", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html></html>"));
    expect(await runExternalSearch({ ...DEFAULT_SETTINGS, webSearchProvider: "none" }, ["私有问题"], { allowDirectFallback: true })).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });

  it("never switches search services after an empty response or configured service failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ results: [] }));
    const settings = { ...DEFAULT_SETTINGS, webSearchProvider: "searxng" as const, webSearchUrl: "http://localhost:8080" };
    expect(await runExternalSearch(settings, ["查询"])).toEqual([]);
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockClear().mockResolvedValue(json({}, 503));
    expect(await runExternalSearch(settings, ["查询"])).toEqual([]);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("reads nested Typesense fields and a valid alternative URL without discarding the document", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ hits: [{ document: {
      title: { invalid: true }, url: { invalid: true }, link: "https://example.test/law",
      article: { title: "嵌套法规", body: "正文中的有效条款" }
    } }] }));
    expect(await runExternalSearch(typesense, ["法规"])).toEqual([{ title: "嵌套法规", snippet: "正文中的有效条款", url: "https://example.test/law" }]);
  });

  it("rejects unusable search payloads instead of treating an unsafe URL as a citation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ results: [{ title: "错误", url: "https://", content: "资料" }] }));
    await expect(testExternalSearch({ ...DEFAULT_SETTINGS, webSearchProvider: "searxng", webSearchUrl: "http://localhost:8080" })).rejects.toThrow("可引用");
  });

  it("preserves the accepted text attachment in the first answer and subsequent conversation", async () => {
    const project = await makeProject();
    await writeSettings(project, { provider: "custom", model: "chat", baseUrl: "http://localhost:8888/v1", webSearchProvider: "none" });
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ choices: [{ message: { content: "根据附件作答。" } }] });
    });
    const text = "前文说明。".repeat(900) + "最终条款：验收期限为十五天。";
    const first = await answerQuestion(project, { query: "附件的验收期限？", attachments: [{ name: "协议.txt", kind: "text", mimeType: "text/plain", text }] });
    expect(JSON.stringify(bodies[0])).toContain("验收期限为十五天");
    expect((await listChats(project))[0].messages[0].attachments?.[0].text).toBe(text);
    await answerQuestion(project, { query: "这个期限从何时起算？", chatId: first.chat.id });
    expect(JSON.stringify(bodies[1])).toContain("验收期限为十五天");
    await answerQuestion(project, { query: "不使用之前的附件", chatId: first.chat.id, useHistory: false });
    expect(JSON.stringify(bodies[2])).not.toContain("验收期限为十五天");
  });

  it("ignores a document removed during a metadata scan without hiding other files", async () => {
    const project = await makeProject();
    await writeWikiFile(project, "wiki/sources/removed.md", "# 移除的资料");
    const removed = path.join(project.root, "wiki/sources/removed.md");
    const original = fs.stat;
    vi.spyOn(fs, "stat").mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === removed) await fs.rm(removed, { force: true });
      return original(...args);
    });
    const page = await listWikiFilesPage(project, { includeTotal: true });
    expect(page.files.some((file) => file.path === "wiki/index.md")).toBe(true);
    expect(page.files.some((file) => file.path.endsWith("removed.md"))).toBe(false);
    expect(page.total).toBe(page.files.length);
  });

  it("rejects malformed diagnostic configuration before contacting a service or starting a process", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ models: [] }));
    await expect(discoverModels({ provider: "ollama", baseUrl: "http://localhost:11434", apiKey: 42 as unknown as string })).rejects.toMatchObject({ status: 400 });
    await expect(discoverMcp({ id: "bad", name: "", enabled: true, transport: "http", url: "http://localhost:8765/mcp", tools: [42 as unknown as string] })).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  it("invokes a read-only MCP tool from a later discovery page", async () => {
    const called: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET" || init?.method === "DELETE") return new Response(null, { status: 405 });
      const body = JSON.parse(String(init?.body));
      if (body.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
      let result: unknown;
      if (body.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "分页服务", version: "1" } };
      else if (body.method === "tools/list") result = body.params?.cursor ? { tools: [{ name: "search_law", inputSchema: { type: "object", properties: { query: { type: "string" } } }, annotations: { readOnlyHint: true } }] } : { tools: [], nextCursor: "page-2" };
      else if (body.method === "tools/call") { called.push(body.params.name); result = { content: [{ type: "text", text: "有效检索结果" }] }; }
      else result = {};
      return json({ jsonrpc: "2.0", id: body.id, result });
    });
    const result = await invokeMcpQueryTool({ id: "paged", name: "", enabled: true, transport: "http", url: "http://localhost:8765/mcp" }, "search_law", "法规", 1500);
    expect(result).toMatchObject({ content: [{ type: "text", text: "有效检索结果" }] });
    expect(called).toEqual(["search_law"]);
  });

  it("rejects overlapping turns using conversation history and allows retry after completion", async () => {
    const project = await makeProject();
    const initial = await answerQuestion(project, { query: "开场", modelId: "summary" });
    await writeSettings(project, { provider: "custom", model: "chat", baseUrl: "http://localhost:8888/v1", webSearchProvider: "none" });
    let finish!: (response: Response) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const mock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => { started(); return new Promise((resolve) => { finish = resolve; }); }).mockResolvedValue(json({ choices: [{ message: { content: "第二轮回答" } }] }));
    const active = answerQuestion(project, { query: "第一轮追问", chatId: initial.chat.id });
    await ready;
    try {
      await expect(answerQuestion(project, { query: "第二轮追问", chatId: initial.chat.id })).rejects.toMatchObject({ status: 409 });
    } finally { finish(json({ choices: [{ message: { content: "第一轮回答" } }] })); await active; }
    const retry = await answerQuestion(project, { query: "第二轮追问", chatId: initial.chat.id });
    expect(retry.chat.messages).toHaveLength(6);
    expect(String(mock.mock.calls.at(-1)?.[1]?.body)).toContain("第一轮回答");
  });

  it("does not resolve malformed or noncanonical chat IDs to another conversation", async () => {
    const project = await makeProject();
    const initial = await answerQuestion(project, { query: "保留会话", modelId: "summary" });
    await expect(deleteChat(project, initial.chat.id.toUpperCase())).rejects.toMatchObject({ status: 400 });
    expect(await listChats(project)).toHaveLength(1);
  });
});
