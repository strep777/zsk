const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "was",
  "were",
  "have",
  "has",
  "into",
  "about",
  "their",
  "your",
  "you",
  "they",
  "它",
  "和",
  "与",
  "或",
  "的",
  "了",
  "在",
  "是",
  "为",
  "对",
  "中",
  "及",
  "一个",
  "我们",
  "可以",
  "通过",
  "字符无法识别",
  "无法识别",
  "未识别"
]);

export const UNKNOWN_GLYPH_PLACEHOLDER = "（字符无法识别）";

export function normalizeText(input: string): string {
  return cleanUnknownGlyphRuns(input)
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00a0]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanUnknownGlyphRuns(input: string): string {
  return input
    .replace(/\?{3,}/g, UNKNOWN_GLYPH_PLACEHOLDER)
    .replace(/(?:\uFFFD+|\u951f\u65a4\u62f7)+/g, UNKNOWN_GLYPH_PLACEHOLDER)
    .replace(/(?:（字符无法识别）[ \t\u00a0，,。；;、]*){2,}/g, UNKNOWN_GLYPH_PLACEHOLDER);
}

export function isUnknownGlyphText(input: string): boolean {
  const value = input.trim();
  if (!value) return false;
  const questionMarks = [...value.matchAll(/\?/g)].length;
  const replacementMarks = [...value.matchAll(/\uFFFD/g)].length;
  const corruptedMarks = [...value.matchAll(/\u951f\u65a4\u62f7/g)].length;
  const unknownMarkers = questionMarks + replacementMarks + corruptedMarks * 3;
  if (unknownMarkers < 2) return false;

  const meaningful = value
    .replace(/[?\uFFFD\s"'`~!！.,，。:：;；、\-_[\]()（）{}<>《》|/\\]+/g, "")
    .replace(/\u951f\u65a4\u62f7/g, "")
    .trim();
  if (!meaningful) return true;

  return unknownMarkers / Math.max(value.length, 1) >= 0.45 && !/[\p{Script=Han}A-Za-z0-9]/u.test(meaningful);
}

export function readableTextOrFallback(input: string, fallback: string): string {
  const cleaned = cleanUnknownGlyphRuns(input).replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === UNKNOWN_GLYPH_PLACEHOLDER || isUnknownGlyphText(input)) return fallback;
  return cleaned;
}

export function isLowInformationTopicLabel(input: string): boolean {
  const value = cleanUnknownGlyphRuns(input).normalize("NFKC").trim();
  if (!value || value === UNKNOWN_GLYPH_PLACEHOLDER || isUnknownGlyphText(value)) return true;
  const lowerRaw = value.toLowerCase().replace(/\s+markdown$/i, "").trim();
  if (/^(?:untitled|unnamed|unknown|page|source|file|document)(?:[-_\s]?[a-z0-9]{3,})?$/i.test(lowerRaw)) {
    return true;
  }
  if (/^(?:未命名|无法识别|未知)(?:页面|来源|概念|实体|问题)?$/u.test(value.replace(/\s+Markdown$/i, "").trim())) {
    return true;
  }
  if (/^[a-f0-9]{6,}$/i.test(lowerRaw) && !/[\p{Script=Han}]/u.test(lowerRaw)) return true;
  const compact = value.replace(/[\s._\-:：/\\()[\]{}<>《》「」,，。;；、]+/g, "");
  if (!compact) return true;

  const lower = compact.toLowerCase();
  if (new Set(["url", "uri", "http", "https", "html", "markdown", "md", "txt", "pdf", "doc", "docx"]).has(lower)) {
    return true;
  }
  if (/^\d+$/.test(compact)) return true;
  if (/^\d+(?:mm|cm|m|km|kg|g|mg|in|px|pt|kb|mb|gb|年|月|日)?$/i.test(compact)) return true;
  if (/^\d{4}[-/]?\d{1,2}[-/]?\d{0,2}$/.test(compact)) return true;
  if (/^\d+[a-z]{1,4}\d*$/i.test(compact) && compact.length <= 10) return true;
  if (/^\d+[a-z]+\d+[a-z]*$/i.test(compact) && compact.length <= 12) return true;

  const digitCount = [...compact.matchAll(/\d/g)].length;
  const hanCount = [...compact.matchAll(/\p{Script=Han}/gu)].length;
  const latinCount = [...compact.matchAll(/[a-z]/gi)].length;
  if (!hanCount && compact.length <= 8 && digitCount > 0 && digitCount / compact.length >= 0.45) return true;
  if (!hanCount && !latinCount) return true;
  return false;
}

export function deriveReadableTitleFromText(input: string, fallback = "未命名来源"): string {
  const text = cleanUnknownGlyphRuns(input);
  const url = text.match(/\bhttps?:\/\/[^\s)>\]]+/i)?.[0];
  if (url) {
    const label = readableUrlTitle(url);
    if (label && !isLowInformationTopicLabel(label)) return label;
  }

  for (const heading of extractHeadings(text)) {
    const candidate = cleanTitleCandidate(heading);
    if (candidate && !isLowInformationTopicLabel(candidate)) return candidate;
  }

  for (const candidate of extractNamedCandidates(text, 8)) {
    const cleaned = cleanTitleCandidate(candidate);
    if (cleaned && !isLowInformationTopicLabel(cleaned)) return cleaned;
  }

  const paragraph = firstParagraph(text, 120);
  const sentence = paragraph.split(/[。！？.!?]\s*/u).find(Boolean) || paragraph;
  const cleaned = cleanTitleCandidate(sentence);
  if (cleaned && !isLowInformationTopicLabel(cleaned)) return cleaned;

  return fallback;
}

