import { describe, expect, it } from "vitest";
import { parseMarkdown, serializeMarkdown } from "../server/lib/markdown.js";
import {
  appendLog,
  updateIndex,
  upsertConceptPages,
  upsertEntityPages,
  removeSourceEvidence,
  repairGeneratedTopicPages,
  listWikiFilesPage,
  readWikiFile,
  titleToWikiLinkMap,
  writeWikiFile,
  writeConvertedSourcePage,
  writeSourcePage,
  saveQueryAnswer
} from "../server/lib/wiki.js";
import { makeProject, writeProjectFile } from "./helpers.js";

describe("wiki topic pages", () => {
  it("keeps factual analysis summaries without punctuation while rejecting a repeated title", async () => {
    const project = await makeProject();
    const [topic] = await upsertConceptPages(project, ["共同概念"], "wiki/sources/fact.md", "材料乙", "应保留的事实乙");
    const body = parseMarkdown(await readWikiFile(project, topic)).body;
    expect(body.split("## 来源笔记")[1]).toContain("应保留的事实乙");
    expect(body.split("## 定义")[1].split("## 来源笔记")[0]).toContain("应保留的事实乙");
  });
  it("builds a cited topic description and source metadata from source provisions instead of a repeated publisher", async () => {
    const project = await makeProject();
    const sourcePath = "wiki/sources/public-data.md";
    await writeProjectFile(project, sourcePath, serializeMarkdown({ title: "安徽省人民代表大会常务委员会", type: "source", sources: ["raw/sources/public-data.docx"] },
      "# 安徽省人民代表大会常务委员会\n\n## 摘要\n\n安徽省人民代表大会常务委员会\n\n## 关键要点\n\n- 公共数据应当按照分类分级要求进行管理。\n\n## 摘录\n\n> 第二条 本条例所称公共数据，是指国家机关依法履行职责过程中收集、产生的数据。"));
    const [topic] = await upsertConceptPages(project, ["公共数据"], sourcePath, "安徽省人民代表大会常务委员会", "安徽省人民代表大会常务委员会");
    const parsed = parseMarkdown(await readWikiFile(project, topic));
    expect(parsed.frontmatter.sources).toEqual([sourcePath]);
    expect(parsed.body).not.toContain("等待更多来源沉淀");
    const definition = parsed.body.split("## 定义")[1].split("## 来源笔记")[0];
    expect(definition).toContain("本条例所称公共数据");
    expect(definition).toContain(`[[${sourcePath}|`);
    expect(parsed.body.split("## 来源笔记")[1]).toContain("本条例所称公共数据");
  });
  it("merges exact source paths without replacing an edited definition or duplicating notes", async () => {
    const project = await makeProject();
    const [topic] = await upsertConceptPages(project, ["数据管理"], "wiki/sources/first.md", "第一份来源", "数据管理应当保障数据安全，保护合法权益。");
    const initial = parseMarkdown(await readWikiFile(project, topic));
    await writeWikiFile(project, topic, serializeMarkdown(initial.frontmatter, initial.body.replace(/(## 定义\s+)[\s\S]*?(?=\n## 来源笔记)/, "$1人工维护的定义与适用范围。\n")));
    await upsertConceptPages(project, ["数据管理"], "wiki/sources/second.md", "第二份来源", "数据管理部门应当依法提供公共数据服务。");
    await upsertConceptPages(project, ["数据管理"], "wiki/sources/second.md", "第二份来源", "不应重复写入。");
    const parsed = parseMarkdown(await readWikiFile(project, topic));
    expect(parsed.frontmatter.sources).toEqual(["wiki/sources/first.md", "wiki/sources/second.md"]);
    expect(parsed.body).toContain("人工维护的定义与适用范围");
    expect(parsed.body).not.toContain("不应重复写入");
  });
  it("does not invent a definition when the only available text is a publisher name", async () => {
    const project = await makeProject();
    const [topic] = await upsertEntityPages(project, ["安徽省人大常委会"], "wiki/sources/title-only.md", "安徽省人大常委会", "安徽省人大常委会");
    const parsed = parseMarkdown(await readWikiFile(project, topic));
    expect(parsed.frontmatter.sources).toEqual(["wiki/sources/title-only.md"]);
    expect(parsed.body).toContain("没有提供可用的正文说明");
    expect(parsed.body).not.toContain("等待更多来源沉淀");
  });
  it("repairs old same-source title-only notes using converted text and is idempotent", async () => {
    const project = await makeProject();
    const source = "wiki/sources/legacy.md", topic = "wiki/concepts/data.md";
    await writeProjectFile(project, source, "# 安徽省人大常委会\n\n## 摘要\n\n安徽省人大常委会\n\n## 全文 Markdown\n\n- [[wiki/sources/converted/legacy.md|全文]]");
    await writeProjectFile(project, "wiki/sources/converted/legacy.md", "# 转换全文\n\n第二条 公共数据是指国家机关依法履行职责过程中产生的数据。");
    await writeProjectFile(project, topic, serializeMarkdown({ title: "公共数据", type: "concept", sources: [] },
      `# 公共数据\n\n## 定义\n\n_等待更多来源沉淀。_\n\n## 来源笔记\n\n### 安徽省人大常委会\n\n来源：[[${source}|安徽省人大常委会]]\n来源路径：\`${source}\`\n\n安徽省人大常委会`));
    expect(await repairGeneratedTopicPages(project)).toEqual({ repaired: 1, skipped: 0 });
    const repaired = await readWikiFile(project, topic);
    expect(parseMarkdown(repaired).frontmatter.sources).toEqual([source]);
    expect(repaired.split("## 来源笔记")[1]).toContain("公共数据是指");
    expect(await repairGeneratedTopicPages(project)).toEqual({ repaired: 0, skipped: 1 });
    expect(await readWikiFile(project, topic)).toBe(repaired);
  });
  it("upgrades an existing empty source note without adding a duplicate block", async () => {
    const project = await makeProject();
    const source = "wiki/sources/upgrade.md";
    const [topic] = await upsertConceptPages(project, ["公共数据"], source, "安徽省人大常委会", "安徽省人大常委会");
    await upsertConceptPages(project, ["公共数据"], source, "安徽省人大常委会", "公共数据应当按照分类分级要求进行管理。");
    const body = parseMarkdown(await readWikiFile(project, topic)).body;
    expect(body.match(/^### /gm)).toHaveLength(1);
    expect(body.split("## 来源笔记")[1]).toContain("公共数据应当按照分类分级要求");
    expect(body).not.toContain("没有提供可用的正文说明");
  });
  it("keeps substantive human descriptions and source notes unchanged during repair", async () => {
    const project = await makeProject();
    const source = "wiki/sources/manual.md", topic = "wiki/concepts/manual.md";
    await writeProjectFile(project, source, "# 数据管理\n\n## 摘录\n\n数据管理应当采取安全保护措施。");
    const body = `# 数据管理\n\n## 定义\n\n人工定义，含对适用范围的解释。\n\n## 来源笔记\n\n### 数据管理\n\n来源：[[${source}|数据管理]]\n来源路径：\`${source}\`\n\n人工审阅笔记，需与实际业务要求核对。`;
    await writeProjectFile(project, topic, serializeMarkdown({ title: "数据管理", type: "concept", sources: [source] }, body));
    const before = await readWikiFile(project, topic);
    expect(await repairGeneratedTopicPages(project)).toEqual({ repaired: 0, skipped: 1 });
    expect(await readWikiFile(project, topic)).toBe(before);
  });
  it("removes generated descriptions of deleted evidence while preserving manual text", async () => {
    const project = await makeProject();
    const source = "wiki/sources/deleted.md";
    const [topic] = await upsertConceptPages(project, ["公共数据"], source, "来源一", "公共数据是指依法履行职责过程中产生的数据。");
    const generated = parseMarkdown(await readWikiFile(project, topic));
    await writeWikiFile(project, topic, serializeMarkdown(generated.frontmatter, `${generated.body}\n\n## 人工备注\n\n人工维护的内容。`));
    await removeSourceEvidence(project, [source]);
    const content = await readWikiFile(project, topic);
    expect(content).not.toContain(source);
    expect(content).not.toContain("公共数据是指依法履行职责");
    expect(content).toContain("人工维护的内容");
    expect(parseMarkdown(content).frontmatter.sources).toEqual([]);
  });
  it("keeps concurrent notes for one newly created topic in the same page", async () => {
    const project = await makeProject();
    const paths = await Promise.all([
      upsertConceptPages(project, ["公共数据"], "wiki/sources/a.md", "来源甲", "公共数据应当依法管理。"),
      upsertConceptPages(project, ["公共数据"], "wiki/sources/b.md", "来源乙", "公共数据应当落实安全保障责任。")
    ]);
    expect(paths[0][0]).toBe(paths[1][0]);
    const parsed = parseMarkdown(await readWikiFile(project, paths[0][0]));
    expect(parsed.frontmatter.sources).toEqual(expect.arrayContaining(["wiki/sources/a.md", "wiki/sources/b.md"]));
    expect(parsed.body).toContain("公共数据应当依法管理");
    expect(parsed.body).toContain("公共数据应当落实安全保障责任");
  });
  it("does not overwrite concurrent answers with the same question", async () => {
    const project = await makeProject();
    const paths = await Promise.all([
      saveQueryAnswer(project, "同一个问题", "第一份回答", []),
      saveQueryAnswer(project, "同一个问题", "第二份回答", [])
    ]);
    expect(new Set(paths).size).toBe(2);
    expect(await readWikiFile(project, paths[0])).toContain("第一份回答");
    expect(await readWikiFile(project, paths[1])).toContain("第二份回答");
  });
  it("keeps root navigation documents visible when the sidebar scan is limited", async () => {
    const project = await makeProject();
    await writeWikiFile(project, "wiki/log.md", "# 摄入日志");
    await writeWikiFile(project, "wiki/overview.md", "# 知识库总览");
    for (const name of ["alpha", "beta", "gamma", "delta"]) await writeWikiFile(project, `wiki/concepts/${name}.md`, `# ${name}`);
    const page = await listWikiFilesPage(project, { limit: 3 });
    expect(page.files.map((file) => file.path)).toEqual(expect.arrayContaining(["wiki/index.md", "wiki/log.md", "wiki/overview.md"]));
    expect(page.limited).toBe(true);
  });
  it("keeps generated links precise when a source and concept share a title", async () => {
    const project = await makeProject();
    await writeWikiFile(project, "wiki/concepts/company.md", "---\ntitle: 公司章程\ntype: concept\n---\n# 公司章程");
    await writeWikiFile(project, "wiki/sources/company.md", "---\ntitle: 公司章程\ntype: source\n---\n# 公司章程");
    await updateIndex(project);
    const index = await readWikiFile(project, "wiki/index.md");
    expect(index).toContain("[[wiki/concepts/company.md|公司章程]]");
    expect(index).toContain("[[wiki/sources/company.md|公司章程]]");
  });
  it("keeps separate notes from different sources with the same title", async () => {
    const project = await makeProject();
    const [concept] = await upsertConceptPages(project, ["公司章程"], "wiki/sources/one.md", "同名材料", "第一份材料。");
    await upsertConceptPages(project, ["公司章程"], "wiki/sources/two.md", "同名材料", "第二份材料。");
    await upsertConceptPages(project, ["公司章程"], "wiki/sources/two.md", "同名材料", "重复的材料。");
    const content = await readWikiFile(project, concept);
    expect(content).toContain("第一份材料。");
    expect(content).toContain("第二份材料。");
    expect(content).not.toContain("重复的材料。");
    expect(content).toContain("[[wiki/sources/two.md|同名材料]]");
  });
  it("initializes a valid log page without duplicating its heading", async () => {
    const project = await makeProject();
    await appendLog(project, "第一条记录"); await appendLog(project, "第二条记录");
    const parsed = parseMarkdown(await readWikiFile(project, "wiki/log.md"));
    expect(parsed.frontmatter.type).toBe("log");
    expect(parsed.body.match(/# 摄入日志/g)).toHaveLength(1);
    expect(parsed.body).toContain("第二条记录");
  });
  it("rejects wiki paths that normalize outside the wiki directory", async () => {
    const project = await makeProject();
    await expect(readWikiFile(project, "wiki/../.llm-wiki/settings.json")).rejects.toMatchObject({ status: 400 });
    await expect(writeWikiFile(project, "wiki/../.llm-wiki/settings.json", "{}")).rejects.toMatchObject({ status: 400 });
  });
  it("rejects legacy root metadata files", async () => {
    const project = await makeProject("legacy-root-files");
    await expect(readWikiFile(project, "purpose.md")).rejects.toMatchObject({ status: 400 });
    await expect(writeWikiFile(project, "schema.md", "# Legacy")).rejects.toMatchObject({ status: 400 });
  });

  it("uses source notes as readable titles for low-information topic pages", async () => {
    const project = await makeProject("标题修复测试");
    await writeProjectFile(
      project,
      "wiki/concepts/000.md",
      serializeMarkdown(
        {
          title: "000",
          type: "concept",
          tags: ["concept"],
          sources: []
        },
        [
          "# 000",
          "",
          "## 定义",
          "",
          "_等待更多来源沉淀。_",
          "",
          "## 来源笔记",
          "",
          "### 汉中市人民代表大会常务委员会",
          "",
          "来源：[[汉中市人民代表大会常务委员会]]",
          "来源路径：`wiki/sources/汉中市人民代表大会常务委员会-2.md`",
          "",
          "关于加强天汉湿地公园保护管理的决定。"
        ].join("\n")
      )
    );

    const page = await listWikiFilesPage(project, { query: "000", includeTotal: true });
    expect(page.files[0]?.title).toBe("汉中市人民代表大会常务委员会（000）");

    const content = await readWikiFile(project, "wiki/concepts/000.md");
    expect(content).toContain("title: 汉中市人民代表大会常务委员会（000）");
    expect(content).toContain("- '000'");
    expect(content).toContain("# 汉中市人民代表大会常务委员会（000）");
  });

  it("keeps filename aliases available for legacy wikilinks", async () => {
    const project = await makeProject("短链接修复测试");
    await writeProjectFile(
      project,
      "wiki/concepts/000.md",
      serializeMarkdown(
        {
          title: "000",
          type: "concept",
          tags: ["concept"],
          sources: []
        },
        [
          "# 000",
          "",
          "## 来源笔记",
          "",
          "### 汉中市人民代表大会常务委员会",
          "",
          "来源：[[汉中市人民代表大会常务委员会]]",
          "来源路径：`wiki/sources/汉中市人民代表大会常务委员会-2.md`"
        ].join("\n")
      )
    );

    const page = await listWikiFilesPage(project, { includeTotal: true });
    const linkMap = titleToWikiLinkMap(page.files);

    expect(linkMap.get("000")?.path).toBe("wiki/concepts/000.md");
  });

  it("uses source content to display readable titles for untitled source pages", async () => {
    const project = await makeProject("来源标题修复测试");
    await writeProjectFile(
      project,
      "wiki/sources/untitled-3ab4d5f9.md",
      serializeMarkdown(
        {
          title: "未命名来源 Markdown",
          type: "source",
          tags: ["source"],
          sources: []
        },
        [
          "# 未命名来源 Markdown",
          "",
          "URL: https://example.com/smoke",
          "",
          "## 摘要",
          "",
          "原文包含无法识别字符，请重新上传原始文件或检查编码。"
        ].join("\n")
      )
    );

    const page = await listWikiFilesPage(project, { query: "untitled", includeTotal: true });
    expect(page.files[0]?.title).toBe("example.com/smoke");

    const content = await readWikiFile(project, "wiki/sources/untitled-3ab4d5f9.md");
    expect(content).toContain("title: example.com/smoke");
    expect(content).toContain("- 未命名来源 Markdown");
    expect(content).toContain("# example.com/smoke");
  });

  it("can stop early when listing wiki pages for large sidebars", async () => {
    const project = await makeProject("快速列表测试");
    for (const name of ["alpha", "beta", "gamma"]) {
      await writeProjectFile(
        project,
        `wiki/concepts/${name}.md`,
        serializeMarkdown(
          {
            title: name,
            type: "concept",
            tags: ["concept"],
            sources: []
          },
          `# ${name}`
        )
      );
    }

    const quick = await listWikiFilesPage(project, { limit: 2 });
    expect(quick.files).toHaveLength(2);
    expect(quick.total).toBe(2);
    expect(quick.limited).toBe(true);

    const counted = await listWikiFilesPage(project, { limit: 2, includeTotal: true });
    expect(counted.files).toHaveLength(2);
    expect(counted.total).toBeGreaterThan(2);
    expect(counted.limited).toBe(false);
  });

  it("preserves created timestamps when rewriting generated source pages", async () => {
    const project = await makeProject("来源元数据测试");
    const analysis = {
      title: "公司章程",
      summary: "公司章程材料摘要。",
      keyPoints: ["股东出资"],
      concepts: ["公司章程"],
      entities: ["测试公司"],
      questions: [],
      confidence: 0.8
    };

    const sourcePath = await writeSourcePage(project, {
      analysis,
      sourcePath: "raw/sources/company.txt",
      sourceId: "s-1",
      sha256: "sha-a",
      kind: "text",
      excerpt: "公司章程与股东出资。"
    });
    const convertedPath = await writeConvertedSourcePage(project, {
      title: "公司章程",
      sourcePath: "raw/sources/company.txt",
      sourceId: "s-1",
      sha256: "sha-a",
      kind: "text",
      markdown: "# 公司章程\n\n第一版。",
      assets: [],
      warnings: []
    });
    const firstSourceCreated = parseMarkdown(await readWikiFile(project, sourcePath)).frontmatter.created;
    const firstConvertedCreated = parseMarkdown(await readWikiFile(project, convertedPath)).frontmatter.created;

    await writeSourcePage(project, {
      analysis: { ...analysis, summary: "公司章程材料更新摘要。" },
      sourcePath: "raw/sources/company.txt",
      sourceId: "s-1",
      sha256: "sha-b",
      kind: "text",
      excerpt: "公司章程与股东出资，第二版。",
      wikiPath: sourcePath
    });
    await writeConvertedSourcePage(project, {
      title: "公司章程",
      sourcePath: "raw/sources/company.txt",
      sourceId: "s-1",
      sha256: "sha-b",
      kind: "text",
      markdown: "# 公司章程\n\n第二版。",
      assets: [],
      warnings: [],
      existingPath: convertedPath
    });

    const secondSource = parseMarkdown(await readWikiFile(project, sourcePath)).frontmatter;
    const secondConverted = parseMarkdown(await readWikiFile(project, convertedPath)).frontmatter;
    expect(secondSource.created).toBe(firstSourceCreated);
    expect(secondSource.source_sha256).toBe("sha-b");
    expect(secondConverted.created).toBe(firstConvertedCreated);
    expect(secondConverted.source_sha256).toBe("sha-b");
  });
});
