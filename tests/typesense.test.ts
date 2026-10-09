import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeProject, writeProjectFile } from "./helpers.js";
import { testTypesense, syncTypesenseIndex, searchTypesense } from "../server/lib/typesense.js";
import { DEFAULT_SETTINGS, safeJoin, readSettings, writeSettings, writeSources } from "../server/lib/storage.js";
import { writeWikiFile } from "../server/lib/wiki.js";

afterEach(() => vi.restoreAllMocks());
const config = { ...DEFAULT_SETTINGS, localSearchProvider: "typesense" as const, typesenseUrl: "http://localhost:8108", typesenseApiKey: "local-key" };
const searchProject = async (project: Parameters<typeof searchTypesense>[0], query: string, options: Parameters<typeof searchTypesense>[3] = {}) => searchTypesense(project, await readSettings(project), query, options);
function fakeTypesense(failImport = false) {
  let schema: Record<string, unknown> | null = null;
  const documents = new Map<string, Record<string, any>>();
  let imports = 0, deletes = 0;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input)), method = init?.method || "GET";
    expect(new Headers(init?.headers).get("x-typesense-api-key")).toBe("local-key");
    let data: any;
    if (url.pathname === "/health") data = { ok: true };
    else if (url.pathname === "/collections" && method === "GET") data = schema ? [schema] : [];
    else if (url.pathname === "/collections" && method === "POST") { schema = JSON.parse(String(init?.body)); data = schema; }
    else if (url.pathname.endsWith("/documents/import")) {
      imports++;
      const docs = String(init?.body).split("\n").map((line) => JSON.parse(line));
      for (const doc of docs) if (!failImport) documents.set(doc.id, doc);
      return new Response(docs.map(() => JSON.stringify({ success: !failImport })).join("\n"));
    } else if (url.pathname.endsWith("/documents/search")) {
      expect(url.searchParams.get("filter_by")).toMatch(/^project_id:=[a-f0-9]{24}/);
      const scope = url.searchParams.get("filter_by")!.slice("project_id:=".length, "project_id:=".length + 24);
      const q = url.searchParams.get("q")!;
      data = { hits: [...documents.values()].filter((doc) => doc.project_id === scope && (q === "*" || (doc.title + doc.content).includes(q)) && (!url.searchParams.get("filter_by")!.includes("kind:=wiki") || doc.kind === "wiki")).map((document) => ({ document })) };
    } else if (method === "DELETE") {
      deletes++;
      const ids = url.searchParams.get("filter_by")!.match(/id:=\[([^\]]+)\]/)![1].split(",");
      for (const id of ids) documents.delete(id);
      data = { num_deleted: ids.length };
    } else if (!schema) return new Response("{}", { status: 404 });
    else data = schema;
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  });
  return { fetchMock, documents, get imports() { return imports; }, get deletes() { return deletes; } };
}

describe("legacy Typesense index compatibility (unused by built-in knowledge search)", () => {
  it("indexes UTF-16 Chinese source text without introducing garbled display text", async () => {
    const project = await makeProject(); fakeTypesense(); await writeSettings(project, config);
    const filename = "raw/sources/utf16.txt", text = "股东出资期限需要核实。";
    await fs.writeFile(safeJoin(project.root, filename), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    await writeSources(project, [{ id: "utf16", fileName: "utf16.txt", relativePath: filename, kind: "text", size: 100, sha256: "", title: "公司法", status: "ready", reasons: [], importedAt: "", updatedAt: "" }]);
    const hits = await searchProject(project, "股东出资期限", { includeRaw: true });
    expect(hits[0]?.excerpt).toContain(text);
    expect(hits[0]?.excerpt).not.toContain("\uFFFD");
  });
  it("checks health and authenticated collections instead of trusting unauthenticated health alone", async () => {
    const project = await makeProject();
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response('{"ok":true}')).mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(testTypesense(project, config)).rejects.toThrow("401");
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it("indexes Chinese knowledge, searches via configured Typesense, updates edits and removes deleted documents", async () => {
    const project = await makeProject();
    const fake = fakeTypesense();
    await writeSettings(project, config);
    await writeWikiFile(project, "wiki/concepts/law.md", "---\ntitle: 公司章程\ntype: concept\nsources: [raw/sources/law.txt]\n---\n# 公司章程\n注册资本必须记载。");
    const hits = await searchProject(project, "注册资本");
    expect(hits[0]).toMatchObject({ path: "wiki/concepts/law.md", title: "公司章程", citations: ["raw/sources/law.txt"] });
    const count = fake.imports;
    await searchProject(project, "注册资本"); expect(fake.imports).toBe(count);
    await writeWikiFile(project, "wiki/concepts/law.md", "# 公司章程\n股东人数需要确认。");
    expect(await searchProject(project, "股东人数")).toHaveLength(1);
    expect(await searchProject(project, "注册资本")).toHaveLength(0);
    await fs.unlink(safeJoin(project.root, "wiki/concepts/law.md"));
    await syncTypesenseIndex(project, config, true);
    expect(fake.deletes).toBe(1);
    expect(await searchProject(project, "股东人数")).toHaveLength(0);
  });
  it("isolates projects sharing a collection and returns no documents outside allowed paths", async () => {
    const a = await makeProject(), b = await makeProject();
    const shared = { ...config, typesenseCollection: "shared_wiki" };
    const fake = fakeTypesense();
    await writeSettings(a, shared); await writeSettings(b, shared);
    await writeWikiFile(a, "wiki/a.md", "# 共同词\n项目甲");
    await writeWikiFile(b, "wiki/b.md", "# 共同词\n项目乙");
    await syncTypesenseIndex(a, shared); await syncTypesenseIndex(b, shared);
    const hits = await searchProject(a, "共同词");
    expect(hits.map((hit) => hit.path)).toEqual(["wiki/a.md"]);
    const doc = [...fake.documents.values()].find((item) => item.path === "wiki/a.md")!;
    fake.documents.set("foreign-path", { ...doc, path: "wiki/../../.llm-wiki/settings.json" });
    expect(await searchProject(a, "共同词")).toHaveLength(1);
  });
  it("detects per-document import failure even when Typesense returns HTTP 200", async () => {
    const project = await makeProject(); fakeTypesense(true);
    await writeProjectFile(project, "wiki/test.md", "# 资料\n内容");
    await expect(syncTypesenseIndex(project, config)).rejects.toThrow("部分文档导入失败");
  });
});