export function cleanTitleCandidate(input: string, maxLength = 64): string {
  const cleaned = readableTextOrFallback(input, "")
    .replace(/^#+\s*/, "")
    .replace(/^[*-]\s*/, "")
    .replace(/^来源(?:文件|路径)?[:：]\s*/u, "")
    .replace(/^标题[:：]\s*/u, "")
    .replace(/[`*_<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /^https?:\/\//i.test(cleaned) || /^url\s*:/i.test(cleaned)) return "";
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

export function readableUrlTitle(url: string): string {
  try {
    const parsed = new URL(url);
    const readablePath = decodeURIComponent(parsed.pathname).replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
    return [parsed.hostname, readablePath].filter(Boolean).join("/");
  } catch {
    return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  }
}

export function splitSentences(input: string): string[] {
  return normalizeText(input)
    .split(/(?<=[。！？])\s*|(?<=[.!?])\s+|\n{2,}/u)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 18);
}

export function tokenize(input: string): string[] {
  const words = input
    .toLowerCase()
    .match(/[\p{Script=Han}]{2,}|[a-z0-9][a-z0-9-]{2,}/gu);
  return (words ?? [])
    .filter((word) => !STOP_WORDS.has(word))
    .filter((word) => {
      if (!/^[\p{Script=Han}]+$/u.test(word)) return true;
      if (word.length > 8) return false;
      return !/^(的|了|而|把|不是|可以|通过)/u.test(word);
    });
}

export function topKeywords(input: string, limit = 12): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(input)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
    .slice(0, limit)
    .map(([word]) => word);
}

export function extractHeadings(input: string): string[] {
  return [...input.matchAll(/^#{1,4}\s+(.+)$/gm)]
    .map((match) => match[1].replace(/[#`*_]/g, "").trim())
    .filter(Boolean)
    .slice(0, 20);
}

export function extractNamedCandidates(input: string, limit = 12): string[] {
  const candidates = new Map<string, number>();
  const patterns = [
    /\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){0,4}\b/g,
    /《([^》]{2,40})》/g,
    /“([^”]{2,40})”/g,
    /「([^」]{2,40})」/g
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input))) {
      const value = compactRepeatedPhrase((match[1] || match[0]).trim());
      if (value.length < 2 || STOP_WORDS.has(value.toLowerCase())) continue;
      candidates.set(value, (candidates.get(value) ?? 0) + 1);
    }
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value]) => value);
}

function compactRepeatedPhrase(input: string): string {
  const parts = input.split(/\s+/).filter(Boolean);
  if (parts.length % 2 !== 0 || parts.length < 4) return input;
  const middle = parts.length / 2;
  const left = parts.slice(0, middle).join(" ").toLowerCase();
  const right = parts.slice(middle).join(" ").toLowerCase();
  return left === right ? parts.slice(0, middle).join(" ") : input;
}

export function excerptAround(input: string, query: string, maxLength = 260): string {
  const text = normalizeText(input).replace(/\n/g, " ");
  if (!text) return "";
  const tokens = tokenize(query);
  const index = tokens.length
    ? Math.max(0, ...tokens.map((token) => text.toLowerCase().indexOf(token)).filter((i) => i >= 0))
    : 0;
  let start = Math.max(0, index - Math.floor(maxLength / 2));
  let end = Math.min(text.length, start + maxLength);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start -= 1;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
  return text.slice(start, end).trim();
}

export function firstParagraph(input: string, maxLength = 520): string {
  const prose = extractContentParagraphs(input)[0];
  if (prose) return prose.slice(0, maxLength).trim();
  const paragraph = normalizeText(input)
    .split(/\n{2,}/)
    .find((line) => {
      const cleaned = line.replace(/[#*>`-]/g, "").trim();
      return cleaned.length > 12 && !/^\s*(?:#{1,6}\s|`{3,}|~{3,})/.test(line) && !/^url\s*:/i.test(cleaned) && !/^https?:\/\//i.test(cleaned);
    });
  return (paragraph ?? normalizeText(input)).replace(/\s+/g, " ").slice(0, maxLength).trim();
}

/** Select extractive prose, excluding headings, publisher names and generated navigation. */
export function extractContentParagraphs(input: string): string[] {
  const text = normalizeText(input)
    .replace(/^---\n[\s\S]*?\n---(?:\n|$)/, "")
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "");
  return text.split(/\n+/).map((line) => line.replace(/^\s*(?:>\s*)+/, "").replace(/^\s*[-*+]\s+/, "").trim())
    .filter((line) => line.length >= 6 && !/^#{1,6}\s|^\[\[|^_.*_$/u.test(line))
    .filter((line) => !/^(?:url|https?:\/\/|来源(?:文件|路径)?\s*[:：]|标题\s*[:：])/iu.test(line))
    .filter((line) => !/^来源 .+ 已加入知识库。$|^原文包含无法识别字符/u.test(line))
    .filter((line) => line !== UNKNOWN_GLYPH_PLACEHOLDER && !isUnknownGlyphText(line))
    .filter((line) => !/^第[一二三四五六七八九十百零〇\d]+[章节编]\s*[^。！？]*$/u.test(line))
    .filter((line) => /[。！？；.!?;]/u.test(line) || /(?:是指|指的是|应当|不得|必须|规定|负责|means\b|refers to\b)/iu.test(line));
}

export function stripLowSignalText(input: string): string {
  return input
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b[a-f0-9]{16,}\b/gi, " ")
    .replace(/\b(?:www|http|https|com|github|gist)\b/gi, " ");
}
