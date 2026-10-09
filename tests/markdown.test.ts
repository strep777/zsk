import { describe, expect, it } from "vitest";
import {
  asStringArray,
  markdownPlainText,
  extractMarkdownLinks,
  extractTitle,
  extractWikiLinks,
  normalizeWikiPath,
  parseMarkdown,
  serializeMarkdown
} from "../server/lib/markdown.js";

const unreadableHeading = "?".repeat(6);

describe("markdown helpers", () => {
  it("removes rendering syntax before constructing search excerpts", () => {
    expect(markdownPlainText('# 标题\n\n[[wiki/topic.md|中文主题]] **正文** `代码` [原文](wiki/doc.md)')).toBe("标题\n\n中文主题 正文 代码 原文");
  });
  it("ignores metadata and code examples when extracting document links", () => {
    const markdown = '---\ntitle: "[[元数据]]"\n---\n[[真实页面]] [原文](wiki/doc.md)\n\n`[[代码示例]]`\n\n````md\n[[围栏示例]] [示例](wiki/example.md)\n```\n[[仍在代码里]]\n````';
    expect(extractWikiLinks(markdown)).toEqual(["真实页面"]);
    expect(extractMarkdownLinks(markdown)).toEqual(["wiki/doc.md"]);
  });
  it("accepts BOM and CRLF frontmatter while rejecting scalar metadata and false delimiters", () => {
    expect(parseMarkdown("\uFEFF---\r\ntitle: 中文\r\n---\r\n正文")).toEqual({ frontmatter: { title: "中文" }, body: "正文" });
    for (const input of ["---\nnull\n---\n正文", "---\n[one, two]\n---\n正文", "---\ntitle: 示例\n---text\n正文"]) {
      expect(parseMarkdown(input)).toEqual({ frontmatter: {}, body: input });
    }
  });
  it("round-trips frontmatter and body", () => {
    const markdown = serializeMarkdown({ title: "公司章程", type: "query", tags: ["query"] }, "# 公司章程\n\n正文");
    const parsed = parseMarkdown(markdown);
    expect(parsed.frontmatter.title).toBe("公司章程");
    expect(parsed.frontmatter.tags).toEqual(["query"]);
    expect(parsed.body).toContain("正文");
  });

  it("extracts a readable title with fallback protection", () => {
    expect(extractTitle("# 公司章程\n\n正文", "fallback")).toBe("公司章程");
    expect(extractTitle(`# ${unreadableHeading}\n\n正文`, "fallback")).toBe("fallback");
  });

  it("extracts wiki links and local markdown links", () => {
    const markdown = "[[公司法|公司法条文]] [[公司章程#模板]] [本地](wiki/a.md) [外部](https://example.com)";
    expect(extractWikiLinks(markdown)).toEqual(["公司法", "公司章程"]);
    expect(extractMarkdownLinks(markdown)).toEqual(["wiki/a.md"]);
  });

  it("normalizes arrays and wiki paths", () => {
    expect(asStringArray("raw/a.md")).toEqual(["raw/a.md"]);
    expect(normalizeWikiPath("\\wiki\\index.md")).toBe("wiki/index.md");
  });
});
