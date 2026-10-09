import fs from "node:fs/promises";
import { invalidateSearch } from "./searchRevision.js";
import { invalidInput, textInput } from "./validation.js";
import { withResourceLock } from "./locks.js";
import path from "node:path";
import { AnalysisResult, Project, WikiFile } from "../types.js";
import {
  asStringArray,
  extractTitle,
  extractWikiLinks,
  mergeUnique,
  normalizeWikiPath,
  parseMarkdown,
  serializeMarkdown
} from "./markdown.js";
import { fileBaseName, slugify } from "./slug.js";
import {
  cleanTitleCandidate,
  cleanUnknownGlyphRuns,
  deriveReadableTitleFromText,
  extractContentParagraphs,
  isLowInformationTopicLabel,
  readableTextOrFallback,
  readableUrlTitle
} from "./text.js";
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
  limited?: boolean;
}

const topicIndexCache = new Map<string, Promise<TopicIndex>>();
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
  const rawFiles = await listFiles(root, {
    extensions: [".md"],
    limit: canStopEarly && options.limit ? options.limit + 1 : undefined
  });
  rawFiles.sort((a, b) => Number(a.includes("/")) - Number(b.includes("/")) || a.localeCompare(b, "zh-CN"));
  const limited = Boolean(canStopEarly && options.limit && rawFiles.length > options.limit);
  const allFiles = limited && options.limit ? rawFiles.slice(0, options.limit) : rawFiles;
  const filtered = query ? allFiles.filter((relative) => relative.toLowerCase().includes(query)) : allFiles;
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : undefined;
  const page = limit ? filtered.slice(offset, offset + limit) : filtered.slice(offset);
  const metadata = await Promise.all(
    page.map(async (relative) => {
      const wikiPath = normalizeWikiPath(path.posix.join("wiki", relative));
      const fullPath = safeJoin(project.root, wikiPath);
      let stat;
      let content: string;
      try {
        stat = await fs.stat(fullPath);
        content = await readTextHead(fullPath, maxWikiMetadataBytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const parsed = parseMarkdown(content);
      const sources = uniqueStrings([...asStringArray(parsed.frontmatter.sources), ...extractInlineSourcePaths(content)]);
      const type = typeof parsed.frontmatter.type === "string" ? parsed.frontmatter.type : inferType(relative);
      const rawTitle = extractTitle(content, fileBaseName(path.basename(relative)));
      return {
        path: wikiPath,
        title: wikiDisplayTitle(rawTitle, type, content, wikiPath),
        type,
        tags: asStringArray(parsed.frontmatter.tags),
        sources,
        links: extractWikiLinks(content),
        size: stat.size,
        mtime: stat.mtime.toISOString()
      };
    })
  );
  const files = metadata.filter((file): file is NonNullable<typeof file> => file !== null);
  return {
    files,
    total: canStopEarly ? files.length : filtered.length - (metadata.length - files.length),
    offset,
    limit,
    limited
  };
}

export async function readWikiFile(project: Project, relativePath: string): Promise<string> {
  const normalized = path.posix.normalize(normalizeWikiPath(relativePath));
  if (!normalized.startsWith("wiki/")) {
    throw Object.assign(new Error("Only wiki files are readable through this endpoint."), {
      status: 400
    });
  }
  return withReadableWikiTitle(normalized, await readText(safeJoin(project.root, normalized)));
}

export async function writeWikiFile(project: Project, relativePath: string, content: string): Promise<void> {
  textInput(relativePath, "文件路径", { required: true, max: 2000, singleLine: true });
  textInput(content, "文档内容", { max: 10 * 1024 * 1024 });
  const normalized = path.posix.normalize(normalizeWikiPath(relativePath));
  if (!normalized.startsWith("wiki/")) {
    throw Object.assign(new Error("Only wiki files are writable through this endpoint."), {
      status: 400
    });
  }
  if (!/\.md$/i.test(normalized)) invalidInput("只能编辑 Markdown（.md）文档，不能覆盖其他文件。");
  for (const segment of normalized.split("/")) {
    if (/[<>:"|?*]/u.test(segment) || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) || Buffer.byteLength(segment, "utf8") > 240) invalidInput("文件路径包含系统保留名称、非法字符或超长文件名。");
  }
  await withResourceLock(`${project.root}:topic-note:${normalized}`, () => writeText(safeJoin(project.root, normalized), content));
  invalidateSearch(project.root);
  topicIndexCache.delete(project.id);
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
  const updated = nowIso();
  const created = await existingCreatedAt(project, wikiPath, updated);
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
        created,
        updated
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
  const updated = nowIso();
  const created = await existingCreatedAt(project, wikiPath, updated);
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
        created,
        updated
      },
      body
    )
  );
  return wikiPath;
}

