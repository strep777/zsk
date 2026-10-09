import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { extractDocument, readTextSourceFile, rewriteExtractedMediaLinks, sourceKind } from "../server/lib/extract.js";
import { makeProject, writeProjectFile } from "./helpers.js";

const unreadableText = "?".repeat(6);

describe("document extraction", () => {
  it("keeps explicit empty spreadsheet cells from consuming the next cell", async () => {
    const project = await makeProject();
    const filePath = path.join(project.root, "raw/sources/empty-cells.xlsx");
    const zip = new AdmZip();
    zip.addFile("xl/worksheets/sheet1.xml", Buffer.from('<worksheet><sheetData><row r="1"><c r="A1"/><c r="B1" t="inlineStr"><is><t>乙列正文</t></is></c></row></sheetData></worksheet>'));
    zip.writeZip(filePath);
    expect((await extractDocument(filePath)).markdown).toContain("|   | 乙列正文 |");
  });
  it("uses workbook relationships to preserve reordered sheet names and contents", async () => {
    const project = await makeProject();
    const filePath = path.join(project.root, "raw/sources/reordered.xlsx");
    const zip = new AdmZip();
    zip.addFile("xl/workbook.xml", Buffer.from('<workbook><sheets><sheet name="先显示的表" sheetId="2" r:id="rId2"/><sheet name="后显示的表" sheetId="1" r:id="rId1"/></sheets></workbook>'));
    zip.addFile("xl/_rels/workbook.xml.rels", Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'));
    zip.addFile("xl/worksheets/sheet1.xml", Buffer.from('<worksheet><sheetData><row><c t="inlineStr"><is><t>第一张原始表内容</t></is></c></row></sheetData></worksheet>'));
    zip.addFile("xl/worksheets/sheet2.xml", Buffer.from('<worksheet><sheetData><row><c t="inlineStr"><is><t>第二张原始表内容</t></is></c></row></sheetData></worksheet>'));
    zip.writeZip(filePath);
    expect((await extractDocument(filePath)).markdown).toMatch(/## 先显示的表\s+\| 第二张原始表内容 \|[\s\S]+## 后显示的表\s+\| 第一张原始表内容 \|/);
  });
  it.each(["![图](E:/assets/pandoc-media/media/image.png)", "![图](./media/image.png)", "![图](media/image.png)"])("rewrites extracted media links in Pandoc output: %s", (markdown) => {
    expect(rewriteExtractedMediaLinks(markdown, "E:\\assets\\pandoc-media", "raw/assets/s/pandoc-media", (value) => `/api/assets?path=${encodeURIComponent(value)}`)).toBe("![图](/api/assets?path=raw%2Fassets%2Fs%2Fpandoc-media%2Fmedia%2Fimage.png)");
  });
  it("keeps explicit Word line breaks and tab separators", async () => {
    const project = await makeProject();
    const filePath = path.join(project.root, "raw/sources/word.docx");
    const zip = new AdmZip();
    zip.addFile("word/document.xml", Buffer.from('<w:document><w:body><w:p><w:r><w:t>第一行</w:t><w:br/><w:t>第二行</w:t><w:tab/><w:t>第三列</w:t></w:r></w:p></w:body></w:document>'));
    zip.writeZip(filePath);
    const document = await extractDocument(filePath);
    expect(document.markdown).toContain("第一行\n第二行 第三列");
  });
  it("keeps multiline spreadsheet cells inside a single Markdown row", async () => {
    const project = await makeProject();
    const filePath = path.join(project.root, "raw/sources/multiline.xlsx");
    const zip = new AdmZip();
    zip.addFile("xl/worksheets/sheet1.xml", Buffer.from('<worksheet><sheetData><row><c t="inlineStr"><is><t>第一行&#10;第二行|第三列</t></is></c></row></sheetData></worksheet>'));
    zip.writeZip(filePath);
    expect((await extractDocument(filePath)).markdown).toContain("| 第一行<br>第二行\\|第三列 |");
  });
  it.each(["utf16le", "utf16be"])("decodes %s files without embedded nulls or garbled Chinese", async (encoding) => {
    const project = await makeProject();
    const filePath = path.join(project.root, "raw", "sources", "utf16.txt");
    const text = "公司章程与股东出资。ASCII text";
    await fs.writeFile(filePath, iconv.encode(text, encoding, { addBOM: true }));
    expect(await readTextSourceFile(filePath)).toBe(text);
  });
  it("preserves code indentation and Markdown hard line breaks", async () => {
    const project = await makeProject();
    const markdown = "# 代码\n\n第一行  \n第二行\n\n```python\nif True:\n    print('中文')\n\tpass\n```";
    const filePath = await writeProjectFile(project, "raw/sources/code.md", markdown);
    expect((await extractDocument(filePath)).markdown).toBe(markdown);
  });
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

  it("repairs text that was already saved as UTF-8 mojibake", async () => {
    const project = await makeProject();
    const filePath = path.join(project.root, "raw", "sources", "mojibake.txt");
    const mojibake = iconv.decode(Buffer.from("公司章程与股东出资。", "utf8"), "gbk");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, mojibake, "utf8");

    const extracted = await extractDocument(filePath);

    expect(extracted.text).toContain("公司章程与股东出资");
    expect(extracted.text).not.toContain("鍏");
    expect(extracted.warnings.join("\n")).toContain("编码错读");
  });

  it("keeps blank spreadsheet cells aligned when converting to markdown", async () => {
    const project = await makeProject();
    const filePath = path.join(project.root, "raw", "sources", "table.xlsx");
    const zip = new AdmZip();
    zip.addFile("xl/workbook.xml", Buffer.from('<workbook><sheets><sheet name="Sheet1"/></sheets></workbook>', "utf8"));
    zip.addFile(
      "xl/worksheets/sheet1.xml",
      Buffer.from(
        [
          "<worksheet><sheetData>",
          '<row r="1"><c r="A1" t="inlineStr"><is><t>标题</t></is></c><c r="C1" t="inlineStr"><is><t>日期</t></is></c></row>',
          '<row r="2"><c r="A2" t="inlineStr"><is><t>公司章程</t></is></c><c r="C2" t="inlineStr"><is><t>2026-06-16</t></is></c></row>',
          "</sheetData></worksheet>"
        ].join(""),
        "utf8"
      )
    );
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    zip.writeZip(filePath);

    const extracted = await extractDocument(filePath);

    expect(extracted.markdown).toContain("| 标题 |   | 日期 |");
    expect(extracted.markdown).toContain("| 公司章程 |   | 2026-06-16 |");
  });

  it("uses safe fallback titles for unreadable headings", async () => {
    const project = await makeProject();
    const filePath = await writeProjectFile(project, "raw/sources/garbled.txt", `# ${unreadableText}\n\n${unreadableText}`);
    const extracted = await extractDocument(filePath);
    expect(extracted.title).toBe("garbled");
    expect(extracted.markdown).toContain("字符无法识别");
  });

  it("handles empty text files without crashing", async () => {
    const project = await makeProject();
    const filePath = await writeProjectFile(project, "raw/sources/empty.txt", "");

    const extracted = await extractDocument(filePath);

    expect(extracted.title).toBe("empty");
    expect(extracted.markdown).toContain("# empty");
    expect(extracted.text).toBe("empty");
  });

  it("classifies supported source kinds", () => {
    expect(sourceKind("a.docx")).toBe("word");
    expect(sourceKind("a.xlsx")).toBe("table");
    expect(sourceKind("a.png")).toBe("image");
  });
});
