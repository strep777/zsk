import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverExternalTypesense, searchExternalTypesense } from "../server/lib/externalTypesense.js";
import { runExternalSearch, testExternalSearch } from "../server/lib/webSearch.js";
import { DEFAULT_SETTINGS, readSettings, writeSettings } from "../server/lib/storage.js";
import { searchProject } from "../server/lib/search.js";
import { makeProject, writeProjectFile } from "./helpers.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const settings = { ...DEFAULT_SETTINGS, webSearchUrl: "http://localhost:8108", webSearchApiKey: "read-only-key", webSearchCollection: "web-pages" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const fields = [{ name: "url", type: "string" }, { name: "title", type: "string" }, { name: "content", type: "string" }];

describe("external Typesense searches existing web pages", () => {
  it("tests past an unusable first document instead of rejecting a usable webpage collection", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const limit = Number(new URL(String(input)).searchParams.get("per_page"));
      const hits = [
        { document: { title: "内部文档", content: "没有网页引用" } },
        { document: { title: "公开页面", content: "可引用正文", url: "https://example.test/page" } }
      ];
      return json({ hits: hits.slice(0, limit) });
    });
    const result = await testExternalSearch({ ...settings, webSearchQueryBy: "title,content" });
    expect(result.results).toBe(1);
  });
  it("redacts configured credentials from actual search failure logs", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection failed read-only-key Bearer private-token"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await runExternalSearch({ ...settings, webSearchQueryBy: "title,content" }, ["资料"])).toEqual([]);
    const logged = warning.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("connection failed");
    expect(logged).not.toContain("read-only-key");
    expect(logged).not.toContain("private-token");
  });
  it("retains discovered collections if reading a listed collection schema fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json([{ name: "web-pages" }])).mockResolvedValueOnce(json({}, 404));
    const result = await discoverExternalTypesense(settings);
    expect(result.collections).toEqual(["web-pages"]);
    expect(result.queryBy).toBeUndefined();
    expect(result.message).toContain("字段未获取");
    expect(result.message).toContain("404");
  });
  it("preserves discovered collections when the selected old collection no longer exists", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected mocked request")).mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json([{ name: "current-web" }]));
    const result = await discoverExternalTypesense({ ...settings, webSearchCollection: "old-web" });
    expect(result.collections).toEqual(["current-web"]);
    expect(result.queryBy).toBeUndefined();
    expect(result.message).toContain("重新选择");
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it("discovers collections independently of invalid manually entered search fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json([{ name: "web-pages" }])).mockResolvedValueOnce(json({ fields }));
    expect(await discoverExternalTypesense({ ...settings, webSearchQueryBy: "title,,content" })).toMatchObject({ collections: ["web-pages"], queryBy: "title,content" });
  });
  it("clearly explains an empty collection list instead of asking to select a nonexistent collection", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json([]));
    const result = await discoverExternalTypesense({ ...settings, webSearchCollection: "" });
    expect(result.collections).toEqual([]);
    expect(result.message).toContain("没有可用");
  });
  it("includes custom body fields when standard title fields are present", async () => {
    const mock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ fields: [{ name: "url", type: "string" }, { name: "title", type: "string" }, { name: "article_text", type: "string" }] }))
      .mockResolvedValueOnce(json({ hits: [{ document: { title: "公开页面", article_text: "正文关键词的事实依据", url: "https://example.test/body" } }] }));
    const result = await testExternalSearch(settings);
    expect(result).toMatchObject({ results: 1, queryBy: "title,article_text" });
    expect(new URL(String(mock.mock.calls[1][0])).searchParams.get("query_by")).toBe("title,article_text");
  });
  it("does not report an empty webpage collection as a successful usable search", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ hits: [] }));
    await expect(testExternalSearch({ ...settings, webSearchQueryBy: "title,content" })).rejects.toThrow("没有可引用");
  });
  it("explicitly reports a missing collection in partially configured actual searches", async () => {
    const mock = vi.spyOn(globalThis, "fetch");
    await expect(runExternalSearch({ ...settings, webSearchCollection: "" }, ["资料"])).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });
  it("continues to later queries after the first query contains only unusable documents", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ hits: [{ document: { title: "内部资料", content: "不可引用", url: "file:///private.txt" } }] }))
      .mockResolvedValueOnce(json({ hits: [{ document: { title: "公开材料", content: "真实资料", url: "https://example.test/info" } }] }));
    const result = await searchExternalTypesense({ ...settings, webSearchQueryBy: "title,content" }, ["内部", "公开"], 3);
    expect(result.results).toEqual([{ title: "公开材料", snippet: "真实资料", url: "https://example.test/info" }]);
  });

  it("discovers collections and indexed text fields using authenticated GET requests", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json([{ name: "web-pages" }])).mockResolvedValueOnce(json({ fields }));
    expect(await discoverExternalTypesense(settings)).toMatchObject({ collections: ["web-pages"], queryBy: "title,content" });
    for (const [url, init] of mock.mock.calls) { expect(init?.method || "GET").toBe("GET"); expect(new Headers(init?.headers).get("x-typesense-api-key")).toBe("read-only-key"); expect(String(url)).not.toContain("read-only-key"); }
  });
  it("maps actual HTTP webpage citations and never writes a knowledge-base index", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ fields })).mockResolvedValueOnce(json({ hits: [
      { document: { title: "网页法规", content: "<p>公开信息</p>", url: "https://example.test/law" } },
      { document: { title: "无效引用", content: "错误", url: "javascript:alert(1)" } }
    ] }));
    expect(await runExternalSearch(settings, ["法规"], { allowDirectFallback: true })).toEqual([{ title: "网页法规", snippet: "公开信息", url: "https://example.test/law" }]);
    const url = new URL(String(mock.mock.calls[1][0]));
    expect(url.pathname).toBe("/collections/web-pages/documents/search");
    expect(url.searchParams.get("query_by")).toBe("title,content");
    expect(mock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
  it("supports search-only keys with manually specified fields and tests an actual search", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ hits: [{ document: { title: "公开页面", text: "原文", link: "https://example.test/info" } }] }));
    const result = await testExternalSearch({ ...settings, webSearchQueryBy: "title,text" });
    expect(result.results).toBe(1); expect(result.queryBy).toBe("title,text");
    expect(mock).toHaveBeenCalledTimes(1); expect(String(mock.mock.calls[0][0])).toContain("/documents/search?");
  });
  it("does not silently switch services after empty results, incomplete settings or failure", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ hits: [] }));
    expect(await runExternalSearch({ ...settings, webSearchQueryBy: "content" }, ["未找到"], { allowDirectFallback: true })).toEqual([]);
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockClear(); expect(await runExternalSearch(DEFAULT_SETTINGS, ["查询"])).toEqual([]); expect(mock).not.toHaveBeenCalled();
    mock.mockResolvedValue(json({}, 401));
    await expect(testExternalSearch({ ...settings, webSearchQueryBy: "content" })).rejects.toThrow("401"); expect(mock).toHaveBeenCalledTimes(1);
  });
  it("reports unusable citations and rejects malformed collection/field configuration", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ hits: [{ document: { title: "无链接", content: "资料" } }] }));
    await expect(testExternalSearch({ ...settings, webSearchQueryBy: "content" })).rejects.toThrow("没有可引用");
    mock.mockClear();
    for (const config of [{ webSearchCollection: "../private" }, { webSearchQueryBy: "title,,content" }, { webSearchApiKey: "" }]) await expect(testExternalSearch({ ...settings, ...config })).rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });
  it("keeps project searches built-in even when legacy settings selected Typesense", async () => {
    const project = await makeProject();
    await writeSettings(project, { ...settings, localSearchProvider: "typesense", typesenseUrl: settings.webSearchUrl, typesenseApiKey: "read-only-key" });
    await writeProjectFile(project, "wiki/law.md", "# 公司治理\n公司的会议程序需要记录。");
    const mock = vi.spyOn(globalThis, "fetch");
    expect((await searchProject(project, "会议程序"))[0]?.path).toBe("wiki/law.md");
    expect(mock).not.toHaveBeenCalled(); expect((await readSettings(project)).localSearchProvider).toBe("builtin");
  });
  it("loads existing Typesense connection settings into external search and supplies the requested prompt", async () => {
    const project = await makeProject();
    await writeProjectFile(project, ".llm-wiki/settings.json", JSON.stringify({ localSearchProvider: "typesense", typesenseUrl: settings.webSearchUrl, typesenseApiKey: "legacy-key", typesenseCollection: "existing-web", systemPrompt: "" }));
    const loaded = await readSettings(project);
    expect(loaded).toMatchObject({ localSearchProvider: "builtin", webSearchProvider: "typesense", webSearchUrl: settings.webSearchUrl, webSearchApiKey: "legacy-key", webSearchCollection: "existing-web", systemPrompt: DEFAULT_SETTINGS.systemPrompt });
    await writeSettings(project, { ...loaded, systemPrompt: "我的自定义规则" });
    expect((await readSettings(project)).systemPrompt).toBe("我的自定义规则");
  });
});