async function existingCreatedAt(project: Project, wikiPath: string, fallback: string): Promise<string> {
  try {
    const parsed = parseMarkdown(await readText(safeJoin(project.root, wikiPath)));
    const created = parsed.frontmatter.created;
    return typeof created === "string" && created.trim() ? created.trim() : fallback;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function upsertConceptPages(
  project: Project,
  concepts: string[],
  sourceWikiPath: string,
  sourceTitle: string,
  summary: string
): Promise<string[]> {
  const written: string[] = [];
  const seen = new Set<string>();
  const evidence = await sourceEvidence(project, sourceWikiPath, summary, sourceTitle);
  for (const concept of concepts) {
    const safeConcept = readableTextOrFallback(concept, "");
    if (!safeConcept || isLowInformationTopicLabel(safeConcept) || seen.has(topicKey(safeConcept))) continue;
    seen.add(topicKey(safeConcept));
    const wikiPath = await withResourceLock(`${project.root}:topic-create:concept:${topicKey(safeConcept)}`, () => findOrCreateTopicPage(project, "concepts", safeConcept, "concept"));
    await appendSourceNote(project, wikiPath, sourceWikiPath, sourceTitle, evidence);
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
  const seen = new Set<string>();
  const evidence = await sourceEvidence(project, sourceWikiPath, summary, sourceTitle);
  for (const entity of entities) {
    const safeEntity = readableTextOrFallback(entity, "");
    if (!safeEntity || isLowInformationTopicLabel(safeEntity) || seen.has(topicKey(safeEntity))) continue;
    seen.add(topicKey(safeEntity));
    const wikiPath = await withResourceLock(`${project.root}:topic-create:entity:${topicKey(safeEntity)}`, () => findOrCreateTopicPage(project, "entities", safeEntity, "entity"));
    await appendSourceNote(project, wikiPath, sourceWikiPath, sourceTitle, evidence);
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
    ...asBulletList(recent.map((file) => `${fileWikiLink(file)} - ${file.type}`)),
    "",
    "## 概念",
    "",
    ...asBulletList(concepts.map(fileWikiLink)),
    "",
    "## 来源",
    "",
    ...asBulletList(sources.map(fileWikiLink))
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
      return `- ${fileWikiLink(file)}: ${(summary || "").replace(/\s+/g, " ").slice(0, 180)}`;
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
  await fs.writeFile(logPath, serializeMarkdown({ title: "摄入日志", type: "log", tags: ["log"], sources: [] }, "# 摄入日志"), { encoding: "utf8", flag: "wx" }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  await fs.appendFile(logPath, `\n- ${compactDate()}: ${entry}\n`, "utf8");
}

export async function saveQueryAnswer(
  project: Project,
  query: string,
  answer: string,
  citations: string[]
): Promise<string> {
  return withResourceLock(`${project.root}:query-output`, () => saveQueryAnswerLocked(project, query, answer, citations));
}

async function saveQueryAnswerLocked(project: Project, query: string, answer: string, citations: string[]): Promise<string> {
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
    map.set(file.path.split("/").pop()!.replace(/\.md$/, "").toLowerCase(), file);
  }
  return map;
}

export async function removeSourceEvidence(project: Project, removedPaths: string[]): Promise<void> {
  const removed = new Set(removedPaths);
  for (const directory of ["concepts", "entities"]) {
    for (const relative of await listFiles(safeJoin(project.root, `wiki/${directory}`), { extensions: [".md"] })) {
      const wikiPath = `wiki/${directory}/${toPosix(relative)}`;
      const original = await readText(safeJoin(project.root, wikiPath));
      const parsed = parseMarkdown(original);
      // Only remove generated source-note blocks. Other headings and user text remain.
      let body = parsed.body.replace(sourceNotePattern(), (block, _heading: string, sourcePath: string) => removed.has(sourcePath) ? "" : block)
        .replace(/<!-- generated-topic-description:start -->[\s\S]*?来源定义路径：`([^`]+)`[\s\S]*?<!-- generated-topic-description:end -->/g,
          (block, sourcePath: string) => removed.has(sourcePath) ? "_当前已引用来源没有提供可用的正文说明。_" : block);
      for (const note of body.matchAll(sourceNotePattern())) {
        const evidence = topicEvidence(String(parsed.frontmatter.title || ""), analysisSummaryEvidence(note[3], note[1]));
        if (evidence.length) { body = fillTopicDescription(body, String(parsed.frontmatter.title || ""), note[2], note[1], evidence); break; }
      }
      const sources = asStringArray(parsed.frontmatter.sources).filter((source) => !removed.has(source));
      if (body !== parsed.body || sources.length !== asStringArray(parsed.frontmatter.sources).length) {
        await writeWikiFile(project, wikiPath, serializeMarkdown({ ...parsed.frontmatter, sources, updated: nowIso() }, body));
      }
    }
  }
}

function withReadableWikiTitle(relativePath: string, content: string): string {
  const parsed = parseMarkdown(content);
  const rawTitle = extractTitle(content, fileBaseName(path.basename(relativePath)));
  const type = typeof parsed.frontmatter.type === "string" ? parsed.frontmatter.type : inferType(relativePath.replace(/^wiki\//, ""));
  const displayTitle = wikiDisplayTitle(rawTitle, type, content, relativePath);
  if (displayTitle === rawTitle) return content;

  const aliases = mergeUnique(asStringArray(parsed.frontmatter.aliases), [rawTitle]).filter(Boolean);
  return serializeMarkdown(
    {
      ...parsed.frontmatter,
      title: displayTitle,
      aliases
    },
    replaceTopHeading(parsed.body, displayTitle)
  );
}

function wikiDisplayTitle(rawTitle: string, type: string, content: string, relativePath = ""): string {
  const readableRawTitle = readableTextOrFallback(rawTitle, "");
  if (readableRawTitle && !isLowInformationTopicLabel(readableRawTitle)) return readableRawTitle;

  const sourceTitles = extractSourceNoteTitles(content).filter((title) => !isLowInformationTopicLabel(title));
  if (type === "concept" || type === "entity") {
    if (!sourceTitles.length) {
      const derived = deriveWikiFallbackTitle(content, relativePath);
      if (derived) return `${derived}（${rawTitle}）`;
      return `${type === "concept" ? "未命名概念" : "未命名实体"}（${rawTitle}）`;
    }
    const first = sourceTitles[0];
    if (sourceTitles.length === 1) return `${first}（${rawTitle}）`;
    return `${first}等 ${sourceTitles.length} 个来源（${rawTitle}）`;
  }

  const derived = deriveWikiFallbackTitle(content, relativePath);
  if (derived) return derived;
  const sectionName = type === "query" ? "查询" : type === "research" ? "研究" : type === "source" ? "来源" : "页面";
  return `${sectionName}（${rawTitle}）`;
}

function deriveWikiFallbackTitle(content: string, relativePath: string): string {
  const url = content.match(/\bhttps?:\/\/[^\s)>\]]+/i)?.[0];
  if (url) {
    const label = readableUrlTitle(url);
    if (label && !isLowInformationTopicLabel(label)) return label;
  }

  const sourcePath = content.match(/(?:来源文件|来源路径|source_path)[:：]?\s*[`'"]?([^`'"\n]+)/i)?.[1]?.trim();
  if (sourcePath) {
    const base = cleanTitleCandidate(fileBaseName(path.basename(sourcePath.replace(/\\/g, "/"))));
    if (base && !isLowInformationTopicLabel(base)) return base;
  }

  const derived = deriveReadableTitleFromText(content, "");
  if (derived && !isLowInformationTopicLabel(derived)) return derived;

  const pathBase = cleanTitleCandidate(fileBaseName(path.basename(relativePath)));
  if (pathBase && !isLowInformationTopicLabel(pathBase)) return pathBase;
  return "";
}

function extractSourceNoteTitles(content: string): string[] {
  const titles = [
    ...[...content.matchAll(/^###\s+(.+)$/gm)].map((match) => match[1]),
    ...[...content.matchAll(/来源：\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match) => match[1])
  ];
  return uniqueStrings(titles.map((title) => readableTextOrFallback(title.replace(/`/g, "").trim(), ""))).slice(0, 8);
}

function replaceTopHeading(body: string, title: string): string {
  if (/^#\s+.+$/m.test(body)) return body.replace(/^#\s+.+$/m, `# ${title}`);
  return `# ${title}\n\n${body.trim()}`;
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
  evidence: string[]
): Promise<void> {
  await withResourceLock(`${project.root}:topic-note:${wikiPath}`, async () => {
    const fullPath = safeJoin(project.root, wikiPath);
    const original = await readText(fullPath);
    const parsed = parseMarkdown(original);
    const notes = [...parsed.body.matchAll(sourceNotePattern())];
    if (!notes.some((note) => note[2] === sourceWikiPath) && maxTopicNotes > 0 && notes.length >= maxTopicNotes) return;
    const title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : extractTitle(original, "");
    const body = mergeTopicEvidence(parsed.body, title, sourceWikiPath, sourceTitle, evidence);
    const sources = uniqueStrings([...asStringArray(parsed.frontmatter.sources), ...extractInlineSourcePaths(body)]);
    if (body !== parsed.body || JSON.stringify(sources) !== JSON.stringify(asStringArray(parsed.frontmatter.sources))) {
      await writeText(fullPath, serializeMarkdown({ ...parsed.frontmatter, sources, updated: nowIso() }, body));
      invalidateSearch(project.root);
    }
  });
}

function mergeTopicEvidence(originalBody: string, title: string, sourceWikiPath: string, sourceTitle: string, evidence: string[]): string {
  const selected = topicEvidence(title, evidence);
  const note = selected.length ? selected.join("\n\n") : "_当前来源没有提供可用的正文说明，请查看原始文件或转换全文。_";
  let found = false;
  let body = originalBody.replace(sourceNotePattern(), (block, heading: string, sourcePath: string, text: string) => {
    if (sourcePath !== sourceWikiPath) return block;
    found = true;
    return isEmptySourceNote(text, heading) && selected.length ? block.replace(text, `\n${note}\n\n`) : block;
  });
  if (!found) {
    body += ["", "", `### ${sourceTitle}`, "", `来源：${fileWikiLink({ path: sourceWikiPath, title: sourceTitle })}`, `来源路径：\`${sourceWikiPath}\``, "", note].join("\n");
  }
  return fillTopicDescription(body, title, sourceWikiPath, sourceTitle, selected);
}

function sourceNotePattern(): RegExp {
  return /^###\s+([^\n]+)\n(?:\s*\n)?来源：[^\n]*\n来源路径：`([^`]+)`[^\n]*\n([\s\S]*?)(?=^#{1,3}\s|(?![\s\S]))/gm;
}

function isEmptySourceNote(text: string, title: string): boolean {
  const value = text.trim().replace(/^_|_$/g, "").trim();
  return !value || value === title.trim() || /^(?:等待更多来源沉淀|当前来源没有提供可用的正文说明)/u.test(value);
}

function analysisSummaryEvidence(summary: string, sourceTitle: string): string[] {
  const values = extractContentParagraphs(summary);
  const value = readableTextOrFallback(summary, "");
  if (!value || value.replace(/[。.]$/, "") === sourceTitle.trim().replace(/[。.]$/, "")
    || /^(?:#|\[\[|https?:\/\/|来源 .+ 已加入知识库。|原文包含无法识别字符|_?当前来源没有提供可用的正文说明)/u.test(value)) return [];
  if (values.length) return values;
  // Model/offline analysis summaries are already selected evidence; punctuation is optional.
  return [value];
}

async function sourceEvidence(project: Project, sourceWikiPath: string, summary: string, sourceTitle = ""): Promise<string[]> {
  const values = analysisSummaryEvidence(summary, sourceTitle);
  try {
    const source = await readTextHead(safeJoin(project.root, sourceWikiPath), maxWikiMetadataBytes);
    const body = parseMarkdown(source).body;
    for (const section of ["摘要", "关键要点", "摘录", "转换正文"]) {
      const content = body.match(new RegExp(`^## ${section}[ \\t]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m"))?.[1] || "";
      values.push(...(section === "摘要" ? analysisSummaryEvidence(content, extractTitle(source, sourceTitle)) : extractContentParagraphs(content)));
    }
    const converted = body.match(/\[\[(wiki\/sources\/converted\/[^|\]]+)(?:\||\]\])/u)?.[1];
    if (converted) {
      try { values.push(...extractContentParagraphs(await readTextHead(safeJoin(project.root, converted), maxWikiMetadataBytes))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return uniqueStrings(values);
}

function topicEvidence(title: string, evidence: string[]): string[] {
  const related = evidence.filter((line) => line.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(topicKey(title)));
  const selected = related.length ? related : evidence;
  return [...selected].sort((a, b) => Number(/(?:是指|指的是|means\b|refers to\b)/iu.test(b)) - Number(/(?:是指|指的是|means\b|refers to\b)/iu.test(a)))
    .slice(0, 3).map((line) => line.length > 700 ? `${line.slice(0, 700)}…` : line);
}

function fillTopicDescription(body: string, title: string, sourcePath: string, sourceTitle: string, evidence: string[]): string {
  return body.replace(/(^## 定义\s*\n)([\s\S]*?)(?=^## |$(?![\s\S]))/m, (block, heading: string, content: string) => {
    if (!/^\s*_(?:等待更多来源沉淀。|当前已引用来源没有提供可用的正文说明。)_\s*$/u.test(content)) return block;
    if (!evidence.length) return `${heading}\n_当前已引用来源没有提供可用的正文说明。_\n\n`;
    const related = evidence.some((line) => line.includes(title));
    return `${heading}\n<!-- generated-topic-description:start -->\n来源：${fileWikiLink({ path: sourcePath, title: sourceTitle })}\n来源定义路径：\`${sourcePath}\`\n\n${related ? "以下为来源中的相关说明（原文摘录）：" : "当前来源提供以下背景说明，未给出本主题的独立定义："}\n\n${evidence.map((line) => `> ${line}`).join("\n\n")}\n<!-- generated-topic-description:end -->\n\n`;
  });
}

export async function repairGeneratedTopicPages(project: Project): Promise<{ repaired: number; skipped: number }> {
  let repaired = 0, skipped = 0;
  const sourceCache = new Map<string, Promise<string[]>>();
  for (const directory of ["concepts", "entities"]) {
    for (const relative of await listFiles(safeJoin(project.root, `wiki/${directory}`), { extensions: [".md"] })) {
      const wikiPath = `wiki/${directory}/${toPosix(relative)}`;
      const before = await readText(safeJoin(project.root, wikiPath));
      const parsed = parseMarkdown(before);
      const notes = [...parsed.body.matchAll(sourceNotePattern())];
      const title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : extractTitle(before, "");
      let body = parsed.body;
      for (const note of notes) {
        let source = sourceCache.get(note[2]);
        if (!source) {
          source = sourceEvidence(project, note[2], "");
          if (sourceCache.size >= 128) sourceCache.delete(sourceCache.keys().next().value!);
          sourceCache.set(note[2], source);
        }
        const evidence = uniqueStrings([...(isEmptySourceNote(note[3], note[1]) ? [] : analysisSummaryEvidence(note[3], note[1])), ...await source]);
        body = mergeTopicEvidence(body, title, note[2], note[1], evidence);
      }
      const sources = uniqueStrings([...asStringArray(parsed.frontmatter.sources), ...extractInlineSourcePaths(body)]);
      if (body !== parsed.body || JSON.stringify(sources) !== JSON.stringify(asStringArray(parsed.frontmatter.sources))) {
        await withResourceLock(`${project.root}:topic-note:${wikiPath}`, async () => {
          const latest = await readText(safeJoin(project.root, wikiPath));
          if (latest !== before) throw new Error(`主题页在修复期间发生修改，请重试：${wikiPath}`);
          await writeText(safeJoin(project.root, wikiPath), serializeMarkdown({ ...parsed.frontmatter, sources, updated: nowIso() }, body));
        });
        invalidateSearch(project.root);
        repaired += 1;
      } else skipped += 1;
    }
  }
  return { repaired, skipped };
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

function fileWikiLink(file: Pick<WikiFile, "path" | "title">): string {
  return `[[${file.path}|${file.title.replace(/[\[\]|]/g, " ").trim()}]]`;
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
