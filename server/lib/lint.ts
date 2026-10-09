import fs from "node:fs/promises";
import { LintIssue, Project, WikiFile } from "../types.js";
import { parseMarkdown } from "./markdown.js";
import { idFrom } from "./slug.js";
import { readSources, readText, safeJoin } from "./storage.js";
import { listWikiFiles, titleToWikiLinkMap } from "./wiki.js";

const maxLintFiles = readPositiveInteger("LLM_WIKI_MAX_LINT_FILES", 2500);
const maxLintIssues = readPositiveInteger("LLM_WIKI_MAX_LINT_ISSUES", 1000);
const sourceOptionalTypes = new Set(["index", "log", "synthesis"]);

export async function lintProject(project: Project, options: { limit?: number } = {}): Promise<LintIssue[]> {
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : maxLintFiles;
  const scanned = await listWikiFiles(project, { limit: limit + 1 });
  const limited = scanned.length > limit;
  const files = scanned.slice(0, limit);
  const titleMap = titleToWikiLinkMap(files);
  const sources = await readSources(project);
  const sourcePaths = new Set(sources.map((source) => source.relativePath));
  const wikiPaths = new Set(files.map((file) => file.path));
  const existsCache = new Map<string, Promise<boolean>>();
  const issues: LintIssue[] = [];
  if (limited) issues.push(issue("info", "wiki/index.md", "体检范围受限", `本次仅检查前 ${limit} 个 Wiki 页面，未扫描的页面不在本次结果内。`, "提高体检扫描上限后再次检查。"));
  const incoming = new Map<string, number>();

  for (const file of files) {
    const content = await readText(safeJoin(project.root, file.path));
    const parsed = parseMarkdown(content);
    if (!content.startsWith("---")) {
      issues.push(issue("warning", file.path, "缺少 frontmatter", "页面缺少 YAML frontmatter。", "补充 title/type/tags/sources。"));
    }
    if (!/^#\s+.+$/m.test(parsed.body)) {
      issues.push(issue("warning", file.path, "缺少一级标题", "页面没有 H1 标题。", "添加一个和 title 一致的 `# 标题`。"));
    }
    if (!sourceOptionalTypes.has(file.type) && !file.sources.length) {
      issues.push(issue("info", file.path, "缺少来源引用", "页面没有 `sources` 元数据。", "把相关来源页或原始文件路径写入 sources。"));
    }
    for (const sourceRef of file.sources) {
      if (isExternalReference(sourceRef)) continue;
      if (sourceRef.startsWith("raw/sources/")) {
        const exists = sourcePaths.has(sourceRef) || await projectFileExists(project, sourceRef, existsCache);
        if (!exists) {
          issues.push(issue("error", file.path, "来源文件丢失", `sources 指向 ${sourceRef}，但找不到对应的来源记录或原始文件。`, "重新上传文件、重新扫描来源，或修正 sources 元数据。"));
        }
      } else if (sourceRef.startsWith("wiki/") && !wikiPaths.has(sourceRef) && !(await projectFileExists(project, sourceRef, existsCache))) {
        issues.push(issue("error", file.path, "来源页面丢失", `sources 指向 ${sourceRef}，但该 Wiki 页面不存在。`, "打开文件管理页重新生成来源页，或修正 sources 元数据。"));
      }
    }
    if (file.type === "source") {
      const sourcePath = parsed.frontmatter.source_path;
      if (typeof sourcePath === "string" && !sourcePaths.has(sourcePath)) {
        issues.push(issue("error", file.path, "来源记录丢失", `source_path 指向 ${sourcePath}，但 registry 中没有记录。`));
      }
    }
    for (const link of file.links) {
      const target = titleMap.get(link.toLowerCase());
      if (!target) {
        if (!limited) issues.push(issue("error", file.path, "断开的 Wikilink", `找不到 [[${link}]]。`, "创建目标页面或修正链接标题。"));
      } else {
        incoming.set(target.path, (incoming.get(target.path) ?? 0) + 1);
      }
    }
  }

  for (const file of files) {
    if (sourceOptionalTypes.has(file.type)) continue;
    if ((incoming.get(file.path) ?? 0) === 0 && !["source", "source_extract"].includes(file.type)) {
      issues.push(issue("info", file.path, "孤立页面", "没有其他页面链接到它。", "从概览、概念页或来源页添加 Wikilink。"));
    }
  }

  const titles = new Map<string, WikiFile[]>();
  for (const file of files) {
    const key = file.title.toLowerCase();
    titles.set(key, [...(titles.get(key) ?? []), file]);
  }
  for (const duplicates of titles.values()) {
    if (duplicates.length > 1) {
      for (const file of duplicates) {
        issues.push(issue("warning", file.path, "重复标题", `标题 "${file.title}" 出现 ${duplicates.length} 次。`, "合并页面或改成唯一标题。"));
      }
    }
  }

  for (const source of sources) {
    if (source.status === "failed") {
      issues.push(issue("error", source.relativePath, "来源摄入失败", source.error || "未知错误。", "查看队列日志后重新摄入。"));
      continue;
    }
    if (!(await projectFileExists(project, source.relativePath, existsCache))) {
      issues.push(issue("error", source.relativePath, "原始文件丢失", "来源记录存在，但原始文件已经不存在。", "重新上传文件，或从文件管理页移除这条来源记录。"));
    }
    if (source.wikiPath && !wikiPaths.has(source.wikiPath) && !(await projectFileExists(project, source.wikiPath, existsCache))) {
      issues.push(issue("error", source.relativePath, "来源页丢失", `来源记录指向 ${source.wikiPath}，但该页面不存在。`, "重新摄入该文件以生成来源页。"));
    }
    if (source.convertedPath && !wikiPaths.has(source.convertedPath) && !(await projectFileExists(project, source.convertedPath, existsCache))) {
      issues.push(issue("error", source.relativePath, "转换全文丢失", `来源记录指向 ${source.convertedPath}，但该页面不存在。`, "重新摄入该文件以生成转换全文。"));
    }
  }

  return issues.sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity)).slice(0, maxLintIssues);
}

function isExternalReference(value: string): boolean {
  return /^(?:https?:|mailto:|file:|data:)/i.test(value);
}

async function projectFileExists(
  project: Project,
  relativePath: string,
  cache: Map<string, Promise<boolean>>
): Promise<boolean> {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  let cached = cache.get(normalized);
  if (!cached) {
    cached = Promise.resolve().then(() => fs.access(safeJoin(project.root, normalized))).then(() => true, () => false);
    cache.set(normalized, cached);
  }
  return cached;
}

function issue(
  severity: LintIssue["severity"],
  pathValue: string,
  title: string,
  detail: string,
  fix?: string
): LintIssue {
  return {
    id: idFrom(`${severity}-${pathValue}-${title}-${detail}`),
    severity,
    path: pathValue.replace(/\\/g, "/"),
    title,
    detail,
    fix
  };
}

function severityOrder(severity: LintIssue["severity"]): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
