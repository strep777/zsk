import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isUtf8 } from "node:buffer";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { cleanUnknownGlyphRuns, isUnknownGlyphText, normalizeText, readableTextOrFallback } from "./text.js";
import { slugify } from "./slug.js";

const execFileAsync = promisify(execFile);

export interface ExtractedAsset {
  relativePath: string;
  fileName: string;
  mediaType: "image" | "file";
}

export interface ExtractOptions {
  assetDir?: string;
  assetRelativeDir?: string;
  assetUrl?: (relativePath: string) => string;
}

export interface ExtractedDocument {
  metadataOnly?: boolean;
  title: string;
  text: string;
  markdown: string;
  kind: string;
  assets: ExtractedAsset[];
  warnings: string[];
}

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".html",
  ".htm",
  ".xml",
  ".log"
]);

const WORD_EXTENSIONS = new Set([".doc", ".docx"]);
const PRESENTATION_EXTENSIONS = new Set([".ppt", ".pptx"]);
const SPREADSHEET_EXTENSIONS = new Set([".xls", ".xlsx", ".csv", ".tsv"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);

const LEGAL_TEXT_TERMS = [
  "人民",
  "政府",
  "法院",
  "条例",
  "规定",
  "办法",
  "决定",
  "法律",
  "法规",
  "管理",
  "实施",
  "委员会",
  "代表大会",
  "公司章程",
  "股东出资"
] as const;

const CJK_MOJIBAKE_TERMS = Array.from(
  new Set(LEGAL_TEXT_TERMS.map((term) => iconv.decode(Buffer.from(term, "utf8"), "gbk")).filter(Boolean))
);

export function sourceKind(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if ([".md", ".markdown"].includes(ext)) return "markdown";
  if ([".txt", ".log"].includes(ext)) return "text";
  if ([".html", ".htm"].includes(ext)) return "html";
  if (ext === ".pdf") return "pdf";
  if (WORD_EXTENSIONS.has(ext)) return "word";
  if (PRESENTATION_EXTENSIONS.has(ext)) return "presentation";
  if (SPREADSHEET_EXTENSIONS.has(ext)) return "table";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return ext.replace(/^\./, "") || "file";
}

export async function extractDocument(filePath: string, options: ExtractOptions = {}): Promise<ExtractedDocument> {
  const ext = path.extname(filePath).toLowerCase();
  const fallbackTitle = path.basename(filePath, ext);
  const warnings: string[] = [];
  const assets: ExtractedAsset[] = [];

  if (TEXT_EXTENSIONS.has(ext)) {
    const text = cleanupTextByKind(await readTextSourceFile(filePath, warnings), ext);
    if (!text.trim()) {
      warnings.push("文件没有可读取正文，请检查内容后重新上传。");
      return { ...packDocument(fallbackTitle, textToMarkdown("", fallbackTitle), sourceKind(filePath), [], warnings), metadataOnly: true };
    }
    const markdown = ext === ".md" || ext === ".markdown" ? text : textToMarkdown(text, fallbackTitle);
    return packDocument(titleFromText(markdown, fallbackTitle), markdown, sourceKind(filePath), assets, warnings);
  }

  if (ext === ".pdf") {
    const result = await extractPdfMarkdown(filePath, options);
    return { ...packDocument(fallbackTitle, result.markdown, "pdf", result.assets, result.warnings), metadataOnly: result.metadataOnly };
  }

  if (ext === ".docx") {
    const markdown =
      (await pandocToMarkdown(filePath, options, warnings, assets)) ?? extractDocxMarkdown(filePath, options, assets);
    return packDocument(titleFromText(markdown, fallbackTitle), markdown, "word", assets, warnings);
  }

  if (ext === ".doc") {
    const converted = await convertOfficeDocument(filePath, "docx", warnings);
    if (converted) {
      try {
        const markdown =
          (await pandocToMarkdown(converted.filePath, options, warnings, assets)) ??
          extractDocxMarkdown(converted.filePath, options, assets);
        return packDocument(titleFromText(markdown, fallbackTitle), markdown, "word", assets, warnings);
      } finally {
        await converted.cleanup();
      }
    }
    return metadataOnly(filePath, "word", "未找到 LibreOffice，无法转换旧版 .doc。", warnings);
  }

  if (ext === ".pptx") {
    const markdown = extractPptxMarkdown(filePath, options, assets);
    return packDocument(titleFromText(markdown, fallbackTitle), markdown, "presentation", assets, warnings);
  }

  if (ext === ".ppt") {
    const converted = await convertOfficeDocument(filePath, "pptx", warnings);
    if (converted) {
      try {
        const markdown = extractPptxMarkdown(converted.filePath, options, assets);
        return packDocument(titleFromText(markdown, fallbackTitle), markdown, "presentation", assets, warnings);
      } finally {
        await converted.cleanup();
      }
    }
    return metadataOnly(filePath, "presentation", "未找到 LibreOffice，无法转换旧版 .ppt。", warnings);
  }

  if (ext === ".xlsx") {
    return packDocument(fallbackTitle, extractXlsxMarkdown(filePath), "table", assets, warnings);
  }

  if (ext === ".xls") {
    const converted = await convertOfficeDocument(filePath, "xlsx", warnings);
    if (converted) {
      try {
        const markdown = extractXlsxMarkdown(converted.filePath);
        return packDocument(fallbackTitle, markdown, "table", assets, warnings);
      } finally {
        await converted.cleanup();
      }
    }
    return metadataOnly(filePath, "table", "未找到 LibreOffice，无法转换旧版 .xls。", warnings);
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    const copied = await copyAsset(filePath, options, "image");
    if (copied) assets.push(copied);
    const imageLine = copied ? `![${fallbackTitle}](${assetUrl(copied.relativePath, options)})` : "";
    const markdown = [`# ${fallbackTitle}`, "", imageLine, "", await fileMetadata(filePath)].filter(Boolean).join("\n");
    return packDocument(fallbackTitle, markdown, "image", assets, warnings);
  }

  return metadataOnly(filePath, sourceKind(filePath), "当前版本仅记录该二进制文件的元数据。", warnings);
}

function packDocument(
  title: string,
  markdown: string,
  kind: string,
  assets: ExtractedAsset[],
  warnings: string[]
): ExtractedDocument {
  const safeTitle = readableTextOrFallback(title, "未命名来源");
  const normalizedMarkdown = normalizeMarkdown(cleanUnknownGlyphRuns(markdown));
  return {
    title: safeTitle,
    markdown: normalizedMarkdown,
    text: markdownToPlainText(normalizedMarkdown),
    kind,
    assets,
    warnings
  };
}

async function metadataOnly(
  filePath: string,
  kind: string,
  reason: string,
  warnings: string[]
): Promise<ExtractedDocument> {
  warnings.push(reason);
  const title = safeFallbackTitle(path.basename(filePath, path.extname(filePath)));
  const markdown = [`# ${title}`, "", await fileMetadata(filePath), "", `> ${reason}`].join("\n");
  return { ...packDocument(title, markdown, kind, [], warnings), metadataOnly: true };
}

async function fileMetadata(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath);
  return [`- 文件：\`${path.basename(filePath)}\``, `- 大小：${stat.size} bytes`].join("\n");
}

