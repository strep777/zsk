import { describe, expect, it } from "vitest";
import { buildKnowledgeGraph } from "../server/lib/graph.js";
import { lintProject } from "../server/lib/lint.js";
import { writeSources } from "../server/lib/storage.js";
import { writeWikiFile } from "../server/lib/wiki.js";
import { makeProject, writeProjectFile } from "./helpers.js";

describe("graph and lint", () => {
  it("does not misreport source pages outside a limited scan as missing", async () => {
    const project = await makeProject();
    await writeProjectFile(project, "raw/sources/a.txt", "原文");
    await writeWikiFile(project, "wiki/sources/a.md", "# 来源页面");
    await writeWikiFile(project, "wiki/sources/converted/a.md", "# 转换全文");
    await writeSources(project, [{ id: "a", fileName: "a.txt", relativePath: "raw/sources/a.txt", kind: "text", size: 6, sha256: "sha", importedAt: "", updatedAt: "", status: "ready", wikiPath: "wiki/sources/a.md", convertedPath: "wiki/sources/converted/a.md" }]);
    const titles = (await lintProject(project, { limit: 1 })).map((issue) => issue.title);
    expect(titles).not.toContain("来源页丢失");
    expect(titles).not.toContain("转换全文丢失");
    expect(titles).toContain("体检范围受限");
  });
  it("builds edges from wiki links and shared sources", async () => {
    const project = await makeProject();
    await writeWikiFile(
      project,
      "wiki/concepts/a.md",
      "---\ntitle: Alpha concept\ntype: concept\ntags: [concept]\nsources: [raw/sources/a.txt]\n---\n# Alpha concept\n\n[[Beta concept]]"
    );
    await writeWikiFile(
      project,
      "wiki/concepts/b.md",
      "---\ntitle: Beta concept\ntype: concept\ntags: [concept]\nsources: [raw/sources/a.txt]\n---\n# Beta concept\n\nContent"
    );
    const graph = await buildKnowledgeGraph(project);
    expect(graph.nodes.some((node) => node.title === "Alpha concept")).toBe(true);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.insights.length).toBeGreaterThan(0);
  });

  it("filters formatting artifact nodes and assigns usable coordinates", async () => {
    const project = await makeProject();
    await writeWikiFile(
      project,
      "wiki/concepts/span.md",
      "---\ntitle: '[span]'\ntype: concept\ntags: [concept]\nsources: []\n---\n# [span]\n\nHTML artifact."
    );
    await writeWikiFile(
      project,
      "wiki/concepts/alpha.md",
      "---\ntitle: Alpha node\ntype: concept\ntags: [concept]\nsources: [raw/sources/alpha.txt]\n---\n# Alpha node\n\n[[Beta node]]"
    );
    await writeWikiFile(
      project,
      "wiki/concepts/beta.md",
      "---\ntitle: Beta node\ntype: concept\ntags: [concept]\nsources: [raw/sources/alpha.txt]\n---\n# Beta node\n\nRelated content."
    );

    const graph = await buildKnowledgeGraph(project);

    expect(graph.nodes.map((node) => node.title)).not.toContain("[span]");
    expect(graph.nodes.map((node) => node.title)).toEqual(expect.arrayContaining(["Alpha node", "Beta node"]));
    expect(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it("reports broken links, duplicate titles, and failed sources", async () => {
    const project = await makeProject();
    await writeWikiFile(project, "wiki/concepts/a.md", "# 重复标题\n\n[[不存在]]");
    await writeWikiFile(project, "wiki/entities/a.md", "# 重复标题\n\n内容");
    await writeSources(project, [
      {
        id: "failed",
        fileName: "bad.txt",
        relativePath: "raw/sources/bad.txt",
        kind: "text",
        size: 1,
        sha256: "sha",
        importedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "failed",
        error: "解析失败"
      }
    ]);
    const issues = await lintProject(project);
    expect(issues.map((issue) => issue.title)).toContain("断开的 Wikilink");
    expect(issues.map((issue) => issue.title)).toContain("重复标题");
    expect(issues.map((issue) => issue.title)).toContain("来源摄入失败");
  });

  it("reports missing file references from wiki pages and source records", async () => {
    const project = await makeProject();
    await writeWikiFile(
      project,
      "wiki/concepts/ref-check.md",
      "---\ntitle: 引用检查\ntype: concept\ntags: [concept]\nsources: [raw/sources/missing.txt, wiki/sources/missing.md]\n---\n# 引用检查\n\n内容"
    );
    await writeSources(project, [
      {
        id: "ready-missing",
        fileName: "missing.txt",
        relativePath: "raw/sources/missing-record.txt",
        kind: "text",
        size: 1,
        sha256: "sha",
        importedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "ready",
        wikiPath: "wiki/sources/missing-source-page.md",
        convertedPath: "wiki/sources/converted/missing-converted.md"
      }
    ]);

    const issueTitles = (await lintProject(project)).map((issue) => issue.title);

    expect(issueTitles).toContain("来源文件丢失");
    expect(issueTitles).toContain("来源页面丢失");
    expect(issueTitles).toContain("原始文件丢失");
    expect(issueTitles).toContain("来源页丢失");
    expect(issueTitles).toContain("转换全文丢失");
  });
});
