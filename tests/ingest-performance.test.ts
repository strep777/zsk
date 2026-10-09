import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processProjectQueue, rescanSources } from "../server/lib/ingest.js";
import * as llm from "../server/lib/llm.js";
import * as storage from "../server/lib/storage.js";
import type { Project, QueueItem, SourceRecord } from "../server/types.js";

const fixtureRoot = path.resolve("qa-artifacts/ingest-performance-tmp");
const roots: string[] = [];

async function fixture(count: number): Promise<{ project: Project; sources: SourceRecord[]; queue: QueueItem[] }> {
  await fs.mkdir(fixtureRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(fixtureRoot, "project-"));
  roots.push(root);
  const timestamp = new Date().toISOString();
  const project: Project = { id: path.basename(root), root, name: "隔离摄入性能", description: "", createdAt: timestamp, updatedAt: timestamp };
  await storage.initializeProject(project);
  const sources: SourceRecord[] = [];
  const queue: QueueItem[] = [];
  for (let index = 0; index < count; index += 1) {
    const relativePath = `raw/sources/document-${index}.txt`;
    await fs.writeFile(path.join(root, relativePath), `# 公司章程资料 ${index}\n\n公司章程载明公司名称、住所和经营范围。股东应当按照约定缴纳出资。`, "utf8");
    const id = `source-${index}`;
    sources.push({ id, fileName: `document-${index}.txt`, relativePath, kind: "text", size: 100, sha256: `sha-${index}`, importedAt: timestamp, updatedAt: timestamp, status: "queued" });
    queue.push({ id: `queue-${index}`, sourceId: id, relativePath, createdAt: timestamp, updatedAt: timestamp, status: "queued" });
  }
  await storage.writeSources(project, sources);
  await storage.writeQueue(project, queue);
  return { project, sources, queue };
}

async function modelSettings(project: Project, model = "synthetic-model"): Promise<void> {
  await storage.writeSettings(project, { provider: "custom", baseUrl: "http://127.0.0.1:1/v1", model, modelProfiles: [{ id: "synthetic", name: "隔离模型", provider: "custom", baseUrl: "http://127.0.0.1:1/v1", model, enabled: true }], activeModelId: "synthetic", webSearchProvider: "none" });
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No real service access in ingestion regression"));
  vi.spyOn(storage, "touchProject").mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== fixtureRoot) throw new Error("Unexpected fixture directory");
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("ingestion work amplification", () => {
  it("does not repeat a failed model wait for every document in the same queue run", async () => {
    const count = 8;
    const { project } = await fixture(count);
    await modelSettings(project);
    let simulatedWaitMs = 0;
    const analysis = vi.spyOn(llm, "analyzeWithModel").mockImplementation(async () => { simulatedWaitMs += 120000; return null; });
    const reads = vi.spyOn(storage, "readSources");
    const writes = vi.spyOn(storage, "writeSources");
    await processProjectQueue(project);
    console.info(`[ingest measurement] documents=${count}, failedModelCalls=${analysis.mock.calls.length}, simulatedModelWaitMs=${simulatedWaitMs}, sourceRegistryReads=${reads.mock.calls.length}, sourceRegistryWrites=${writes.mock.calls.length}`);
    expect(analysis).toHaveBeenCalledTimes(1);
    expect(simulatedWaitMs).toBe(120000);
    const sources = await storage.readSources(project);
    expect(sources.every((source) => source.status === "ready" && source.convertedPath && source.wikiPath && source.summary)).toBe(true);
    expect((await storage.readQueue(project)).every((item) => item.status === "done")).toBe(true);
    const generated = await fs.readFile(path.join(project.root, sources.at(-1)!.wikiPath!), "utf8");
    expect(generated).toContain("离线");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not suppress the next queue run after a previous model failure", async () => {
    const { project, sources, queue } = await fixture(1);
    await modelSettings(project);
    const analysis = vi.spyOn(llm, "analyzeWithModel").mockResolvedValue(null);
    await processProjectQueue(project);
    await storage.writeSources(project, sources);
    await storage.writeQueue(project, queue);
    await processProjectQueue(project);
    expect(analysis).toHaveBeenCalledTimes(2);
  });

  it("attempts the changed model configuration while the same queue is processing", async () => {
    const { project } = await fixture(3);
    await modelSettings(project);
    const analysis = vi.spyOn(llm, "analyzeWithModel").mockImplementation(async (settings, title, text) => {
      if (settings.model === "synthetic-model") { await modelSettings(project, "new-model"); return null; }
      return llm.analyzeOffline(title, text);
    });
    await processProjectQueue(project);
    expect(analysis.mock.calls.map(([settings]) => settings.model)).toEqual(["synthetic-model", "new-model", "new-model"]);
  });

  it("checks existing active queue membership once per batch instead of rescanning for every source", async () => {
    const count = 128;
    const { project, queue } = await fixture(count);
    let membershipReads = 0;
    const measuredQueue = queue.map((item) => ({ ...item, get sourceId() { membershipReads += 1; return item.sourceId; } }));
    const original = storage.readQueue;
    vi.spyOn(storage, "readQueue").mockImplementation((current) => current.id === project.id ? Promise.resolve(measuredQueue) : original(current));
    const result = await rescanSources(project);
    console.info(`[ingest measurement] sources=${count}, queueMembershipReads=${membershipReads}`);
    expect(result).toEqual({ queued: 0, total: count });
    expect(membershipReads).toBeLessThanOrEqual(count * 4);
    expect((await storage.readSources(project)).every((source) => source.status === "queued")).toBe(true);
  });
});