function cleanupTextByKind(input: string, ext: string): string {
  if (ext === ".md" || ext === ".markdown") return input.replace(/\r\n?/g, "\n");
  if ([".html", ".htm", ".xml"].includes(ext)) {
    return normalizeText(
      input
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    );
  }
  return normalizeText(input);
}

function textToMarkdown(input: string, title: string): string {
  return [`# ${safeFallbackTitle(title)}`, "", normalizeText(input)].join("\n");
}

function titleFromText(input: string, fallback: string): string {
  const heading = input.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const fallbackTitle = safeFallbackTitle(fallback);
  if (heading) {
    const title = cleanTitle(heading);
    if (title && title !== fallbackTitle) return title;
  }

  const line = input
    .split(/\r?\n/)
    .map((item) => item.replace(/^>\s*/, "").replace(/^[#*\-`_>\s]+|[#*\-`_>\s]+$/g, "").trim())
    .find((item) => isLikelyTitleLine(item));
  return line ? cleanTitle(line) || fallbackTitle : fallbackTitle;
}

function cleanTitle(input: string): string {
  if (isUnknownGlyphText(input)) return "";
  const cleaned = readableTextOrFallback(input, "")
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’《》]+|["'“”‘’《》]+$/g, "")
    .trim()
    .slice(0, 120);
  return cleaned === "（字符无法识别）" ? "" : cleaned;
}

function isLikelyTitleLine(input: string): boolean {
  if (!input || input.length < 4 || input.length > 120) return false;
  if (isUnknownGlyphText(input)) return false;
  if (/^(目录|目\s*录|table of contents)$/i.test(input)) return false;
  if (/^(第[一二三四五六七八九十百千万\d]+[章节条]|[一二三四五六七八九十\d]+[、.．])/.test(input)) return false;
  if (/^(url|source|来源文件|文件|大小)\s*[:：]/i.test(input)) return false;
  return /[\p{Script=Han}A-Za-z]/u.test(input);
}

export async function readTextSourceFile(filePath: string, warnings: string[] = []): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const best = chooseDecodedText(buffer);
  if (best.warning) warnings.push(best.warning);
  return stripBom(best.text);
}

type DecodedTextCandidate = {
  label: string;
  text: string;
  score: number;
  warning?: string;
};

function chooseDecodedText(buffer: Buffer): DecodedTextCandidate {
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) {
    const encoding = buffer[0] === 0xff ? "utf16le" : "utf16be";
    return { label: encoding, text: iconv.decode(buffer, encoding), score: 0, warning: "文本文件已按 UTF-16 解码。" };
  }
  const utf8Text = buffer.toString("utf8");
  const baseCandidates: Array<Omit<DecodedTextCandidate, "score">> = isUtf8(buffer)
    ? [{ label: "utf8", text: utf8Text }]
    : [
        { label: "gb18030", text: iconv.decode(buffer, "gb18030"), warning: "文本文件不是 UTF-8，已按 GB18030 解码。" },
        { label: "big5", text: iconv.decode(buffer, "big5"), warning: "文本文件不是 UTF-8，已按 BIG5 解码。" },
        { label: "utf8", text: utf8Text, warning: "文本文件不是 UTF-8，已按 UTF-8 强制解码。" }
      ];

  const candidates: Array<Omit<DecodedTextCandidate, "score">> = [];
  const seen = new Set<string>();
  const addCandidate = (candidate: Omit<DecodedTextCandidate, "score">): void => {
    if (!candidate.text || seen.has(candidate.text)) return;
    seen.add(candidate.text);
    candidates.push(candidate);
  };

  for (const candidate of baseCandidates) {
    addCandidate(candidate);
    for (const repaired of repairDecodedTextCandidates(candidate.text)) {
      addCandidate({
        label: `${candidate.label}+${repaired.label}`,
        text: repaired.text,
        warning: candidate.warning
          ? `${candidate.warning} 文本内容疑似发生过编码错读，已自动修复。`
          : "文本内容疑似发生过编码错读，已自动修复为 UTF-8 中文。"
      });
    }
  }

  if (!candidates.length) {
    return { label: "utf8", text: utf8Text, score: 0 };
  }

  return candidates
    .map((candidate) => ({ ...candidate, score: scoreDecodedText(candidate.text) }))
    .sort((a, b) => b.score - a.score)[0];
}

function repairDecodedTextCandidates(value: string): Array<{ label: string; text: string }> {
  const candidates: Array<{ label: string; text: string }> = [];
  const add = (label: string, text: string): void => {
    if (text && text !== value && !candidates.some((candidate) => candidate.text === text)) {
      candidates.push({ label, text });
    }
  };

  add("gbk-mojibake", normalizeRepairedMojibakeText(iconv.encode(value, "gbk").toString("utf8")));
  add("gb18030-mojibake", normalizeRepairedMojibakeText(iconv.encode(value, "gb18030").toString("utf8")));
  add("big5-mojibake", normalizeRepairedMojibakeText(iconv.encode(value, "big5").toString("utf8")));
  add("latin1-mojibake", normalizeRepairedMojibakeText(Buffer.from(value, "latin1").toString("utf8")));
  return candidates;
}

function normalizeRepairedMojibakeText(value: string): string {
  return value.replace(/\uFFFD\?/g, "。").replace(/\uFFFD+/g, "");
}

function scoreDecodedText(value: string): number {
  const han = [...value.matchAll(/\p{Script=Han}/gu)].length;
  const ascii = [...value.matchAll(/[A-Za-z0-9]/g)].length;
  const replacement = [...value.matchAll(/\uFFFD/g)].length;
  const questionRuns = [...value.matchAll(/\?{3,}/g)].reduce((sum, match) => sum + match[0].length, 0);
  const privateUse = [...value.matchAll(/[\uE000-\uF8FF]/g)].length;
  const latinMojibake = [...value.matchAll(/[\u00C2-\u00D6\u00D8-\u00DD\u00E2\u20AC]/g)].length;
  const cjkMojibakeTerms = countTermOccurrences(value, CJK_MOJIBAKE_TERMS);
  const legalTerms = countTermOccurrences(value, LEGAL_TEXT_TERMS);
  return (
    han * 4 +
    ascii * 0.2 +
    legalTerms * 12 -
    replacement * 30 -
    questionRuns * 4 -
    privateUse * 20 -
    latinMojibake * 8 -
    cjkMojibakeTerms * 30
  );
}

function countTermOccurrences(value: string, terms: readonly string[]): number {
  let count = 0;
  for (const term of terms) {
    let index = value.indexOf(term);
    while (index >= 0) {
      count += 1;
      index = value.indexOf(term, index + term.length);
    }
  }
  return count;
}

function stripBom(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

function safeFallbackTitle(value: string): string {
  return readableTextOrFallback(path.basename(value, path.extname(value)), "未命名来源");
}

async function extractPdfMarkdown(filePath: string, options: ExtractOptions): Promise<{
  metadataOnly: boolean;
  markdown: string;
  assets: ExtractedAsset[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const assets: ExtractedAsset[] = [];
  const title = path.basename(filePath, path.extname(filePath));
  let text = "";

  try {
    const { stdout } = await execFileAsync("pdftotext", ["-layout", filePath, "-"], {
      timeout: 60000,
      maxBuffer: 50 * 1024 * 1024
    });
    text = stdout;
  } catch (error) {
    warnings.push((error as NodeJS.ErrnoException).code === "ENOENT"
      ? "当前环境没有可用的 pdftotext，PDF 只能记录元数据。Docker 镜像会安装 poppler-utils。"
      : "PDF 正文转换失败，请检查文件是否损坏、加密或超过转换限制。");
  }

  if (options.assetDir && options.assetRelativeDir) {
    try {
      await fs.mkdir(options.assetDir, { recursive: true });
      const prefix = path.join(options.assetDir, "pdf-image");
      await execFileAsync("pdfimages", ["-png", filePath, prefix], {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024
      });
      const entries = await fs.readdir(options.assetDir);
      for (const name of entries.filter((entry) => entry.startsWith("pdf-image-")).sort()) {
        assets.push({
          relativePath: toPosix(path.join(options.assetRelativeDir, name)),
          fileName: name,
          mediaType: "image"
        });
      }
    } catch {
      warnings.push("PDF 图片抽取失败，已保留文本 Markdown。");
    }
  }

  const pages = text
    .split(/\f/g)
    .map((page, index) => ({ text: normalizeText(page), number: index + 1 }))
    .filter((page) => Boolean(page.text));
  if (!pages.length && !warnings.length) warnings.push("PDF 没有可抽取正文，可能是扫描图片；请先 OCR 后再上传。");
  const body = pages.length
    ? pages.flatMap((page) => [`## Page ${page.number}`, "", page.text]).join("\n\n")
    : await fileMetadata(filePath);
  const imageBlock = assets.length
    ? ["", "## 抽取图片", "", ...assets.map((asset) => `![${asset.fileName}](${assetUrl(asset.relativePath, options)})`)].join("\n")
    : "";
  const warningBlock = warnings.length ? ["", "## 转换提示", "", ...warnings.map((item) => `- ${item}`)].join("\n") : "";

  return {
    metadataOnly: pages.length === 0,
    markdown: [`# ${title}`, "", body, imageBlock, warningBlock].join("\n"),
    assets,
    warnings
  };
}

async function pandocToMarkdown(
  filePath: string,
  options: ExtractOptions,
  warnings: string[],
  assets?: ExtractedAsset[]
): Promise<string | null> {
  if (!options.assetDir || !options.assetRelativeDir) return null;
  const mediaDir = path.join(options.assetDir, "pandoc-media");
  try {
    await fs.mkdir(mediaDir, { recursive: true });
    const { stdout } = await execFileAsync(
      "pandoc",
      [filePath, "--to=gfm", "--wrap=none", `--extract-media=${mediaDir}`],
      {
        timeout: 60000,
        maxBuffer: 50 * 1024 * 1024
      }
    );
    const rewritten = rewriteExtractedMediaLinks(stdout, mediaDir, toPosix(path.join(options.assetRelativeDir, "pandoc-media")), options.assetUrl);
    if (assets) {
      for (const file of await listNestedFiles(mediaDir)) {
        const ext = path.extname(file).toLowerCase();
        if (!IMAGE_EXTENSIONS.has(ext)) continue;
        assets.push({
          relativePath: toPosix(path.join(options.assetRelativeDir, "pandoc-media", file)),
          fileName: path.basename(file),
          mediaType: "image"
        });
      }
    }
    return normalizeMarkdown(rewritten);
  } catch {
    warnings.push("Pandoc 不可用或转换失败，已使用内置 Office 解析器。");
    return null;
  }
}

export function rewriteExtractedMediaLinks(markdown: string, mediaDir: string, assetRelativeDir: string, resolveAsset?: (path: string) => string): string {
  const prefix = mediaDir.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  return markdown.replace(/(!\[[^\]]*\])\(([^\n)]+)\)/g, (original, label: string, rawTarget: string) => {
    let target = rawTarget.replace(/^<|>$/g, "").replace(/\\/g, "/");
    try { target = decodeURIComponent(target); } catch { return original; }
    const relative = target.startsWith(prefix) ? target.slice(prefix.length) : /^(?:\.\/)?media\//.test(target) ? target.replace(/^\.\//, "") : undefined;
    if (!relative || relative.split("/").includes("..")) return original;
    const assetPath = `${assetRelativeDir}/${relative}`;
    const url = resolveAsset ? resolveAsset(assetPath) : encodeURI(assetPath);
    return `${label}(${url})`;
  });
}

async function listNestedFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push(toPosix(path.relative(root, fullPath)));
      }
    }
  }
  await walk(root);
  return files.sort();
}

