import yaml from "js-yaml";
import { isUnknownGlyphText, readableTextOrFallback } from "./text.js";

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseMarkdown(input: string): ParsedMarkdown {
  const block = input.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!block) {
    return { frontmatter: {}, body: input };
  }

  try {
    const value = yaml.load(block[1]);
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
      return { frontmatter: {}, body: input };
    }
    return { frontmatter: (value ?? {}) as Record<string, unknown>, body: input.slice(block[0].length) };
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
  const source = linkableMarkdown(markdown);
  const wikiLink = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = wikiLink.exec(source))) {
    links.add(match[1].trim());
  }
  return [...links].filter(Boolean);
}

export function extractMarkdownLinks(markdown: string): string[] {
  const links = new Set<string>();
  const source = linkableMarkdown(markdown);
  const mdLink = /\[[^\]]+\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdLink.exec(source))) {
    const href = match[1].trim();
    if (!href.startsWith("http")) links.add(href);
  }
  return [...links].filter(Boolean);
}

function linkableMarkdown(markdown: string): string {
  let fence = "";
  let fenceLength = 0;
  return parseMarkdown(markdown).body.split(/\r?\n/).map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence && marker[1].length >= fenceLength && !marker[2].trim()) fence = "";
      return "";
    }
    if (marker) { fence = marker[1][0]; fenceLength = marker[1].length; return ""; }
    return line.replace(/(`+)[\s\S]*?\1/g, "");
  }).join("\n");
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export function mergeUnique<T>(first: T[], second: T[]): T[] {
  return [...new Set([...first, ...second])];
}

export function markdownPlainText(markdown: string): string {
  return parseMarkdown(markdown).body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => label || target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/^ {0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(`+)([^`]+)\1/g, "$2")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_match, bold?: string, underline?: string) => bold || underline || "");
}

export function escapeMarkdownText(value: string): string { return value.replace(/[\\`*_[\]<>]/g, "\\$&"); }

export function normalizeWikiPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}
