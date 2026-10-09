import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerQuestion, searchProject } from "../server/lib/search.js";
import { writeSettings, writeSources } from "../server/lib/storage.js";
import * as storage from "../server/lib/storage.js";
import type { Project } from "../server/types.js";

const fixtureRoot = path.resolve("qa-artifacts/search-review-tmp");
const projectRoots: string[] = [];

async function isolatedProject(): Promise<Project> {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(fixtureRoot, "project-"));
  projectRoots.push(root);
  const timestamp = new Date().toISOString();
  const project = { id: path.basename(root), root, name: "Search review", description: "", createdAt: timestamp, updatedAt: timestamp };
  await writeSettings(project, { provider: "offline", modelProfiles: [], webSearchProvider: "none", skills: [], mcpServers: [] });
  return project;
}

async function wikiPage(project: Project, name: string, title: string, body: string): Promise<void> {
  const file = path.join(project.root, "wiki", "sources", `${name}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `---\ntitle: ${title}\ntype: source\n---\n${body}`, "utf8");
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of projectRoots.splice(0)) {
    if (path.dirname(root) !== fixtureRoot) throw new Error("Unexpected fixture path");
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("local retrieval evidence regressions", () => {
  it.each(["解释", "说明", "呢"])("preserves the previous topic for the bare follow-up %s", async (query) => {
    const project = await isolatedProject();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network in local retrieval test"));
    await wikiPage(project, "lease", "Alpha lease", "Alpha lease obligations require written consent.");
    const first = await answerQuestion(project, { query: "Alpha lease", useHistory: false });
    expect(first.hits.map((hit) => hit.path)).toContain("wiki/sources/lease.md");
    const next = await answerQuestion(project, { query, chatId: first.chat.id, useHistory: true });
    expect(next.hits.map((hit) => hit.path)).toContain("wiki/sources/lease.md");
    expect(next.answer).toContain("written consent");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["解释Betelgeuse", "说明Betelgeuse"])("retrieves an explicit new topic in %s", async (query) => {
    const project = await isolatedProject();
    await wikiPage(project, "lease", "Alpha lease", "Alpha lease obligations require written consent.");
    await wikiPage(project, "astronomy", "Betelgeuse", "Betelgeuse is a red supergiant.");
    const first = await answerQuestion(project, { query: "Alpha lease", useHistory: false });
    const next = await answerQuestion(project, { query, chatId: first.chat.id, useHistory: true });
    expect(next.hits.map((hit) => hit.path)).toContain("wiki/sources/astronomy.md");
    expect(next.hits.some((hit) => hit.path.includes("lease"))).toBe(false);
  });

  it("keeps the highest-scoring late hit with bounded concurrent reads beyond 4000 files", async () => {
    const project = await isolatedProject();
    const files = Array.from({ length: 4100 }, (_, index) => `sources/page-${String(index).padStart(4, "0")}.md`);
    files.push("sources/z-last.md");
    vi.spyOn(storage, "listFiles").mockResolvedValue(files);
    let activeReads = 0;
    let peakReads = 0;
    const readMock = vi.spyOn(storage, "readText").mockImplementation(async (file) => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeReads -= 1;
      return `# Evidence\n${file.endsWith("z-last.md") ? "Tailneedle ".repeat(30) : "Tailneedle reference."}`;
    });
    const hits = await searchProject(project, "Tailneedle", { limit: 3 });
    expect(readMock).toHaveBeenCalledTimes(4101);
    expect(peakReads).toBeGreaterThan(1);
    expect(peakReads).toBeLessThanOrEqual(16);
    expect(hits.map((hit) => hit.path)).toEqual([
      "wiki/sources/z-last.md", "wiki/sources/page-0000.md", "wiki/sources/page-0001.md"
    ]);
  });

  it("retrieves the current topic when twelve higher-scoring history pages would crowd it out", async () => {
    const project = await isolatedProject();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network in local retrieval test"));
    for (let index = 0; index < 12; index += 1) {
      await wikiPage(project, `lease-${index}`, "Alpha lease", "Alpha lease obligations. ".repeat(80));
    }
    await wikiPage(project, "astronomy", "Astronomy facts", "Betelgeuse is a red supergiant. Betelgeuse has a variable brightness.");
    const first = await answerQuestion(project, { query: "Alpha lease", useHistory: false });
    const next = await answerQuestion(project, { query: "Betelgeuse", chatId: first.chat.id, useHistory: true });
    expect(next.hits.map((hit) => hit.path)).toContain("wiki/sources/astronomy.md");
    expect(next.hits.some((hit) => hit.path.includes("lease-"))).toBe(false);
    expect(next.answer).toContain("red supergiant");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("selects an excerpt around a body match when the first query token occurs only in the title", async () => {
    const project = await isolatedProject();
    await wikiPage(project, "late-fact", "Alpha", `${"Background unrelated to the question. ".repeat(30)}Beta is the required factual evidence.`);
    const hits = await searchProject(project, "Alpha Beta");
    expect(hits).toHaveLength(1);
    expect(hits[0].excerpt).toContain("Beta is the required factual evidence");
  });

  it("selects registry summary evidence around the token found in the summary", async () => {
    const project = await isolatedProject();
    await writeSources(project, [{
      id: "late-summary", fileName: "alpha.txt", title: "Alpha", relativePath: "raw/sources/alpha.txt", kind: "text", size: 10, sha256: "test",
      summary: `${"Background unrelated to the question. ".repeat(30)}Beta is the required registry evidence.`,
      importedAt: project.createdAt, updatedAt: project.updatedAt, status: "ready"
    }]);
    const hits = await searchProject(project, "Alpha Beta", { includeRaw: true });
    expect(hits).toHaveLength(1);
    expect(hits[0].excerpt).toContain("Beta is the required registry evidence");
  });
});
