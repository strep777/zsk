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
  const files = await listWikiFiles(project, { limit });
  const titleMap = titleToWikiLinkMap(files);
  const sources = await readSources(project);
  const sourcePaths = new Set(sources.map((source) => source.relativePath));
  const issues: LintIssue[] = [];
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
    if (file.type === "source") {
      const sourcePath = parsed.frontmatter.source_path;
      if (typeof sourcePath === "string" && !sourcePaths.has(sourcePath)) {
        issues.push(issue("error", file.path, "来源记录丢失", `source_path 指向 ${sourcePath}，但 registry 中没有记录。`));
      }
    }
    for (const link of file.links) {
      const target = titleMap.get(link.toLowerCase());
      if (!target) {
        issues.push(issue("error", file.path, "断开的 Wikilink", `找不到 [[${link}]]。`, "创建目标页面或修正链接标题。"));
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
    }
  }

  return issues.sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity)).slice(0, maxLintIssues);
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
