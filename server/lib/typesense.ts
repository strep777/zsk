import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Project, ProjectSettings, SearchHit } from "../types.js";
import { listFiles, readJson, readSources, safeJoin, sourcesPath, toPosix, writeJson } from "./storage.js";
import { extractTitle, markdownPlainText, parseMarkdown, asStringArray } from "./markdown.js";
import { cleanUnknownGlyphRuns, excerptAround } from "./text.js";
import { serviceJson, serviceUrl } from "./serviceHttp.js";
import { searchRevision } from "./searchRevision.js";

type Config = { url: string; apiKey: string; collection: string; projectKey: string; identity: string };
type IndexResult = { message: string; indexed: number; updated: number; deleted: number; collection: string };
type Manifest = { identity: string; files: Record<string, string> };
const syncing = new Map<string, Promise<IndexResult>>();
const synced = new Map<string, { revision: string; time: number; result: IndexResult }>();
const textExtensions = new Set([".txt", ".md", ".markdown", ".html", ".htm", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".log"]);
const fields = [
  { name: "project_id", type: "string", facet: true }, { name: "path", type: "string" },
  { name: "kind", type: "string", facet: true }, { name: "title", type: "string", locale: "zh" },
  { name: "content", type: "string", locale: "zh" }, { name: "type", type: "string" },
  { name: "citations", type: "string[]", optional: true }
];
function hash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
function configuration(project: Project, settings: Partial<ProjectSettings>): Config {
  const url = serviceUrl(settings.typesenseUrl);
  const apiKey = typeof settings.typesenseApiKey === "string" ? settings.typesenseApiKey.trim() : "";
  if (!apiKey) throw Object.assign(new Error("请填写 Typesense API Key，索引同步需要集合和文档的读写权限。"), { status: 400 });
  const projectKey = hash(project.id).slice(0, 24);
  const collection = settings.typesenseCollection?.trim() || `wiki_${projectKey}`;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(collection)) throw Object.assign(new Error("集合名称只能包含字母、数字、下划线和短横线，最多 100 字符。"), { status: 400 });
  return { url, apiKey, collection, projectKey, identity: hash(url + "\n" + apiKey + "\n" + collection) };
}
function headers(config: Config): Record<string, string> { return { "x-typesense-api-key": config.apiKey, "content-type": "application/json" }; }
function collectionUrl(config: Config): string { return `${config.url}/collections/${encodeURIComponent(config.collection)}`; }

export async function testTypesense(project: Project, settings: Partial<ProjectSettings>): Promise<{ message: string; collections: string[]; collection: string }> {
  const config = configuration(project, settings);
  const health = await serviceJson(`${config.url}/health`, { headers: headers(config) });
  if (health.ok !== true) throw new Error("Typesense 健康检查未通过。");
  const list = await serviceJson(`${config.url}/collections`, { headers: headers(config) });
  if (!Array.isArray(list)) throw new Error("Typesense 集合接口返回了无效数据。");
  return { message: "Typesense 连接和 API Key 验证成功；同步索引可进一步验证写入与检索权限。", collections: list.map((item) => item.name).filter((name): name is string => typeof name === "string"), collection: config.collection };
}

async function ensureCollection(config: Config): Promise<boolean> {
  const response = await fetch(collectionUrl(config), { headers: headers(config), signal: AbortSignal.timeout(15000) });
  if (response.status === 404) {
    const created = await serviceJson(`${config.url}/collections`, { method: "POST", headers: headers(config), body: JSON.stringify({ name: config.collection, fields }) });
    if (created.name !== config.collection) throw new Error("Typesense 没有确认集合创建成功。");
    return true;
  }
  if (!response.ok) throw new Error(`Typesense 集合读取失败：HTTP ${response.status}。`);
  const schema = await response.json() as { fields?: typeof fields };
  if (!Array.isArray(schema.fields) || fields.some((required) => !schema.fields!.some((field) => field.name === required.name && field.type === required.type))) {
    throw new Error("所选集合与知识库索引结构不兼容。请使用自动生成的集合名称或填写新的集合名称。");
  }
  return false;
}

export async function syncTypesenseIndex(project: Project, settings: Partial<ProjectSettings>, force = false): Promise<IndexResult> {
  const config = configuration(project, settings), key = project.root + ":" + config.identity;
  const sourceStat = await fs.stat(sourcesPath(project)).catch(() => null);
  const revision = `${sourceStat?.mtimeMs || 0}:${sourceStat?.size || 0}:${searchRevision(project.root)}`;
  const cache = synced.get(key);
  if (!force && cache?.revision === revision && Date.now() - cache.time < 60000) return cache.result;
  const pending = syncing.get(key);
  if (pending) return pending;
  const job = rebuildIndex(project, config, force).then((result) => { synced.set(key, { revision, time: Date.now(), result }); return result; }).finally(() => { syncing.delete(key); });
  syncing.set(key, job);
  return job;
}

