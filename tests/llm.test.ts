import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeOffline, chatCompletion, hasLiveModel, resolveModelSettings } from "../server/lib/llm.js";
import { DEFAULT_SETTINGS } from "../server/lib/storage.js";

describe("llm helpers", () => {
  it("rejects corrupted provider output instead of returning it as a normal answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "乱码\uFFFD答案" } }] })));
    expect(await chatCompletion({ ...DEFAULT_SETTINGS, provider: "custom", model: "qwen", baseUrl: "http://localhost:8080" }, [{ role: "user", content: "test" }])).toBeNull();
  });
  it("rejects a missing or disabled selected model instead of silently using another model", () => {
    const settings = { ...DEFAULT_SETTINGS, activeModelId: "active", modelProfiles: [
      { id: "active", name: "active", provider: "custom" as const, model: "qwen", baseUrl: "http://localhost:8080", enabled: true },
      { id: "disabled", name: "disabled", provider: "custom" as const, model: "qwen", baseUrl: "http://localhost:8080", enabled: false }
    ] };
    expect(() => resolveModelSettings(settings, "missing")).toThrow(/模型/);
    expect(() => resolveModelSettings(settings, "disabled")).toThrow(/模型/);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("detects when a live model is configured", () => {
    expect(hasLiveModel(DEFAULT_SETTINGS)).toBe(false);
    expect(hasLiveModel({ ...DEFAULT_SETTINGS, provider: "ollama", baseUrl: "http://localhost:11434", model: "qwen" })).toBe(true);
    expect(hasLiveModel({ ...DEFAULT_SETTINGS, provider: "openai", apiKey: "key", baseUrl: "https://api.openai.com/v1", model: "gpt" })).toBe(true);
  });

  it("uses the compatible Ollama endpoint and forwards proxy credentials for /v1 URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await chatCompletion({ ...DEFAULT_SETTINGS, provider: "ollama", baseUrl: "http://localhost:11434/v1/", apiKey: "proxy-key", model: "qwen" }, [{ role: "user", content: "测试" }])).toBe("OK");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:11434/v1/chat/completions");
    expect(fetchMock.mock.calls[0]?.[1]?.headers.authorization).toBe("Bearer proxy-key");
  });

  it("forwards optional proxy credentials to native Ollama", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: { content: "OK" } })));
    vi.stubGlobal("fetch", fetchMock);
    await chatCompletion({ ...DEFAULT_SETTINGS, provider: "ollama", baseUrl: "http://localhost:11434", apiKey: "proxy-key", model: "qwen" }, [{ role: "user", content: "测试" }]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers.authorization).toBe("Bearer proxy-key");
  });

  it("creates offline analysis without question mark garbage", () => {
    const result = analyzeOffline(
      "公司章程",
      "# 公司章程\n\n公司章程应当载明公司名称、住所、经营范围、注册资本和股东出资方式。"
    );
    expect(result.title).toBe("公司章程");
    expect(result.summary).toContain("公司章程");
    expect(result.questions.join("\n")).not.toContain("?".repeat(4));
  });

  it("continues a chat answer when the provider reports output truncation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "第一段还没有结束，" }, finish_reason: "length" }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "这里继续补完整个回答。" }, finish_reason: "stop" }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const answer = await chatCompletion(
      {
        ...DEFAULT_SETTINGS,
        provider: "openai",
        apiKey: "key",
        baseUrl: "https://example.test/v1",
        model: "gpt-test"
      },
      [{ role: "user", content: "请完整回答这个问题。" }]
    );

    expect(answer).toContain("第一段还没有结束");
    expect(answer).toContain("这里继续补完整个回答");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const firstBody = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
    expect(firstBody.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(JSON.stringify(secondBody.messages)).toContain("输出上限截断");
  });
});
