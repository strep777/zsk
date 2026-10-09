import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createResearchTask,
  deleteResearchTask,
  listResearchTasks,
  readResearchTask,
  runResearch,
  runResearchTask
} from "../server/lib/research.js";
import { serializeMarkdown } from "../server/lib/markdown.js";
import { writeSettings } from "../server/lib/storage.js";
import { makeProject, writeProjectFile } from "./helpers.js";

describe("research notes", () => {
  it("preserves summary mode in persisted tasks even with an active live model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const project = await makeProject();
    await writeSettings(project, { provider: "ollama" });
    const task = await createResearchTask(project, { topic: "摘要研究", modelId: "summary" });
    expect(task.modelId).toBe("summary");
    await runResearchTask(project, task.id);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/chat"))).toBe(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses local knowledge base evidence when external search is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const project = await makeProject("深度研究测试");
    await writeProjectFile(
      project,
      "wiki/sources/company-charter.md",
      serializeMarkdown(
        {
          title: "公司章程示例",
          type: "source",
          tags: ["source"],
          sources: []
        },
        [
          "# 公司章程示例",
          "",
          "公司章程应当记载公司名称、住所、经营范围、注册资本、股东姓名或者名称等事项。"
        ].join("\n")
      )
    );

    const result = await runResearch(project, { topic: "公司章程" });
    expect(result.markdown).toContain("## 本地知识库证据");
    expect(result.markdown).toContain("公司章程示例");
    expect(result.markdown).toContain("wiki/sources/company-charter.md");
  });

  it("collects local evidence from all research queries", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const project = await makeProject("多查询研究测试");
    await writeProjectFile(
      project,
      "wiki/sources/house-certificate.md",
      serializeMarkdown(
        {
          title: "房产证办理材料",
          type: "source",
          tags: ["source"],
          sources: []
        },
        "# 房产证办理材料\n\n房产证办理通常需要不动产登记申请、权属来源材料和身份证明。"
      )
    );

    const result = await runResearch(project, {
      topic: "历史房屋改建",
      queries: ["历史房屋改建", "房产证办理材料"]
    });

    expect(result.markdown).toContain("房产证办理材料");
    expect(result.markdown).toContain("wiki/sources/house-certificate.md");
  });

  it("persists research task progress and final results", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const project = await makeProject("深度研究任务测试");
    await writeProjectFile(
      project,
      "wiki/sources/company-charter.md",
      serializeMarkdown(
        {
          title: "公司章程示例",
          type: "source",
          tags: ["source"],
          sources: []
        },
        "# 公司章程示例\n\n公司章程应当记载注册资本和股东信息。"
      )
    );

    const task = await createResearchTask(project, { topic: "公司章程" });
    expect(task.status).toBe("queued");
    expect(task.steps.map((step) => step.status)).toEqual(["pending", "pending", "pending", "pending"]);

    const done = await runResearchTask(project, task.id);
    expect(done.status).toBe("done");
    expect(done.progress).toBe(100);
    expect(done.result?.markdown).toContain("## 本地知识库证据");
    expect(done.result?.path).toMatch(/^wiki\/research\/.+\.md$/);

    const loaded = await readResearchTask(project, task.id);
    expect(loaded.steps.every((step) => step.status === "done")).toBe(true);
    await expect(listResearchTasks(project)).resolves.toEqual([loaded]);
    await expect(deleteResearchTask(project, task.id)).resolves.toBe(true);
    await expect(listResearchTasks(project)).resolves.toEqual([]);
    await expect(readResearchTask(project, task.id)).rejects.toMatchObject({ status: 404 });
  });
  it("keeps queued research records intact when asked to delete them", async () => {
    const project = await makeProject();
    const task = await createResearchTask(project, { topic: "正在研究的主题" });
    await expect(deleteResearchTask(project, task.id)).rejects.toMatchObject({ status: 409 });
    expect((await readResearchTask(project, task.id)).status).toBe("queued");
  });
  it("keeps simultaneous research outputs separate even within the same millisecond", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const project = await makeProject();
    vi.spyOn(Date, "now").mockReturnValue(1790000000000);
    const results = await Promise.all([
      runResearch(project, { topic: "并发同名研究", modelId: "summary" }),
      runResearch(project, { topic: "并发同名研究", modelId: "summary" })
    ]);
    expect(new Set(results.map((result) => result.path)).size).toBe(2);
  });
  it("preserves Unicode model profile IDs in persisted research tasks", async () => {
    const project = await makeProject();
    await writeSettings(project, { modelProfiles: [{ id: "模型-中文", name: "中文模型", model: "qwen", baseUrl: "http://localhost:11434", provider: "ollama", enabled: true }] });
    const task = await createResearchTask(project, { topic: "模型选择", modelId: "模型-中文" });
    expect(task.modelId).toBe("模型-中文");
  });
  it("deduplicates repeated active research and limits pending task counts", async () => {
    const project = await makeProject();
    const [one, duplicate] = await Promise.all([
      createResearchTask(project, { topic: "重复任务", modelId: "summary" }),
      createResearchTask(project, { topic: "重复任务", modelId: "summary" })
    ]);
    expect(duplicate.id).toBe(one.id);
    await createResearchTask(project, { topic: "另一个任务", modelId: "summary" });
    await expect(createResearchTask(project, { topic: "超过并发上限", modelId: "summary" })).rejects.toMatchObject({ status: 409 });
    expect(await listResearchTasks(project)).toHaveLength(2);
  });
});