async function rebuildIndex(project: Project, config: Config, force: boolean): Promise<IndexResult> {
  const fresh = await ensureCollection(config);
  const manifestPath = safeJoin(project.root, `.llm-wiki/typesense-${config.identity}.json`);
  const previous = await readJson<Manifest>(manifestPath, { identity: "", files: {} });
  const old = !fresh && previous.identity === config.identity ? previous.files : {};
  const next: Record<string, string> = {};
  let batch: Record<string, unknown>[] = [], bytes = 0, updated = 0, deleted = 0;
  const flush = async () => {
    if (!batch.length) return;
    const response = await fetch(`${collectionUrl(config)}/documents/import?action=upsert`, {
      method: "POST", headers: { ...headers(config), "content-type": "text/plain" },
      body: batch.map((doc) => JSON.stringify(doc)).join("\n"), signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Typesense 文档写入失败：HTTP ${response.status}。`);
    const lines = (await response.text()).trim().split("\n").filter(Boolean);
    if (lines.length !== batch.length || lines.some((line) => { try { return JSON.parse(line).success !== true; } catch { return true; } })) {
      throw new Error("Typesense 部分文档导入失败。请检查集合结构、文档大小及服务日志；可再次同步重试。");
    }
    updated += batch.length;
    batch = []; bytes = 0;
  };
  const add = async (relative: string, signature: string, document: () => Promise<Record<string, unknown>>) => {
    const id = hash(project.id + ":" + relative);
    next[id] = signature;
    if (!force && old[id] === signature) return;
    const item = { ...await document(), id, project_id: config.projectKey, path: relative };
    batch.push(item); bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
    if (batch.length >= 40 || bytes > 512000) await flush();
  };
  const wikiRoot = safeJoin(project.root, "wiki");
  const wikiFiles = await listFiles(wikiRoot, { extensions: [".md"] });
  for (const relative of wikiFiles) {
    const publicPath = "wiki/" + toPosix(relative), full = safeJoin(project.root, publicPath);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile()) continue;
    await add(publicPath, `${stat.mtimeMs}:${stat.size}`, async () => {
      const text = await readHead(full), parsed = parseMarkdown(text);
      return { title: cleanUnknownGlyphRuns(extractTitle(text, path.basename(relative))), content: cleanUnknownGlyphRuns(markdownPlainText(text)),
        kind: "wiki", type: String(parsed.frontmatter.type || "wiki"), citations: asStringArray(parsed.frontmatter.sources) };
    });
  }
  for (const source of await readSources(project)) {
    if (source.status === "failed" || source.status === "skipped" || !source.relativePath.startsWith("raw/sources/")) continue;
    const full = safeJoin(project.root, source.relativePath);
    const stat = await fs.stat(full).catch(() => null);
    await add(source.relativePath, hash(JSON.stringify(source) + `:${stat?.mtimeMs || 0}:${stat?.size || 0}`), async () => ({
      title: cleanUnknownGlyphRuns(source.title || source.fileName), kind: "raw", type: "raw", citations: source.wikiPath ? [source.wikiPath] : [],
      content: cleanUnknownGlyphRuns([source.summary || "", stat && textExtensions.has(path.extname(full).toLowerCase()) ? await readHead(full) : ""].join("\n"))
    }));
  }
  await flush();
  const removed = Object.keys(old).filter((id) => !(id in next));
  for (let i = 0; i < removed.length; i += 200) {
    const params = new URLSearchParams({ filter_by: `project_id:=${config.projectKey} && id:=[${removed.slice(i, i + 200).join(",")}]` });
    const result = await serviceJson(`${collectionUrl(config)}/documents?${params}`, { method: "DELETE", headers: headers(config) });
    deleted += result.num_deleted || 0;
  }
  // A real scoped search also validates search permission after import.
  await serviceJson(`${collectionUrl(config)}/documents/search?${new URLSearchParams({ q: "*", query_by: "title,content", filter_by: `project_id:=${config.projectKey}`, per_page: "1" })}`, { headers: headers(config) });
  await writeJson(manifestPath, { identity: config.identity, files: next });
  return { message: `索引同步完成：${Object.keys(next).length} 份文档，更新 ${updated} 份，移除 ${deleted} 份。`, indexed: Object.keys(next).length, updated, deleted, collection: config.collection };
}

async function readHead(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(512000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) {
      return new TextDecoder(buffer[0] === 0xff ? "utf-16le" : "utf-16be").decode(buffer.subarray(0, bytesRead), { stream: bytesRead === buffer.length });
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try { return decoder.decode(buffer.subarray(0, bytesRead), { stream: bytesRead === buffer.length }); }
    catch { return new TextDecoder("gb18030").decode(buffer.subarray(0, bytesRead), { stream: bytesRead === buffer.length }); }
  } finally { await handle.close(); }
}

export async function searchTypesense(project: Project, settings: ProjectSettings, query: string, options: { limit?: number; includeRaw?: boolean }): Promise<SearchHit[]> {
  const config = configuration(project, settings);
  await syncTypesenseIndex(project, settings);
  const params = new URLSearchParams({ q: query.trim(), query_by: "title,content", query_by_weights: "3,1", per_page: String(Math.min(Math.max(options.limit || 12, 1), 100)), num_typos: "0",
    filter_by: `project_id:=${config.projectKey}${options.includeRaw ? "" : " && kind:=wiki"}`, highlight_fields: "none" });
  const result = await serviceJson(`${collectionUrl(config)}/documents/search?${params}`, { headers: headers(config) });
  if (!Array.isArray(result.hits)) throw new Error("Typesense 返回了无效的搜索结果。");
  return result.hits.flatMap((hit: { document?: Record<string, unknown> }, index: number): SearchHit[] => {
    const doc = hit.document;
    if (!doc || doc.project_id !== config.projectKey || typeof doc.path !== "string" || typeof doc.content !== "string" || typeof doc.title !== "string") return [];
    const normalized = path.posix.normalize(doc.path.replace(/\\/g, "/"));
    if (normalized !== doc.path || !["wiki/", "raw/sources/"].some((prefix) => normalized.startsWith(prefix)) || (!options.includeRaw && !normalized.startsWith("wiki/"))) return [];
    return [{ path: normalized, title: cleanUnknownGlyphRuns(doc.title), type: String(doc.type || "wiki"), score: Math.max(1, 100 - index),
      excerpt: excerptAround(cleanUnknownGlyphRuns(doc.content), query, 500), citations: asStringArray(doc.citations) }];
  });
}
