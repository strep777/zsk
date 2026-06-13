import { describe, expect, it } from "vitest";
import { buildKnowledgeGraph } from "../server/lib/graph.js";
import { lintProject } from "../server/lib/lint.js";
import { writeSources } from "../server/lib/storage.js";
import { writeWikiFile } from "../server/lib/wiki.js";
import { makeProject } from "./helpers.js";

describe("graph and lint", () => {
  it("builds edges from wiki links and shared sources", async () => {
    const project = await makeProject();
    await writeWikiFile(
      project,
      "wiki/concepts/a.md",
      "---\ntitle: A\ntype: concept\ntags: [concept]\nsources: [raw/sources/a.txt]\n---\n# A\n\n[[B]]"
    );
    await writeWikiFile(
      project,
      "wiki/concepts/b.md",
      "---\ntitle: B\ntype: concept\ntags: [concept]\nsources: [raw/sources/a.txt]\n---\n# B\n\n内容"
    );
    const graph = await buildKnowledgeGraph(project);
    expect(graph.nodes.some((node) => node.title === "A")).toBe(true);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.insights.length).toBeGreaterThan(0);
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
});
