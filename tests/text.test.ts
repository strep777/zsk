import { describe, expect, it } from "vitest";
import {
  cleanUnknownGlyphRuns,
  deriveReadableTitleFromText,
  excerptAround,
  firstParagraph,
  extractContentParagraphs,
  isUnknownGlyphText,
  isLowInformationTopicLabel,
  readableTextOrFallback,
  splitSentences,
  tokenize,
  topKeywords,
  UNKNOWN_GLYPH_PLACEHOLDER
} from "../server/lib/text.js";

const unreadableText = "?".repeat(6);

describe("text helpers", () => {
  it("removes isolated replacement glyphs from display text", () => {
    expect(cleanUnknownGlyphRuns("正常中文\uFFFD后续中文")).toBe(`正常中文${UNKNOWN_GLYPH_PLACEHOLDER}后续中文`);
  });
  it("selects short prose before longer code examples for summaries", () => {
    expect(firstParagraph('# 标题\n\n公司章程规定股东的出资方式、期限。\n\n```python\nif True:\n    print("非常长的示例文本，用于验证代码不覆盖正常摘要。")\n```')).toBe("公司章程规定股东的出资方式、期限。");
  });
  it("selects legal provisions instead of the opening publisher and document title", () => {
    const text = "安徽省人民代表大会常务委员会\n\n安徽省公共数据管理条例\n\n第一章 总则\n\n第一条 为了规范公共数据管理，保障公共数据安全，制定本条例。\n\n第二条 本条例所称公共数据，是指国家机关依法履行职责过程中收集、产生的数据。";
    expect(firstParagraph(text)).toBe("第一条 为了规范公共数据管理，保障公共数据安全，制定本条例。");
    expect(extractContentParagraphs(text)).toContain("第二条 本条例所称公共数据，是指国家机关依法履行职责过程中收集、产生的数据。");
    expect(extractContentParagraphs(text)).not.toContain("安徽省人民代表大会常务委员会");
  });
  it("splits Chinese sentences without requiring spaces after punctuation", () => {
    expect(splitSentences("公共数据是国家机关履行职责过程中产生的数据。公共数据应当按照分类分级要求进行管理。")).toEqual([
      "公共数据是国家机关履行职责过程中产生的数据。", "公共数据应当按照分类分级要求进行管理。"
    ]);
  });
  it("does not treat ingestion status or unreadable-text warnings as source prose", () => {
    expect(extractContentParagraphs("来源 安徽省人大常委会 已加入知识库。\n\n原文包含无法识别字符，请重新上传原始文件或检查编码。")).toEqual([]);
  });
  it("keeps emoji intact at excerpt boundaries", () => {
    expect(excerptAround("甲甲甲😀乙", "", 4)).toBe("甲甲甲");
  });
  it("tokenizes English and Chinese content", () => {
    expect(tokenize("LLM Wiki 可以把 raw sources 编译成 wiki pages")).toContain("wiki");
    expect(topKeywords("知识库 知识库 图谱 图谱 图谱", 1)).toEqual(["图谱"]);
  });

  it("extracts useful excerpts", () => {
    const text = "第一段说明。\n\nLLM Wiki 的核心是把来源编译成可追溯 Markdown。";
    expect(splitSentences(text).length).toBeGreaterThan(0);
    expect(excerptAround(text, "Markdown")).toContain("Markdown");
  });

  it("cleans unknown glyph runs without flattening markdown structure", () => {
    const text = `## 摘要\n\n${unreadableText}\n\n## 关键要点\n\n- ${unreadableText}`;
    const cleaned = cleanUnknownGlyphRuns(text);
    expect(cleaned).toContain(`## 摘要\n\n${UNKNOWN_GLYPH_PLACEHOLDER}\n\n## 关键要点`);
    expect(cleaned).toContain(`- ${UNKNOWN_GLYPH_PLACEHOLDER}`);
  });

  it("falls back for unreadable question mark text", () => {
    expect(isUnknownGlyphText(unreadableText)).toBe(true);
    expect(readableTextOrFallback(unreadableText, "备用标题")).toBe("备用标题");
  });

  it("detects numeric and file-fragment topic labels", () => {
    expect(isLowInformationTopicLabel("000")).toBe(true);
    expect(isLowInformationTopicLabel("03403in")).toBe(true);
    expect(isLowInformationTopicLabel("20240613")).toBe(true);
    expect(isLowInformationTopicLabel("untitled-3ab4d5f9")).toBe(true);
    expect(isLowInformationTopicLabel("未命名来源 Markdown")).toBe(true);
    expect(isLowInformationTopicLabel("公司章程")).toBe(false);
    expect(isLowInformationTopicLabel("LLM Wiki")).toBe(false);
  });

  it("derives readable titles from urls and document text", () => {
    expect(deriveReadableTitleFromText("URL: https://example.com/smoke", "未命名来源")).toBe("example.com/smoke");
    expect(deriveReadableTitleFromText("# 000\n\n### 汉中市人民代表大会常务委员会", "未命名来源")).toBe(
      "汉中市人民代表大会常务委员会"
    );
  });
});
