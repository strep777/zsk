import { ProjectSettings } from "../types.js";
import { searchExternalTypesense } from "./externalTypesense.js";
import { firstSourceText, webSourceUrl } from "./externalSources.js";
import { diagnosticError } from "./serviceHttp.js";

export interface ExternalSearchResult {
  title: string;
  url: string;
  snippet: string;
}

const defaultSearchTimeoutMs = readPositiveInteger("LLM_WIKI_WEB_SEARCH_TIMEOUT_MS", 8000);

export async function runExternalSearch(
  settings: ProjectSettings,
  queries: string[],
  options: { limitPerQuery?: number; allowDirectFallback?: boolean } = {}
): Promise<ExternalSearchResult[]> {
  const limitPerQuery = options.limitPerQuery ?? 3;
  const normalizedQueries = queries.map((query) => query.trim()).filter(Boolean).slice(0, 4);
  if (!normalizedQueries.length || settings.webSearchProvider === "none") return [];
  return uniqueResults(await runConfiguredSearch(settings, normalizedQueries, limitPerQuery));
}

async function runConfiguredSearch(
  settings: ProjectSettings,
  queries: string[],
  limitPerQuery: number,
  strict = false
): Promise<ExternalSearchResult[]> {
  try {
    if (settings.webSearchProvider === "typesense") {
      if (!strict && ![settings.webSearchUrl, settings.webSearchApiKey, settings.webSearchCollection, settings.webSearchQueryBy].some((value) => value?.trim())) return [];
      return (await searchExternalTypesense(settings, queries, limitPerQuery)).results;
    }
    if (settings.webSearchProvider === "searxng" && settings.webSearchUrl) {
      return await runSearxngSearch(settings.webSearchUrl, queries, limitPerQuery, settings.webSearchApiKey);
    }
    if (settings.webSearchProvider === "tavily" && settings.webSearchApiKey) {
      return await runTavilySearch(settings.webSearchUrl, settings.webSearchApiKey, queries, limitPerQuery);
    }
    if (settings.webSearchProvider === "serpapi" && settings.webSearchApiKey) {
      return await runSerpApiSearch(settings.webSearchUrl, settings.webSearchApiKey, queries, limitPerQuery);
    }
  } catch (error) {
    if (strict || (settings.webSearchProvider === "typesense" && (error as { status?: number })?.status === 400)) throw error;
    console.warn("[web-search] configured search failed", diagnosticError(error, [settings.webSearchApiKey, settings.typesenseApiKey]).message);
  }
  return [];
}

export async function testExternalSearch(settings: ProjectSettings): Promise<{ message: string; results: number; latencyMs: number; queryBy?: string }> {
  if (settings.webSearchProvider === "typesense") {
    const start = Date.now();
    const result = await searchExternalTypesense(settings, ["*"], 12);
    if (!result.results.length) throw new Error("Typesense 已连接，但当前集合没有可引用的网页内容，无法确认搜索可用。请选择已有网页资料的集合，并检查文档网址与正文字段。");
    return { message: `Typesense 网页搜索测试成功，返回 ${result.results.length} 条可引用结果。`, results: result.results.length, latencyMs: Date.now() - start, queryBy: result.queryBy };
  }
  if (settings.webSearchProvider === "none") throw Object.assign(new Error("外部搜索已关闭；请选择服务后再测试。"), { status: 400 });
  if (settings.webSearchProvider === "searxng" && !settings.webSearchUrl?.trim()) throw Object.assign(new Error("请填写 SearXNG 地址。"), { status: 400 });
  if (settings.webSearchProvider !== "searxng" && !settings.webSearchApiKey?.trim()) throw Object.assign(new Error("请填写搜索 API Key。"), { status: 400 });
  const start = Date.now();
  const results = await runConfiguredSearch(settings, ["连接测试"], 1, true);
  return { message: `搜索接口测试成功，返回 ${results.length} 条结果。`, results: results.length, latencyMs: Date.now() - start };
}

async function runSearxngSearch(
  baseUrl: string,
  queries: string[],
  limitPerQuery: number,
  apiKey?: string
): Promise<ExternalSearchResult[]> {
  const base = baseUrl.replace(/\/$/, "");
  const results: ExternalSearchResult[] = [];
  for (const query of queries) {
    const response = await fetchWithTimeout(`${base.endsWith("/search") ? base : base + "/search"}?q=${encodeURIComponent(query)}&format=json`, apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {});
    if (!response.ok) throw new Error(`搜索接口请求失败：HTTP ${response.status}。`);
    const json = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    results.push(...validatedResults(json?.results, query, limitPerQuery, "url", "content"));
  }
  return results;
}

async function runTavilySearch(
  baseUrl: string | undefined,
  apiKey: string,
  queries: string[],
  limitPerQuery: number
): Promise<ExternalSearchResult[]> {
  const endpoint = (baseUrl || "https://api.tavily.com/search").replace(/\/$/, "");
  const results: ExternalSearchResult[] = [];
  for (const query of queries) {
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: limitPerQuery
      })
    });
    if (!response.ok) throw new Error(`搜索接口请求失败：HTTP ${response.status}。`);
    const json = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    results.push(...validatedResults(json?.results, query, limitPerQuery, "url", "content"));
  }
  return results;
}

async function runSerpApiSearch(
  baseUrl: string | undefined,
  apiKey: string,
  queries: string[],
  limitPerQuery: number
): Promise<ExternalSearchResult[]> {
  const base = (baseUrl || "https://serpapi.com/search.json").replace(/\/$/, "");
  const results: ExternalSearchResult[] = [];
  for (const query of queries) {
    const url = new URL(base);
    url.searchParams.set("engine", url.searchParams.get("engine") || "google");
    url.searchParams.set("q", query);
    url.searchParams.set("api_key", apiKey);
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`搜索接口请求失败：HTTP ${response.status}。`);
    const json = (await response.json()) as {
      organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
    };
    if (json && "error" in json) throw new Error("搜索服务报告错误，请检查密钥、额度或查询参数。");
    results.push(...validatedResults(json?.organic_results, query, limitPerQuery, "link", "snippet"));
  }
  return results;
}

function validatedResults(payload: unknown, query: string, limit: number, urlField: string, textField: string): ExternalSearchResult[] {
  if (!Array.isArray(payload)) throw new Error("搜索接口未返回有效的结果列表。");
  const results: ExternalSearchResult[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const url = webSourceUrl(item[urlField]);
    const title = firstSourceText([item.title, query], 300);
    const snippet = firstSourceText([item[textField]]);
    if (url && title && snippet) results.push({ title, url, snippet });
    if (results.length >= limit) break;
  }
  if (payload.length && !results.length) throw new Error("搜索返回了结果，但没有可引用的有效网页内容，请检查网址、正文和文本编码。");
  return results;
}

async function fetchWithTimeout(input: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(defaultSearchTimeoutMs) });
}

function uniqueResults(results: ExternalSearchResult[]): ExternalSearchResult[] {
  const byUrl = new Map<string, ExternalSearchResult>();
  for (const result of results) {
    if (!webSourceUrl(result.url)) continue;
    const existing = byUrl.get(result.url);
    if (!existing || (!existing.snippet && result.snippet)) byUrl.set(result.url, result);
  }
  return [...byUrl.values()].slice(0, 12);
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