function extractDocxMarkdown(filePath: string, options: ExtractOptions, assets: ExtractedAsset[]): string {
  const zip = new AdmZip(filePath);
  assets.push(...extractZipMedia(zip, "word/media/", options));
  const document = zip.getEntry("word/document.xml");
  if (!document) return `# ${path.basename(filePath, path.extname(filePath))}`;
  const xml = document.getData().toString("utf8");
  const parts: string[] = [];

  for (const block of xml.match(/<w:tbl[\s\S]*?<\/w:tbl>|<w:p[\s\S]*?<\/w:p>/g) ?? []) {
    if (block.startsWith("<w:tbl")) {
      const table = wordTableToMarkdown(block);
      if (table) parts.push(table);
      continue;
    }

    const paragraphText = extractWordParagraphText(block);
    if (!paragraphText) continue;
    const style = block.match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1] ?? "";
    const headingLevel = headingLevelFromWordStyle(style);
    if (headingLevel) {
      parts.push(`${"#".repeat(headingLevel)} ${paragraphText}`);
    } else if (/<w:numPr>/.test(block)) {
      parts.push(`- ${paragraphText}`);
    } else {
      parts.push(paragraphText);
    }
  }

  const mediaBlock = assets.length
    ? ["", "## 附件图片", "", ...assets.map((asset) => `![${asset.fileName}](${assetUrl(asset.relativePath, options)})`)].join("\n")
    : "";
  return [parts.join("\n\n"), mediaBlock].join("\n");
}

