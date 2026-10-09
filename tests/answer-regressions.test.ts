import { afterEach, describe, expect, it, vi } from "vitest";
import { answerQuestion } from "../server/lib/search.js";
import { testModelConnection } from "../server/lib/llm.js";
import { DEFAULT_SETTINGS, writeSettings } from "../server/lib/storage.js";
import * as storage from "../server/lib/storage.js";
import { searchProject } from "../server/lib/search.js";
import { makeProject } from "./helpers.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("answer regressions", () => {
  it("preserves partial answers and records an explicit incomplete warning when continuation fails", async () => {
    const project = await makeProject();
    await writeSettings(project, { provider: "ollama", model: "qwen", baseUrl: "http://localhost:11434", apiKey: "private-key" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "已确认的第一项内容。" }, done_reason: "length" })))
      .mockRejectedValueOnce(new Error("HTTP 503 private-key"));
    const result = await answerQuestion(project, { query: "合同包含哪些内容" });
    expect(result.answer).toContain("已确认的第一项内容。");
    expect(result.answer).toContain("模型回答未完成：");
    expect(result.answer).toContain("503");
    expect(result.answer).not.toContain("private-key");
    expect(JSON.stringify(result.chat)).toContain("模型回答未完成");
  });

  it("answers with the same Ollama mode that passed the connection test", async () => {
    const project = await makeProject();
    const model = { provider: "ollama" as const, model: "qwen-thinking", baseUrl: "http://localhost:11434", systemPrompt: DEFAULT_SETTINGS.systemPrompt };
    await writeSettings(project, model);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(request.think === false
        ? { message: { content: request.options.num_predict === 256 ? "OK" : "当前知识库中未找到足够的信息。请提供委托事项和双方约定。" }, done_reason: "stop" }
        : { message: { content: "", thinking: "需要先分析合同适用范围。" }, done_reason: "length" }));
    });
    expect((await testModelConnection(model)).response).toBe("OK");
    const result = await answerQuestion(project, { query: "兽装委托合同应该怎么写" });
    expect(result.answer).toContain("请提供委托事项和双方约定");
    expect(result.answer).not.toContain("模型没有返回有效回答");
  });

  it("reports the actual model failure without exposing its API key", async () => {
    const project = await makeProject();
    await writeSettings(project, { provider: "ollama", model: "qwen", baseUrl: "http://localhost:11434", apiKey: "private-key" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("HTTP 401 Bearer private-key"));
    const result = await answerQuestion(project, { query: "兽装委托合同应该怎么写" });
    expect(result.answer).toContain("401");
    expect(result.answer).not.toContain("private-key");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-key");
    expect(result.answer).not.toContain("没有获取到可用的联网搜索结果");
  });

  it("reports thinking-only output without displaying it as a final answer", async () => {
    const project = await makeProject();
    const model = { provider: "ollama" as const, model: "qwen", baseUrl: "http://localhost:11434", systemPrompt: DEFAULT_SETTINGS.systemPrompt };
    await writeSettings(project, model);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ message: { content: "", thinking: "内部思考片段" }, done_reason: "length" })));
    const result = await answerQuestion(project, { query: "兽装委托合同应该怎么写" });
    expect(result.answer).toContain("只返回了思考内容");
    expect(result.answer).not.toContain("内部思考片段");
    await expect(testModelConnection(model)).rejects.toThrow("只返回了思考内容");
  });

  it("searches relevant body text beyond the first 4000 wiki files", async () => {
    const project = await makeProject();
    const files = [...Array.from({ length: 4000 }, (_, index) => `concepts/unrelated-${index}.md`), "sources/late-contract.md"];
    vi.spyOn(storage, "listFiles").mockImplementation(async (_root, options = {}) => options.limit ? files.slice(0, options.limit) : files);
    vi.spyOn(storage, "readText").mockImplementation(async (filePath) => filePath.endsWith("late-contract.md")
      ? "---\ntitle: 制作协议\ntype: source\n---\n# 制作协议\n\n兽装委托合同应明确设计稿确认、材料选用、制作工期与验收约定。"
      : "---\ntitle: 无关条目\ntype: concept\n---\n# 无关条目\n\n地理环境及区域人口资料。");
    const hits = await searchProject(project, "兽装委托合同", { includeRaw: true });
    expect(hits.map((hit) => hit.path)).toContain("wiki/sources/late-contract.md");
  });
});
