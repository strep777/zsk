import fs from "node:fs/promises";
import path from "node:path";
import { AnalysisResult, Project, WikiFile } from "../types.js";
import {
  asStringArray,
  extractTitle,
  extractWikiLinks,
  normalizeWikiPath,
  parseMarkdown,
  serializeMarkdown
} from "./markdown.js";
import { fileBaseName, slugify } from "./slug.js";
import { cleanUnknownGlyphRuns, readableTextOrFallback } from "./text.js";
import { compactDate, nowIso } from "./time.js";
import { listFiles, readText, safeJoin, toPosix, writeText } from "./storage.js";

interface WikiAsset {
  relativePath: string;
  fileName: string;
  mediaType: string;
}

interface TopicIndex {
  concepts: Map<string, string>;
  entities: Map<string, string>;
}

interface TopicNoteState {
  seen: Set<string>;
  count: number;
}

export interface ListWikiFilesOptions {
  limit?: number;
  offset?: number;
  query?: string;
  includeTotal?: boolean;
}

export interface WikiFilePage {
  files: WikiFile[];
  total: number;
  offset: number;
  limit?: number;
}

const topicIndexCache = new Map<string, Promise<TopicIndex>>();
const topicNoteCache = new Map<string, Promise<TopicNoteState>>();
const maxTopicNotes = readNonNegativeInteger("LLM_WIKI_MAX_TOPIC_NOTES", 3000);
const maxWikiMetadataBytes = readPositiveInteger("LLM_WIKI_METADATA_BYTES", 256 * 1024);
const maxIndexFiles = readPositiveInteger("LLM_WIKI_MAX_INDEX_FILES", 2000);
const maxOverviewFiles = readPositiveInteger("LLM_WIKI_MAX_OVERVIEW_FILES", 2000);
const maxTopicIndexFiles = readPositiveInteger("LLM_WIKI_MAX_TOPIC_INDEX_FILES", 5000);

export async function listWikiFiles(project: Project, options: ListWikiFilesOptions = {}): Promise<WikiFile[]> {
  return (await listWikiFilesPage(project, options)).files;
}

export async function listWikiFilesPage(
  project: Project,
  options: ListWikiFilesOptions = {}
): Promise<WikiFilePage> {
  const root = path.join(project.root, "wiki");
  const query = options.query?.trim().toLowerCase();
  const canStopEarly = Boolean(options.limit && !options.offset && !query && !options.includeTotal);
  const allFiles = await listFiles(root, { extensions: [".md"], limit: canStopEarly ? options.limit : undefined });
  const filtered = query ? allFiles.filter((relative) => relative.toLowerCase().includes(query)) : allFiles;
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : undefined;
  const page = limit ? filtered.slice(offset, offset + limit) : filtered.slice(offset);
  const files = await Promise.all(
    page.map(async (relative) => {
      const wikiPath = normalizeWikiPath(path.posix.join("wiki", relative));
      const fullPath = safeJoin(project.root, wikiPath);
      const stat = await fs.stat(fullPath);
      const content = await readTextHead(fullPath, maxWikiMetadataBytes);
      const parsed = parseMarkdown(content);
      const sources = uniqueStrings([...asStringArray(parsed.frontmatter.sources), ...extractInlineSourcePaths(content)]);
      return {
        path: wikiPath,
        title: extractTitle(content, fileBaseName(path.basename(relative))),
        type: typeof parsed.frontmatter.type === "string" ? parsed.frontmatter.type : inferType(relative),
        tags: asStringArray(parsed.frontmatter.tags),
        sources,
        links: extractWikiLinks(content),
        size: stat.size,
        mtime: stat.mtime.toISOString()
      };
    })
  );
  return {
    files,
    total: canStopEarly ? files.length : filtered.length,
    offset,
    limit
  };
}