function extractPptxMarkdown(filePath: string, options: ExtractOptions, assets: ExtractedAsset[]): string {
  const zip = new AdmZip(filePath);
  assets.push(...extractZipMedia(zip, "ppt/media/", options));
  const slides = zip
    .getEntries()
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }))
    .map((entry, index) => {
      const xml = entry.getData().toString("utf8");
      const textRuns = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]).trim());
      const [title, ...rest] = textRuns.filter(Boolean);
      return [`## Slide ${index + 1}${title ? `：${title}` : ""}`, "", ...rest.map((line) => `- ${line}`)].join("\n");
    });
  const mediaBlock = assets.length
    ? ["", "## 演示文稿图片", "", ...assets.map((asset) => `![${asset.fileName}](${assetUrl(asset.relativePath, options)})`)].join("\n")
    : "";
  return [`# ${path.basename(filePath, path.extname(filePath))}`, "", ...slides, mediaBlock].join("\n\n");
}

function extractXlsxMarkdown(filePath: string): string {
  const zip = new AdmZip(filePath);
  const sharedStrings = readSharedStrings(zip);
  const fallbackSheets = zip
    .getEntries()
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));
  const workbook = zip.getEntry("xl/workbook.xml")?.getData().toString("utf8");
  const relationships = readOfficeRelationships(zip, "xl/_rels/workbook.xml.rels", "xl");
  const sheetDefinitions = workbook ? [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((match, index) => {
    const target = relationships.get(xmlAttribute(match[0], "r:id") || "");
    return { name: decodeXml(xmlAttribute(match[0], "name") || `Sheet ${index + 1}`), entry: target ? zip.getEntry(target) : fallbackSheets[index] };
  }) : fallbackSheets.map((entry, index) => ({ name: `Sheet ${index + 1}`, entry }));
  const sheets = sheetDefinitions
    .filter(({ entry }) => entry && entry.entryName.startsWith("xl/worksheets/"))
    .map(({ entry, name }) => {
      if (!entry) return "";
      const table = worksheetToMarkdownTable(entry.getData().toString("utf8"), sharedStrings);
      return [`## ${name}`, "", table || "_空表_"].join("\n");
    });
  return [`# ${path.basename(filePath, path.extname(filePath))}`, "", ...sheets].join("\n\n");
}

