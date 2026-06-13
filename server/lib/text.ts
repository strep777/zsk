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
    .replace(/(?:\uFFFD{2,}|锟斤拷)+/g, UNKNOWN_GLYPH_PLACEHOLDER)
    .replace(/(?:（字符无法识别）[ \t\u00a0，,。；;、]*){2,}/g, UNKNOWN_GLYPH_PLACEHOLDER);
}

export function isUnknownGlyphText(input: string): boolean {
  const value = input.trim();
  if (!value) return false;
  const questionMarks = [...value.matchAll(/\?/g)].length;
  const replacementMarks = [...value.matchAll(/\uFFFD/g)].length;
  const corruptedMarks = [...value.matchAll(/锟斤拷/g)].length;
  const unknownMarkers = questionMarks + replacementMarks + corruptedMarks * 3;
  if (unknownMarkers < 2) return false;

  const meaningful = value
    .replace(/[?\uFFFD\s"'`~!！.,，。:：;；、\-_[\]()（）{}<>《》|/\\]+/g, "")
    .replace(/锟斤拷/g, "")
    .trim();
  if (!meaningful) return true;

  return unknownMarkers / Math.max(value.length, 1) >= 0.45 && !/[\p{Script=Han}A-Za-z0-9]/u.test(meaningful);
}

export function readableTextOrFallback(input: string, fallback: string): string {
  const cleaned = cleanUnknownGlyphRuns(input).replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned === UNKNOWN_GLYPH_PLACEHOLDER || isUnknownGlyphText(input)) return fallback;
  return cleaned;
}

export function splitSentences(input: string): string[] {
  return normalizeText(input)
    .split(/(?<=[。！？.!?])\s+|\n{2,}/u)
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
  const start = Math.max(0, index - Math.floor(maxLength / 2));
  return text.slice(start, start + maxLength).trim();
}

export function firstParagraph(input: string, maxLength = 520): string {
  const paragraph = normalizeText(input)
    .split(/\n{2,}/)
    .find((line) => {
      const cleaned = line.replace(/[#*>`-]/g, "").trim();
      return cleaned.length > 30 && !/^url\s*:/i.test(cleaned) && !/^https?:\/\//i.test(cleaned);
    });
  return (paragraph ?? normalizeText(input)).replace(/\s+/g, " ").slice(0, maxLength).trim();
}

export function stripLowSignalText(input: string): string {
  return input
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b[a-f0-9]{16,}\b/gi, " ")
    .replace(/\b(?:www|http|https|com|github|gist)\b/gi, " ");
}