export async function readWikiFile(project: Project, relativePath: string): Promise<string> {
  const normalized = normalizeWikiPath(relativePath);
  if (!normalized.startsWith("wiki/") && !["purpose.md", "schema.md"].includes(normalized)) {
    throw Object.assign(new Error("Only wiki, purpose, and schema files are readable through this endpoint."), {
      status: 400
    });
  }
  return readText(safeJoin(project.root, normalized));
}

export async function writeWikiFile(project: Project, relativePath: string, content: string): Promise<void> {
  const normalized = normalizeWikiPath(relativePath);
  if (!normalized.startsWith("wiki/") && !["purpose.md", "schema.md"].includes(normalized)) {
    throw Object.assign(new Error("Only wiki, purpose, and schema files are writable through this endpoint."), {
      status: 400
    });
  }
  await writeText(safeJoin(project.root, normalized), content);
  topicIndexCache.delete(project.id);
  topicNoteCache.delete(noteCacheKey(project, normalized));
}

export async function writeSourcePage(
  project: Project,
  input: {
    analysis: AnalysisResult;
    sourcePath: string;
    sourceId: string;
    sha256: string;
    kind: string;
    excerpt: string;
    convertedPath?: string;
    assets?: WikiAsset[];
    warnings?: string[];
    wikiPath?: string;
  }
): Promise<string> {
  const title = readableTextOrFallback(input.analysis.title, "未命名来源");
  const summary = cleanUnknownGlyphRuns(input.analysis.summary);
  const wikiPath = input.wikiPath || `wiki/sources/${await uniqueSlug(project, "wiki/sources", title)}.md`;
  const convertedSection = input.convertedPath
    ? ["", "## 全文 Markdown", "", `- [[${input.convertedPath}|打开转换后的 Markdown 全文]]`]
    : [];
  const assetSection = input.assets?.length
    ? ["", "## 抽取资产", "", ...input.assets.map((asset) => `- ${asset.mediaType}: \`${asset.relativePath}\``)]
    : [];
  const warningSection = input.warnings?.length
    ? ["", "## 转换提示", "", ...input.warnings.map((warning) => `- ${warning}`)]
    : [];
  const body = [
    `# ${title}`,
    "",
    `> 来源文件：\`${input.sourcePath}\``,
    "",
    "## 摘要",
    "",
    summary,
    "",
    "## 关键要点",
    "",
    ...asBulletList(input.analysis.keyPoints.map(cleanUnknownGlyphRuns)),
    "",
    "## 相关概念",
    "",
    ...asBulletList(input.analysis.concepts.map((item) => `[[${readableTextOrFallback(item, "未命名概念")}]]`)),
    "",
    "## 相关实体",
    "",
    ...asBulletList(input.analysis.entities.map((item) => `[[${readableTextOrFallback(item, "未命名实体")}]]`)),
    "",
    "## 待追问",
    "",
    ...asBulletList(input.analysis.questions.map(cleanUnknownGlyphRuns)),
    ...convertedSection,
    ...assetSection,
    ...warningSection,
    "",
    "## 摘录",
    "",
    blockquote(cleanUnknownGlyphRuns(input.excerpt))
  ].join("\n");

  await writeText(
    safeJoin(project.root, wikiPath),
    serializeMarkdown(
      {
        title,
        type: "source",
        source_id: input.sourceId,
        source_path: input.sourcePath,
        source_sha256: input.sha256,
        kind: input.kind,
        tags: ["source", input.kind],
        sources: [input.sourcePath],
        confidence: input.analysis.confidence,
        created: nowIso(),
        updated: nowIso()
      },
      body
    )
  );
  return wikiPath;
}

