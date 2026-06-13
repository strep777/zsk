import yaml from "js-yaml";
import { isUnknownGlyphText, readableTextOrFallback } from "./text.js";

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseMarkdown(input: string): ParsedMarkdown {
  if (!input.startsWith("---")) {
    return { frontmatter: {}, body: input };
  }

  const end = input.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: input };
  }

  const yamlBlock = input.slice(3, end).trim();
  const bodyStart = input.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "" : input.slice(bodyStart + 1);
  try {
    const frontmatter = (yaml.load(yamlBlock) ?? {}) as Record<string, unknown>;
    return { frontmatter, body };
  } catch {
    return { frontmatter: {}, body: input };
  }
}

export function serializeMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const dumped = yaml.dump(frontmatter, {
    lineWidth: 100,
    noRefs: true,
    sortKeys: false
  });
  return `---\n${dumped}---\n${body.trim()}\n`;
}

export function extractTitle(markdown: string, fallback: string): string {
  const safeFallback = readableTextOrFallback(fallback, "未命名页面");
  const { frontmatter, body } = parseMarkdown(markdown);
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
    return readableTextOrFallback(frontmatter.title.trim(), safeFallback);
  }
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading?.[1]?.trim() && !isUnknownGlyphText(heading[1])) {
    return readableTextOrFallback(heading[1].trim(), safeFallback);
  }
  return safeFallback;
}

export function extractWikiLinks(markdown: string): string[] {
  const links = new Set<string>();
  const wikiLink = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = wikiLink.exec(markdown))) {
    links.add(match[1].trim());
  }
  return [...links].filter(Boolean);
}

export function extractMarkdownLinks(markdown: string): string[] {
  const links = new Set<string>();
  const mdLink = /\[[^\]]+\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdLink.exec(markdown))) {
    const href = match[1].trim();
    if (!href.startsWith("http")) links.add(href);
  }
  return [...links].filter(Boolean);
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export function mergeUnique<T>(first: T[], second: T[]): T[] {
  return [...new Set([...first, ...second])];
}

export function normalizeWikiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}
