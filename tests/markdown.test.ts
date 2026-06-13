import { describe, expect, it } from "vitest";
import {
  asStringArray,
  extractMarkdownLinks,
  extractTitle,
  extractWikiLinks,
  normalizeWikiPath,
  parseMarkdown,
  serializeMarkdown
} from "../server/lib/markdown.js";

describe("markdown helpers", () => {
  it("round-trips frontmatter and body", () => {
    const markdown = serializeMarkdown({ title: "公司章程", type: "query", tags: ["query"] }, "# 公司章程\n\n正文");
    const parsed = parseMarkdown(markdown);
    expect(parsed.frontmatter.title).toBe("公司章程");
    expect(parsed.frontmatter.tags).toEqual(["query"]);
    expect(parsed.body).toContain("正文");
  });

  it("extracts a readable title with fallback protection", () => {
    expect(extractTitle("# 公司章程\n\n正文", "fallback")).toBe("公司章程");
    expect(extractTitle("# ??????\n\n正文", "fallback")).toBe("fallback");
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