export async function writeConvertedSourcePage(
  project: Project,
  input: {
    title: string;
    sourcePath: string;
    sourceId: string;
    sha256: string;
    kind: string;
    markdown: string;
    assets: WikiAsset[];
    warnings: string[];
    existingPath?: string;
  }
): Promise<string> {
  const pageTitle = `${readableTextOrFallback(input.title, "未命名来源")} Markdown`;
  const wikiPath =
    input.existingPath || `wiki/sources/converted/${await uniqueSlug(project, "wiki/sources/converted", pageTitle)}.md`;
  const assetSection = input.assets.length
    ? ["", "## 抽取资产", "", ...input.assets.map((asset) => `- ${asset.mediaType}: \`${asset.relativePath}\``)]
    : [];
  const warningSection = input.warnings.length
    ? ["", "## 转换提示", "", ...input.warnings.map((warning) => `- ${warning}`)]
    : [];
  const body = [
    `# ${pageTitle}`,
    "",
    `> 来源文件：\`${input.sourcePath}\``,
    ...assetSection,
    ...warningSection,
    "",
    "## 转换正文",
    "",
    cleanUnknownGlyphRuns(input.markdown)
  ].join("\n");

  await writeText(
    safeJoin(project.root, wikiPath),
    serializeMarkdown(
      {
        title: pageTitle,
        type: "source_extract",
        source_id: input.sourceId,
        source_path: input.sourcePath,
        source_sha256: input.sha256,
        kind: input.kind,
        tags: ["source", "converted", input.kind],
        sources: [input.sourcePath],
        created: nowIso(),
        updated: nowIso()
      },
      body
    )
  );
  return wikiPath;
}

export async function upsertConceptPages(
  project: Project,
  concepts: string[],
  sourceWikiPath: string,
  sourceTitle: string,
  summary: string
): Promise<string[]> {
  const written: string[] = [];
  for (const concept of concepts) {
    const safeConcept = readableTextOrFallback(concept, "");
    if (!safeConcept) continue;
    const wikiPath = await findOrCreateTopicPage(project, "concepts", safeConcept, "concept");
    await appendSourceNote(project, wikiPath, sourceWikiPath, sourceTitle, cleanUnknownGlyphRuns(summary));
    written.push(wikiPath);
  }
  return written;
}

export async function upsertEntityPages(
  project: Project,
  entities: string[],
  sourceWikiPath: string,
  sourceTitle: string,
  summary: string
): Promise<string[]> {
  const written: string[] = [];
  for (const entity of entities) {
    const safeEntity = readableTextOrFallback(entity, "");
    if (!safeEntity) continue;
    const wikiPath = await findOrCreateTopicPage(project, "entities", safeEntity, "entity");
    await appendSourceNote(project, wikiPath, sourceWikiPath, sourceTitle, cleanUnknownGlyphRuns(summary));
    written.push(wikiPath);
  }
  return written;
}

export async function updateIndex(project: Project): Promise<void> {
  const files = await listWikiFiles(project, { limit: maxIndexFiles });
  const recent = files
    .filter((file) => file.type !== "index" && file.path !== "wiki/log.md")
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, 20);
  const concepts = files.filter((file) => file.type === "concept").slice(0, 25);
  const sources = files.filter((file) => file.type === "source").slice(0, 25);

  const body = [
    "# 知识库索引",
    "",
    "## 最近更新",
    "",
    ...asBulletList(recent.map((file) => `[[${file.title}]] - ${file.type}`)),
    "",
    "## 概念",
    "",
    ...asBulletList(concepts.map((file) => `[[${file.title}]]`)),
    "",
    "## 来源",
    "",
    ...asBulletList(sources.map((file) => `[[${file.title}]]`))
  ].join("\n");

  await writeText(
    safeJoin(project.root, "wiki/index.md"),
    serializeMarkdown(
      {
        title: "知识库索引",
        type: "index",
        tags: ["index"],
        sources: sources.map((file) => file.path),
        updated: nowIso()
      },
      body
    )
  );
}