function extractZipMedia(zip: AdmZip, prefix: string, options: ExtractOptions): ExtractedAsset[] {
  if (!options.assetDir || !options.assetRelativeDir) return [];
  const assets: ExtractedAsset[] = [];
  for (const entry of zip.getEntries().filter((item) => item.entryName.startsWith(prefix) && !item.isDirectory)) {
    const ext = path.extname(entry.entryName).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const fileName = `${slugify(path.basename(entry.entryName, ext), "asset")}${ext}`;
    const target = path.join(options.assetDir, fileName);
    mkdirSync(options.assetDir, { recursive: true });
    writeFileSync(target, entry.getData());
    assets.push({
      relativePath: toPosix(path.join(options.assetRelativeDir, path.basename(target))),
      fileName: path.basename(target),
      mediaType: "image"
    });
  }
  return assets;
}

async function copyAsset(
  filePath: string,
  options: ExtractOptions,
  mediaType: "image" | "file"
): Promise<ExtractedAsset | null> {
  if (!options.assetDir || !options.assetRelativeDir) return null;
  await fs.mkdir(options.assetDir, { recursive: true });
  const ext = path.extname(filePath).toLowerCase();
  const fileName = `${slugify(path.basename(filePath, ext), "asset")}${ext}`;
  const target = path.join(options.assetDir, fileName);
  await fs.copyFile(filePath, target);
  return {
    relativePath: toPosix(path.join(options.assetRelativeDir, fileName)),
    fileName,
    mediaType
  };
}

