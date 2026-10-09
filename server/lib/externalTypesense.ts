import type { ProjectSettings } from "../types.js";
import type { ExternalSearchResult } from "./webSearch.js";
import { diagnosticError, serviceJson, serviceUrl } from "./serviceHttp.js";
import { textInput, invalidInput } from "./validation.js";
import { firstSourceText, webSourceUrl } from "./externalSources.js";

type Config = { url: string; headers: Record<string, string>; collection: string; queryBy: string };
function config(settings: ProjectSettings, requireCollection = true): Config {
  const url = serviceUrl(settings.webSearchUrl);
  const key = textInput(settings.webSearchApiKey, "Typesense API Key", { required: true, max: 2000 }).trim();
  const collection = textInput(settings.webSearchCollection, "网页索引集合", { required: requireCollection, max: 128, singleLine: true }).trim();
  if (collection && /[\\/?#]/.test(collection)) invalidInput("网页索引集合名称不正确。");
  const queryBy = textInput(settings.webSearchQueryBy, "检索字段", { max: 1000, singleLine: true }).trim();
  if (queryBy && (queryBy.split(",").length > 24 || queryBy.split(",").some((field) => !/^[\p{L}\p{N}_.-]{1,128}$/u.test(field.trim())))) invalidInput("检索字段使用逗号分隔，最多 24 个有效字段名。");
  return { url, collection, queryBy, headers: { "x-typesense-api-key": key } };
}
function schemaUrl(value: Config): string { return `${value.url}/collections/${encodeURIComponent(value.collection)}`; }
async function schemaFields(value: Config): Promise<string[]> {
  const schema = await serviceJson(schemaUrl(value), { headers: value.headers });
  if (!Array.isArray(schema.fields)) throw new Error("Typesense 集合没有返回有效字段结构。");
  const fields = schema.fields.filter((field: any) => field && ["string", "string[]"].includes(field.type) && field.index !== false && typeof field.name === "string" && !["id", "url", "link", "canonical_url", "project_id", "path"].includes(field.name) && !field.name.includes("*")).map((field: any) => field.name as string);
  if (!fields.length) throw new Error("集合没有可检索的文字字段，请选择包含网页正文的集合。");
  const preferred = ["title", "content", "description", "snippet", "text", "body"].filter((field) => fields.includes(field));
  return [...new Set([...preferred, ...fields])].slice(0, 24);
}

export async function discoverExternalTypesense(settings: ProjectSettings): Promise<{ message: string; collections: string[]; queryBy?: string }> {
  // Discovery obtains the schema independently of the manually entered search fields.
  const value = config({ ...settings, webSearchQueryBy: undefined }, false);
  const health = await serviceJson(`${value.url}/health`, { headers: value.headers });
  if (health.ok !== true) throw new Error("Typesense 健康检查未通过。");
  const response = await serviceJson(`${value.url}/collections`, { headers: value.headers });
  if (!Array.isArray(response)) throw new Error("Typesense 集合列表无效。");
  const collections = response.filter((item) => typeof item?.name === "string").map((item) => item.name as string);
  if (!collections.length) return { message: "Typesense 已连接，但没有可用的集合。请确认服务中已有网页资料索引，且当前 API Key 有集合读取权限。", collections };
  const message = `已获取 ${collections.length} 个集合，请选择已有网页资料的索引集合。`;
  if (!value.collection) return { message, collections };
  if (!collections.includes(value.collection)) return { message: `${message} 当前填写的集合不在列表中，请重新选择后获取字段。`, collections };
  try {
    return { message, collections, queryBy: (await schemaFields(value)).join(",") };
  } catch (error) {
    return { message: `${message} 当前集合字段未获取：${diagnosticError(error, [settings.webSearchApiKey]).message} 请检查集合或手动填写检索字段。`, collections };
  }
}

export async function searchExternalTypesense(settings: ProjectSettings, queries: string[], limit: number): Promise<{ results: ExternalSearchResult[]; queryBy: string }> {
  const value = config(settings);
  const queryBy = value.queryBy || (await schemaFields(value)).join(",");
  const results: ExternalSearchResult[] = [];
  let hasDocuments = false;
  for (const query of queries) {
    const params = new URLSearchParams({ q: query, query_by: queryBy, per_page: String(Math.max(1, Math.min(12, limit))) });
    const response = await serviceJson(`${schemaUrl(value)}/documents/search?${params}`, { headers: value.headers });
    if (!Array.isArray(response.hits)) throw new Error("Typesense 搜索没有返回有效的 hits 列表。");
    hasDocuments ||= response.hits.length > 0;
    for (const hit of response.hits.slice(0, limit)) {
      const doc = hit?.document;
      if (!doc || typeof doc !== "object") continue;
      const url = [doc.url, doc.link, doc.canonical_url].map(webSourceUrl).find(Boolean);
      const fieldValues = queryBy.split(",").map((field) => ({ field: field.trim(), value: documentField(doc, field.trim()) }));
      const title = firstSourceText([doc.title, doc.name, ...fieldValues.filter(({ field }) => /(?:^|\.)(?:title|name)$/.test(field)).map(({ value }) => value), query], 300);
      const snippet = firstSourceText([doc.content, doc.description, doc.snippet, doc.text, doc.body, ...fieldValues.filter(({ field }) => !/(?:^|\.)(?:title|name)$/.test(field)).map(({ value }) => value)]);
      if (!url || !title || !snippet) continue;
      results.push({ title, snippet, url });
    }
  }
  if (hasDocuments && !results.length) throw new Error("集合返回了文档，但没有可引用的网页内容。请确认文档包含 HTTP/HTTPS 的 url（或 link、canonical_url）和有效正文。");
  return { results, queryBy };
}
function documentField(document: Record<string, unknown>, field: string): unknown {
  if (Object.hasOwn(document, field)) return document[field];
  return field.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, document);
}