export async function updateOverview(project: Project): Promise<void> {
  const files = await listWikiFiles(project, { limit: maxOverviewFiles });
  const sourceFiles = files.filter((file) => file.type === "source").sort((a, b) => b.mtime.localeCompare(a.mtime));
  const conceptFiles = files.filter((file) => file.type === "concept");
  const sourceSummaries = await Promise.all(
    sourceFiles.slice(0, 12).map(async (file) => {
      const content = await readText(safeJoin(project.root, file.path));
      const summary = content.match(/## 摘要\s+([\s\S]*?)(?:\n## |\n# |$)/)?.[1]?.trim();
      return `- [[${file.title}]]: ${(summary || "").replace(/\s+/g, " ").slice(0, 180)}`;
    })
  );

  const body = [
    "# 知识库总览",
    "",
    `最近更新：${nowIso()}`,
    "",
    "## 当前结构",
    "",
    `- 来源页：${sourceFiles.length}`,
    `- 概念页：${conceptFiles.length}`,
    "",
    "## 最近来源摘要",
    "",
    ...(sourceSummaries.length ? sourceSummaries : ["_还没有来源。_"])
  ].join("\n");

  await writeText(
    safeJoin(project.root, "wiki/overview.md"),
    serializeMarkdown(
      {
        title: "知识库总览",
        type: "synthesis",
        tags: ["overview"],
        sources: sourceFiles.slice(0, 50).map((file) => file.path),
        updated: nowIso()
      },
      body
    )
  );
}

export async function appendLog(project: Project, entry: string): Promise<void> {
  const logPath = safeJoin(project.root, "wiki/log.md");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `\n- ${compactDate()}: ${entry}\n`, "utf8");
}

export async function saveQueryAnswer(
  project: Project,
  query: string,
  answer: string,
  citations: string[]
): Promise<string> {
  const safeQuery = readableTextOrFallback(query, "无法识别的问题");
  const safeAnswer = cleanUnknownGlyphRuns(answer);
  const slug = await uniqueSlug(project, "wiki/queries", safeQuery);
  const wikiPath = `wiki/queries/${slug}.md`;
  await writeText(
    safeJoin(project.root, wikiPath),
    serializeMarkdown(
      {
        title: safeQuery,
        type: "query",
        tags: ["query"],
        sources: citations,
        created: nowIso()
      },
      [`# ${safeQuery}`, "", safeAnswer, "", "## 引用", "", ...asBulletList(citations)].join("\n")
    )
  );
  await updateIndex(project);
  return wikiPath;
}

