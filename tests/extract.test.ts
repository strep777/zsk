import fs from "node:fs/promises";
import path from "node:path";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { extractDocument, sourceKind } from "../server/lib/extract.js";
import { makeProject, writeProjectFile } from "./helpers.js";

describe("document extraction", () => {
  it("extracts markdown title and text", async () => {
    const project = await makeProject();
    const filePath = await writeProjectFile(project, "raw/sources/company.md", "# 公司章程\n\n公司章程可以约定治理规则。");
    const extracted = await extractDocument(filePath);
    expect(extracted.title).toBe("公司章程");
    expect(extracted.kind).toBe("markdown");
    expect(extracted.text).toContain("治理规则");
  });

  it("decodes GB18030 text instead of producing question marks", async () => {
    const project = await makeProject();
    const filePath = path.join(project.root, "raw", "sources", "gbk.txt");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, iconv.encode("公司章程与股东出资。", "gb18030"));
    const extracted = await extractDocument(filePath);
    expect(extracted.text).toContain("公司章程");
    expect(extracted.warnings.join("\n")).toContain("GB18030");
  });

  it("uses safe fallback titles for unreadable headings", async () => {
    const project = await makeProject();
    const filePath = await writeProjectFile(project, "raw/sources/garbled.txt", "# ??????\n\n??????");
    const extracted = await extractDocument(filePath);
    expect(extracted.title).toBe("garbled");
    expect(extracted.markdown).toContain("字符无法识别");
  });

  it("classifies supported source kinds", () => {
    expect(sourceKind("a.docx")).toBe("word");
    expect(sourceKind("a.xlsx")).toBe("table");
    expect(sourceKind("a.png")).toBe("image");
  });
});