async function convertOfficeDocument(
  filePath: string,
  targetExt: "docx" | "pptx" | "xlsx",
  warnings: string[]
): Promise<{ filePath: string; cleanup: () => Promise<void> } | null> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-office-"));
  const commands = ["libreoffice", "soffice"];
  for (const command of commands) {
    try {
      await execFileAsync(command, ["--headless", "--convert-to", targetExt, "--outdir", tempDir, filePath], {
        timeout: 90000,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, HOME: os.tmpdir() }
      });
      const files = await fs.readdir(tempDir);
      const converted = files.find((name) => path.extname(name).toLowerCase() === `.${targetExt}`);
      if (converted) {
        return {
          filePath: path.join(tempDir, converted),
          cleanup: () => fs.rm(tempDir, { recursive: true, force: true })
        };
      }
    } catch {
      // Try the next executable name.
    }
  }
  await fs.rm(tempDir, { recursive: true, force: true });
  warnings.push(`LibreOffice 不可用，无法把 ${path.extname(filePath)} 转成 ${targetExt}。`);
  return null;
}

function wordTableToMarkdown(xml: string): string {
  const rows = [...xml.matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)].map((row) =>
    [...row[0].matchAll(/<w:tc[\s\S]*?<\/w:tc>/g)]
      .map((cell) => extractWordParagraphText(cell[0]).replace(/\|/g, "\\|").replace(/\n/g, "<br>"))
      .map((cell) => cell || " ")
  );
  return markdownTable(rows);
}

