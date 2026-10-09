import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeWithModel, chatCompletion, chatCompletionWithDiagnostics, testModelConnection, type RuntimeModelSettings } from "../server/lib/llm.js";
import { DEFAULT_SETTINGS } from "../server/lib/storage.js";

const settings: RuntimeModelSettings = {
  provider: "custom", model: "fixture-model", baseUrl: "https://model.example.test/v1",
  apiKey: "fixture-secret", systemPrompt: ""
};
const messages = [{ role: "user" as const, content: "完整说明处理步骤。" }];
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const compatible = (content: string, finishReason = "stop") => json({ choices: [{ message: { content }, finish_reason: finishReason }] });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const nativeSettings: RuntimeModelSettings = { ...settings, provider: "ollama", baseUrl: "https://model.example.test" };
function streamed(records: unknown[], signal?: AbortSignal, delays?: number[]): Response {
  const encoder = new TextEncoder();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let abort: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => controller.error(signal?.reason || new Error("aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      records.forEach((record, index) => {
        const emit = () => { controller.enqueue(encoder.encode(JSON.stringify(record) + "\n")); if (index === records.length - 1) controller.close(); };
        if (delays) timers.push(setTimeout(emit, delays[index])); else emit();
      });
    },
    cancel() { timers.forEach(clearTimeout); signal?.removeEventListener("abort", abort); }
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}

