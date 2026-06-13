import { describe, expect, it } from "vitest";
import {
  cleanUnknownGlyphRuns,
  excerptAround,
  isUnknownGlyphText,
  readableTextOrFallback,
  splitSentences,
  tokenize,
  topKeywords,
  UNKNOWN_GLYPH_PLACEHOLDER
} from "../server/lib/text.js";

describe("text helpers", () => {
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
    const text = "## 摘要\n\n??????\n\n## 关键要点\n\n- ??????";
    const cleaned = cleanUnknownGlyphRuns(text);
    expect(cleaned).toContain(`## 摘要\n\n${UNKNOWN_GLYPH_PLACEHOLDER}\n\n## 关键要点`);
    expect(cleaned).toContain(`- ${UNKNOWN_GLYPH_PLACEHOLDER}`);
  });

  it("falls back for unreadable question mark text", () => {
    expect(isUnknownGlyphText("??????")).toBe(true);
    expect(readableTextOrFallback("??????", "备用标题")).toBe("备用标题");
  });
});