function extractWordParagraphText(xml: string): string {
  xml = xml.replace(/<w:(?:br|cr)\b[^>]*\/>/g, "<w:t>\n</w:t>").replace(/<w:tab\b[^>]*\/>/g, "<w:t> </w:t>");
  return normalizeText([...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => decodeXml(match[1])).join(""));
}

function headingLevelFromWordStyle(style: string): number | null {
  const normalized = style.toLowerCase();
  const match = normalized.match(/heading([1-6])|标题([1-6])/);
  return match ? Number(match[1] || match[2]) : null;
}

function readSharedStrings(zip: AdmZip): string[] {
  const entry = zip.getEntry("xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = entry.getData().toString("utf8");
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    normalizeText([...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join(""))
  );
}

function xmlAttribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`))?.[2];
}

function readOfficeRelationships(zip: AdmZip, entryName: string, directory: string): Map<string, string> {
  const xml = zip.getEntry(entryName)?.getData().toString("utf8") || "";
  const targets = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = xmlAttribute(match[0], "Id");
    const target = xmlAttribute(match[0], "Target");
    if (!id || !target || xmlAttribute(match[0], "TargetMode") === "External") continue;
    targets.set(id, path.posix.normalize(target.startsWith("/") ? target.slice(1) : `${directory}/${target}`));
  }
  return targets;
}

function worksheetToMarkdownTable(xml: string, sharedStrings: string[]): string {
  const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
    const cells = [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)];
    const values: string[] = [];
    for (const cell of cells) {
      const attrs = cell[1];
      const body = cell[2] || "";
      const index = cellColumnIndex(attrs) ?? values.length;
      values[index] = worksheetCellText(attrs, body, sharedStrings);
    }
    return values.map((value) => normalizeText(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>"));
  });
  return markdownTable(rows);
}

function worksheetCellText(attrs: string, body: string, sharedStrings: string[]): string {
  const value = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
  if (value !== undefined) {
    return attrs.includes('t="s"') ? sharedStrings[Number(value)] || "" : decodeXml(value);
  }

  const inlineText = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join("");
  return inlineText;
}

function cellColumnIndex(attrs: string): number | null {
  const letters = attrs.match(/\br="([A-Z]+)\d+"/i)?.[1];
  if (!letters) return null;
  return [...letters.toUpperCase()].reduce((index, char) => index * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function markdownTable(rows: string[][]): string {
  const nonEmpty = rows.filter((row) => row.some((cell) => cell.trim()));
  if (!nonEmpty.length) return "";
  const width = Math.max(...nonEmpty.map((row) => row.length));
  const padded = nonEmpty.map((row) => Array.from({ length: width }, (_, index) => row[index] || " "));
  const [header, ...body] = padded;
  const separator = Array.from({ length: width }, () => "---");
  return [header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function markdownToPlainText(markdown: string): string {
  return normalizeText(
    markdown
      .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
      .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[`*_>|-]/g, " ")
  );
}

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function assetUrl(relativePath: string, options: ExtractOptions): string {
  return options.assetUrl ? options.assetUrl(relativePath) : relativePath;
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function decodeXml(input: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
  return input.replace(/&((?:amp|lt|gt|quot|apos)|#(?:\d+|x[0-9a-f]+));/gi, (entity, value: string) => {
    if (!value.startsWith("#")) return named[value.toLowerCase()] || entity;
    const hexadecimal = value[1].toLowerCase() === "x";
    const code = Number.parseInt(value.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
}