describe("model answer review", () => {
  it("collects an actively generating native answer beyond the old total timeout while keeping the short test bounded", async () => {
    vi.useFakeTimers(); vi.stubEnv("LLM_WIKI_MODEL_TIMEOUT_MS", "40"); vi.stubEnv("LLM_WIKI_OLLAMA_CHAT_TIMEOUT_MS", "200"); vi.resetModules();
    const runtime = await import("../server/lib/llm.js");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => JSON.parse(String(init?.body)).options.num_predict === 256
      ? json({ message: { content: "OK" }, done: true })
      : streamed([{ message: { content: "第一部分，" }, done: false }, { message: { content: "完整结论。" }, done: false }, { done: true, done_reason: "stop" }], init?.signal || undefined, [10, 40, 70]));
    vi.stubGlobal("fetch", fetchMock);
    expect((await runtime.testModelConnection(nativeSettings)).response).toBe("OK");
    const answer = runtime.chatCompletionWithDiagnostics(nativeSettings, messages);
    await vi.advanceTimersByTimeAsync(80);
    expect((await answer).content).toBe("第一部分，完整结论。");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).stream).toBe(false);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).stream).toBe(true);
  });

  it("marks a stream ending before its done confirmation incomplete instead of accepting it as a complete answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => streamed([{ message: { content: "已收到的部分答案" }, done: false }], init?.signal || undefined)));
    const result = await chatCompletionWithDiagnostics(nativeSettings, messages);
    expect(result.content).toBe("已收到的部分答案"); expect(result.truncated).toBe(true); expect(result.error).toContain("未完成");
  });

  it("preserves streamed answer text when the native service sends a generation error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => streamed([{ message: { content: "已生成答案，" }, done: false }, { error: "generation failed fixture-secret" }], init?.signal || undefined)));
    const result = await chatCompletionWithDiagnostics(nativeSettings, messages);
    expect(result.content).toBe("已生成答案，"); expect(result.truncated).toBe(true); expect(result.error).toContain("generation failed"); expect(result.error).not.toContain("fixture-secret");
  });

  it("decodes native Chinese stream content split across UTF-8 byte and JSON record boundaries", async () => {
    const bytes = new TextEncoder().encode('{"message":{"content":"中文回答"},"done":false}\n{"done":true,"done_reason":"stop"}\n');
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { "content-type": "application/x-ndjson" } })));
    expect((await chatCompletionWithDiagnostics(nativeSettings, messages)).content).toBe("中文回答");
  });

  it("reads several native records from one chunk and the final record without a trailing newline", async () => {
    const records = '{"message":{"content":"一、"},"done":false}\n{"message":{"content":"核对材料。"},"done":false}\n{"done":true,"done_reason":"stop"}';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(records)); controller.close(); }
    }), { headers: { "content-type": "application/x-ndjson" } })));
    expect(await chatCompletionWithDiagnostics(nativeSettings, messages)).toEqual({ content: "一、核对材料。" });
  });

  it("continues native streamed length-limited output instead of treating its done record as a full answer", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(streamed([{ message: { content: "步骤一。" }, done: true, done_reason: "length" }]))
      .mockResolvedValueOnce(streamed([{ message: { content: "步骤二。" }, done: true, done_reason: "stop" }]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await chatCompletionWithDiagnostics(nativeSettings, messages)).toEqual({ content: "步骤一。\n\n步骤二。" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses a dedicated ingestion JSON instruction instead of a knowledge-base answering instruction", async () => {
    const output = { title: "公司章程", summary: "公司章程规定股东出资方式。", keyPoints: ["股东出资方式"], concepts: [], entities: [], questions: [], confidence: 0.8 };
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return json({ message: { content: String(body.messages[0].content).includes("知识库摄入") ? JSON.stringify(output) : "当前知识库无相关内容。" }, done: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await analyzeWithModel({ ...DEFAULT_SETTINGS, ...nativeSettings, systemPrompt: "只使用已有知识库，否则回复当前知识库无相关内容。" }, "公司章程", "公司章程规定股东出资方式。");
    expect(result?.summary).toBe(output.summary);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.format).toBe("json"); expect(body.options.num_predict).toBeLessThan(4096);
    expect(String(body.messages[0].content)).not.toContain("只使用已有知识库");
  });

  it("falls back to the supplied document title when a valid analysis response has a whitespace title", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: { content: JSON.stringify({ title: "   ", summary: "公司应登记资本。" }) }, done: true })));
    expect((await analyzeWithModel({ ...DEFAULT_SETTINGS, ...nativeSettings }, "公司章程", "公司应登记资本。"))?.title).toBe("公司章程");
  });

  it("keeps partial output on an idle stream timeout and does not issue automatic retry requests", async () => {
    vi.useFakeTimers(); vi.stubEnv("LLM_WIKI_MODEL_TIMEOUT_MS", "40"); vi.stubEnv("LLM_WIKI_OLLAMA_CHAT_TIMEOUT_MS", "200"); vi.resetModules();
    const runtime = await import("../server/lib/llm.js");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => { const controller = new AbortController(); setTimeout(() => controller.abort(new Error("timed out")), ms); return controller.signal; });
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"message":{"content":"保留的部分回答"},"done":false}\n'));
      init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
    } }), { headers: { "content-type": "application/x-ndjson" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = runtime.chatCompletionWithDiagnostics(nativeSettings, messages);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ content: "保留的部分回答", truncated: true });
    expect((await result).error).toContain("未返回"); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("enforces an overall stream deadline even when the model continuously emits content", async () => {
    vi.useFakeTimers(); vi.stubEnv("LLM_WIKI_MODEL_TIMEOUT_MS", "40"); vi.stubEnv("LLM_WIKI_OLLAMA_CHAT_TIMEOUT_MS", "80"); vi.resetModules();
    const runtime = await import("../server/lib/llm.js"); vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => { const controller = new AbortController(); setTimeout(() => controller.abort(new Error("timed out")), ms); return controller.signal; });
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      const timer = setInterval(() => controller.enqueue(new TextEncoder().encode('{"message":{"content":"继续"},"done":false}\n')), 10);
      init?.signal?.addEventListener("abort", () => { clearInterval(timer); controller.error(init.signal?.reason); }, { once: true });
    } }), { headers: { "content-type": "application/x-ndjson" } })));
    const result = runtime.chatCompletionWithDiagnostics(nativeSettings, messages);
    await vi.advanceTimersByTimeAsync(90);
    expect((await result).content).toContain("继续"); expect((await result).truncated).toBe(true); expect((await result).error).toContain("总时限");
  });

  it("bounds ingestion analysis independently of the full answer timeout and falls back without retries", async () => {
    vi.useFakeTimers(); vi.stubEnv("LLM_WIKI_MODEL_TIMEOUT_MS", "120000"); vi.stubEnv("LLM_WIKI_ANALYSIS_TIMEOUT_MS", "30"); vi.resetModules();
    const runtime = await import("../server/lib/llm.js"); vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => { const controller = new AbortController(); setTimeout(() => controller.abort(new Error("timed out")), ms); return controller.signal; });
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })));
    vi.stubGlobal("fetch", fetchMock);
    let settled = false;
    const result = runtime.analyzeWithModel({ ...DEFAULT_SETTINGS, ...nativeSettings }, "材料", "材料全文").finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(35); expect(settled).toBe(true); expect(await result).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not pass incomplete output to artifact callers without diagnostics", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(compatible("未完成的研究结论", "length"))
      .mockRejectedValueOnce(new Error("connection lost")));
    expect(await chatCompletion(settings, messages)).toBeNull();
  });

  it("preserves the received answer and reports a redacted continuation failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValueOnce(compatible("已完成步骤一，", "length"))
      .mockRejectedValueOnce(new Error("HTTP 401 fixture-secret"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatCompletionWithDiagnostics(settings, messages);

    expect(result.content).toBe("已完成步骤一，");
    expect(result).toMatchObject({ truncated: true });
    expect(result.error).toContain("401");
    expect(result.error).not.toContain("fixture-secret");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("fixture-secret");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("marks the preserved answer incomplete when a continuation has no final text", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(compatible("先检查材料，", "length"))
      .mockResolvedValueOnce(compatible("   ")));

    const result = await chatCompletionWithDiagnostics(settings, messages);

    expect(result).toMatchObject({ content: "先检查材料，", truncated: true });
    expect(result.error).toContain("空回答");
  });

  it("reports remaining truncation after exhausting automatic continuation rounds", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => compatible("下一步仍未结束，", "length"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatCompletionWithDiagnostics(settings, messages);

    expect(result.content).toContain("下一步仍未结束");
    expect(result).toMatchObject({ truncated: true });
    expect(result.error).toContain("输出上限");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    { provider: "ollama" as const, baseUrl: "https://model.example.test", first: { message: { content: "第一步，" }, done_reason: "length" }, last: { message: { content: "最后一步。" }, done_reason: "stop" } },
    { provider: "anthropic" as const, baseUrl: "https://model.example.test/v1", first: { content: [{ type: "text", text: "第一步，" }], stop_reason: "max_tokens" }, last: { content: [{ type: "text", text: "最后一步。" }], stop_reason: "end_turn" } },
    { provider: "gemini" as const, baseUrl: "https://model.example.test/v1beta", first: { candidates: [{ content: { parts: [{ text: "第一步，" }] }, finishReason: "MAX_TOKENS" }] }, last: { candidates: [{ content: { parts: [{ text: "最后一步。" }] }, finishReason: "STOP" }] } }
  ])("completes a truncated $provider answer without an incomplete warning", async ({ provider, baseUrl, first, last }) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(first)).mockResolvedValueOnce(json(last));
    vi.stubGlobal("fetch", fetchMock);

    const result = await chatCompletionWithDiagnostics({ ...settings, provider, baseUrl }, messages);

    expect(result.content).toBe("第一步，\n\n最后一步。");
    expect(result.error).toBeUndefined();
    expect(result.truncated).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns only Gemini final answer parts rather than thought summaries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json({ candidates: [{
      content: { parts: [{ text: "模拟思考摘要", thought: true }, { text: "确认材料完整。" }] }, finishReason: "STOP"
    }] })));
    const gemini = { ...settings, provider: "gemini" as const, baseUrl: "https://model.example.test/v1beta" };

    expect((await chatCompletionWithDiagnostics(gemini, messages)).content).toBe("确认材料完整。");
    expect((await testModelConnection(gemini)).response).toBe("确认材料完整。");
  });

  it("does not pass the Gemini connection test on thought-only output", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => json({ candidates: [{
      content: { parts: [{ text: "模拟思考摘要", thought: true }] }, finishReason: "MAX_TOKENS"
    }] })));
    const gemini = { ...settings, provider: "gemini" as const, baseUrl: "https://model.example.test/v1beta" };

    await expect(testModelConnection(gemini)).rejects.toThrow("只返回了思考内容");
    const result = await chatCompletionWithDiagnostics(gemini, messages);
    expect(result.content).toBeNull();
    expect(result.error).toContain("只返回了思考内容");
    expect(result.error).not.toContain("模拟思考摘要");
  });
});