export function titleToWikiLinkMap(files: WikiFile[]): Map<string, WikiFile> {
  const map = new Map<string, WikiFile>();
  for (const file of files) {
    map.set(file.title.toLowerCase(), file);
    map.set(file.path.toLowerCase(), file);
    map.set(file.path.replace(/^wiki\//, "").replace(/\.md$/, "").toLowerCase(), file);
  }
  return map;
}

async function findOrCreateTopicPage(
  project: Project,
  directory: "concepts" | "entities",
  title: string,
  type: "concept" | "entity"
): Promise<string> {
  const index = await getTopicIndex(project);
  const topics = type === "concept" ? index.concepts : index.entities;
  const key = topicKey(title);
  const existing = topics.get(key);
  if (existing) return existing;

  const slug = await uniqueSlug(project, `wiki/${directory}`, title);
  const wikiPath = `wiki/${directory}/${slug}.md`;
  await writeText(
    safeJoin(project.root, wikiPath),
    serializeMarkdown(
      {
        title,
        type,
        tags: [type],
        sources: [],
        created: nowIso(),
        updated: nowIso()
      },
      [`# ${title}`, "", "## 定义", "", "_等待更多来源沉淀。_", "", "## 来源笔记"].join("\n")
    )
  );
  topicNoteCache.set(noteCacheKey(project, wikiPath), Promise.resolve({ seen: new Set(), count: 0 }));
  topics.set(key, wikiPath);
  return wikiPath;
}

async function getTopicIndex(project: Project): Promise<TopicIndex> {
  const cached = topicIndexCache.get(project.id);
  if (cached) return cached;

  const promise = listWikiFiles(project, { limit: maxTopicIndexFiles })
    .then((files) => {
      const concepts = new Map<string, string>();
      const entities = new Map<string, string>();
      for (const file of files) {
        if (file.type === "concept") concepts.set(topicKey(file.title), file.path);
        if (file.type === "entity") entities.set(topicKey(file.title), file.path);
      }
      return { concepts, entities };
    })
    .catch((error) => {
      topicIndexCache.delete(project.id);
      throw error;
    });
  topicIndexCache.set(project.id, promise);
  return promise;
}

function topicKey(title: string): string {
  return title.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

async function appendSourceNote(
  project: Project,
  wikiPath: string,
  sourceWikiPath: string,
  sourceTitle: string,
  summary: string
): Promise<void> {
  const fullPath = safeJoin(project.root, wikiPath);
  const state = await getTopicNoteState(project, wikiPath);
  if (state.seen.has(sourceWikiPath) || state.seen.has(sourceTitle)) return;
  if (maxTopicNotes > 0 && state.count >= maxTopicNotes) return;

  await fs.appendFile(
    fullPath,
    [
      "",
      "",
      `### ${sourceTitle}`,
      "",
      `来源：[[${sourceTitle}]]`,
      `来源路径：\`${sourceWikiPath}\``,
      "",
      summary
    ].join("\n"),
    "utf8"
  );

  state.seen.add(sourceWikiPath);
  state.seen.add(sourceTitle);
  state.count += 1;
}

async function getTopicNoteState(project: Project, wikiPath: string): Promise<TopicNoteState> {
  const key = noteCacheKey(project, wikiPath);
  const cached = topicNoteCache.get(key);
  if (cached) return cached;

  const promise = readText(safeJoin(project.root, wikiPath))
    .then((content) => {
      const parsed = parseMarkdown(content);
      const seen = new Set(asStringArray(parsed.frontmatter.sources));
      for (const match of content.matchAll(/^###\s+(.+)$/gm)) {
        seen.add(match[1].trim());
      }
      for (const match of content.matchAll(/来源路径：`([^`]+)`/g)) {
        seen.add(match[1].trim());
      }
      return {
        seen,
        count: [...content.matchAll(/^###\s+/gm)].length
      };
    })
    .catch((error) => {
      topicNoteCache.delete(key);
      throw error;
    });
  topicNoteCache.set(key, promise);
  return promise;
}

function noteCacheKey(project: Project, wikiPath: string): string {
  return `${project.id}:${wikiPath}`;
}

function extractInlineSourcePaths(content: string): string[] {
  return [...content.matchAll(/来源路径：`([^`]+)`/g)].map((match) => match[1].trim()).filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function uniqueSlug(project: Project, directory: string, title: string): Promise<string> {
  const base = slugify(title, "page");
  let candidate = base;
  let index = 2;
  while (true) {
    const wikiPath = `${directory}/${candidate}.md`;
    try {
      await fs.access(safeJoin(project.root, wikiPath));
      candidate = `${base}-${index++}`;
    } catch {
      return candidate;
    }
  }
}

function inferType(relativePath: string): string {
  if (relativePath.startsWith("sources/converted/")) return "source_extract";
  if (relativePath.startsWith("sources/")) return "source";
  if (relativePath.startsWith("concepts/")) return "concept";
  if (relativePath.startsWith("entities/")) return "entity";
  if (relativePath.startsWith("queries/")) return "query";
  if (relativePath.startsWith("research/")) return "research";
  return "note";
}

function asBulletList(items: string[]): string[] {
  return items.length ? items.map((item) => `- ${item}`) : ["_暂无_"];
}

function blockquote(input: string): string {
  return input
    .split("\n")
    .filter(Boolean)
    .slice(0, 24)
    .map((line) => `> ${line}`)
    .join("\n");
}

async function readTextHead(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const result = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function readNonNegativeInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
