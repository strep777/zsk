import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/api";

describe("frontend api client", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends chat history and attachment options to the backend", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe("/api/v1/projects/p1/chat");
      expect(JSON.parse(String(init?.body))).toEqual({
        query: "问题",
        chatId: "c1",
        save: false,
        attachments: [
          {
            id: "a",
            name: "note.txt",
            mimeType: "text/plain",
            size: 4,
            kind: "text",
            text: "内容"
          }
        ],
        useHistory: false,
        webSearch: true
      });
      return new Response(JSON.stringify({ answer: "ok", hits: [], chat: { id: "c1", title: "问题", createdAt: "", updatedAt: "", messages: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await api.chat("p1", {
      query: "问题",
      chatId: "c1",
      save: false,
      attachments: [
        {
          id: "a",
          name: "note.txt",
          mimeType: "text/plain",
          size: 4,
          kind: "text",
          text: "内容"
        }
      ],
      useHistory: false,
      webSearch: true
    });
    expect(response.answer).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces backend errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "失败原因" }), { status: 400 }))
    );
    await expect(api.projects()).rejects.toThrow("失败原因");
  });

  it("creates projects through the projects endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe("/api/v1/projects");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "合同知识库",
        description: "合同审查资料"
      });
      return new Response(
        JSON.stringify({
          project: {
            id: "contract",
            name: "合同知识库",
            description: "合同审查资料",
            createdAt: "",
            updatedAt: "",
            root: ""
          }
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = await api.createProject({ name: "合同知识库", description: "合同审查资料" });
    expect(payload.project.id).toBe("contract");
  });

  it("requests paged raw source lists with search parameters", async () => {
    const fetchMock = vi.fn(async (_url: string) => {
      const url = new URL(_url, "http://localhost");
      expect(url.pathname).toBe("/api/v1/projects/p1/files");
      expect(url.searchParams.get("scope")).toBe("raw");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.get("offset")).toBe("200");
      expect(url.searchParams.get("query")).toBe("合同");
      expect(url.searchParams.get("compact")).toBe("1");
      return new Response(JSON.stringify({ files: [], total: 0, offset: 200, limit: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.rawFiles("p1", { limit: 100, offset: 200, query: "合同", compact: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("encodes non-ascii project ids in request paths", async () => {
    const fetchMock = vi.fn(async (_url: string) => {
      expect(_url).toContain("/api/v1/projects/%E6%88%91%E7%9A%84%20LLM%20Wiki/files/content");
      return new Response(JSON.stringify({ path: "wiki/index.md", content: "# ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.fileContent("我的 LLM Wiki", "wiki/index.md");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("attaches http status to backend errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "不存在" }), { status: 404 }))
    );
    await expect(api.fileContent("p1", "wiki/missing.md")).rejects.toMatchObject({ status: 404 });
  });

  it("reports chunk upload progress and passes abort signals", async () => {
    const controller = new AbortController();
    const progress: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toContain("/api/v1/projects/p1/sources/upload-chunk?");
      expect(init?.signal).toBe(controller.signal);
      const finalChunk = fetchMock.mock.calls.length === 2;
      return new Response(
        JSON.stringify({
          done: finalChunk,
          sources: finalChunk ? [{ id: "s1", status: "queued" }] : [],
          total: finalChunk ? 1 : 0,
          queued: finalChunk ? 1 : 0,
          skipped: 0,
          activity: {
            queue: finalChunk ? [{ id: "q1", sourceId: "s1", status: "queued" }] : [],
            sources: finalChunk ? [{ id: "s1", status: "queued" }] : [],
            queueTotal: finalChunk ? 1 : 0,
            sourceTotal: finalChunk ? 1 : 0
          },
          message: "文件已上传，已自动加入摄入队列。"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.uploadSources("p1", [new File(["abcdef"], "a.txt", { type: "text/plain" })], {
      chunkBytes: 3,
      signal: controller.signal,
      onProgress: (item) => progress.push(`${item.fileName}:${item.currentChunk}/${item.totalChunks}:${item.queued}`)
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.queued).toBe(1);
    expect(progress).toEqual(["a.txt:1/2:0", "a.txt:2/2:0", "a.txt:2/2:1"]);
  });

  it("can explicitly resume ingestion after uploads", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe("/api/v1/projects/%E4%B8%AD%E6%96%87/queue/resume");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.resumeQueue("中文")).resolves.toEqual({ ok: true });
  });

  it("creates and reads research tasks", async () => {
    const task = {
      id: "research-1",
      topic: "公司章程",
      queries: ["公司章程 核心概念"],
      status: "queued",
      progress: 0,
      steps: [],
      createdAt: "",
      updatedAt: ""
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        expect(_url).toBe("/api/v1/projects/p1/research");
        expect(JSON.parse(String(init.body))).toEqual({ topic: "公司章程" });
        return new Response(JSON.stringify({ task }), {
          status: 202,
          headers: { "content-type": "application/json" }
        });
      }
      expect(_url).toBe("/api/v1/projects/p1/research/research-1");
      return new Response(JSON.stringify({ task: { ...task, status: "done", progress: 100 } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.research("p1", { topic: "公司章程" })).resolves.toEqual({ task });
    await expect(api.researchTask("p1", "research-1")).resolves.toMatchObject({
      task: { id: "research-1", status: "done" }
    });
  });

  it("deletes chat sessions through the chat endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe("/api/v1/projects/p1/chats/c1");
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ deleted: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.deleteChat("p1", "c1")).resolves.toEqual({ deleted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to a safe upload chunk size when callers pass an invalid value", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          done: true,
          activity: { queue: [], sources: [], queueTotal: 0, sourceTotal: 0 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.uploadSources("p1", [new File(["abc"], "a.txt", { type: "text/plain" })], { chunkBytes: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses a safe chunk size for fractional values smaller than one byte", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ done: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.uploadSources("p1", [new File(["abc"], "a.txt")], { chunkBytes: 0.5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("Infinity");
  });

  it("cleans incomplete upload sessions on server errors", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "DELETE"
      ? new Response(JSON.stringify({ ok: true }))
      : new Response(JSON.stringify({ error: "磁盘空间不足" }), { status: 507 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.uploadSources("p1", [new File(["abc"], "a.txt")])).rejects.toThrow("磁盘空间不足");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/sources/upload-session?");
  });

  it("stops upload before sending a request when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.uploadSources("p1", [new File(["abc"], "a.txt", { type: "text/plain" })], {
        signal: controller.signal
      })
    ).rejects.toThrow("上传已取消");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { body: "null", message: "HTTP 503" },
    { body: JSON.stringify("服务维护中"), message: "服务维护中" },
    { body: JSON.stringify({ error: { unexpected: true } }), message: "HTTP 503" },
    { body: "<html>proxy unavailable</html>", message: "HTTP 503" },
    { body: "", message: "HTTP 503" }
  ])("reports readable HTTP failures for response $body", async ({ body, message }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 503 })));
    const error = await api.projects().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 503 });
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).not.toContain("[object Object]");
  });

  it("keeps the upload HTTP status and cleans up on a null error response", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "DELETE"
      ? new Response(JSON.stringify({ ok: true })) : new Response("null", { status: 507 }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await api.uploadSources("p1", [new File(["abc"], "a.txt")]).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError); expect(error).toMatchObject({ status: 507 });
    expect((error as Error).message).toContain("HTTP 507");
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["PUT", "DELETE"]);
  });

  it.each(["null", '"accepted"', "{}", '{"done":false}', '<html>proxy page</html>'])("rejects an unconfirmed final upload response %s without reporting completion", async (body) => {
    const progress = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "DELETE"
      ? new Response(JSON.stringify({ ok: true })) : new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.uploadSources("p1", [new File(["abc"], "a.txt")], { onProgress: progress })).rejects.toThrow(/上传|分片|JSON/);
    expect(progress).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["PUT", "DELETE"]);
  });

  it("does not send later files or mark the batch complete when the final chunk fails", async () => {
    const progress = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(JSON.stringify({ ok: true }));
      return fetchMock.mock.calls.length === 1 ? new Response(JSON.stringify({ done: false }))
        : new Response(JSON.stringify({ error: "最终分片失败" }), { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.uploadSources("p1", [new File(["abcdef"], "a.txt"), new File(["xyz"], "b.txt")], { chunkBytes: 3, onProgress: progress })).rejects.toThrow("最终分片失败");
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["PUT", "PUT", "DELETE"]);
    expect(progress.mock.calls.map((call) => call[0].uploadedFiles)).toEqual([0]);
  });

  it("cancels a paused upload on abort even if the pause callback has not resumed", async () => {
    const controller = new AbortController(), fetchMock = vi.fn();
    let release!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", fetchMock);
    const upload = api.uploadSources("p1", [new File(["abc"], "a.txt")], { signal: controller.signal, waitWhilePaused: () => pause });
    const result = upload.catch((error: Error) => error);
    controller.abort();
    const settled = await Promise.race([result, new Promise<null>((resolve) => setTimeout(() => resolve(null), 30))]);
    release(); await result;
    expect(settled).toMatchObject({ name: "AbortError", message: "上传已取消" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a successful last-chunk response received after cancellation", async () => {
    const controller = new AbortController(), progress = vi.fn();
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => init?.method === "DELETE"
      ? Promise.resolve(new Response(JSON.stringify({ ok: true }))) : new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const upload = api.uploadSources("p1", [new File(["abc"], "a.txt")], { signal: controller.signal, onProgress: progress });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    controller.abort(); finish(new Response(JSON.stringify({ done: true, queued: 1 })));
    await expect(upload).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["PUT", "DELETE"]);
  });

  it("preserves the upload failure and releases the caller when session cleanup stalls", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => init?.method === "DELETE"
      ? new Promise<Response>((_resolve, reject) => { init.signal?.addEventListener("abort", () => reject(new Error("清理中断")), { once: true }); })
      : Promise.resolve(new Response(JSON.stringify({ error: "原始上传失败" }), { status: 507 })));
    vi.stubGlobal("fetch", fetchMock);
    let settled = false;
    const result = api.uploadSources("p1", [new File(["abc"], "a.txt")]).catch((error: Error) => error)
      .finally(() => { settled = true; });
    await vi.waitFor(() => expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["PUT", "DELETE"]));
    await vi.advanceTimersByTimeAsync(15000);
    expect(settled).toBe(true);
    expect(await result).toMatchObject({ message: "原始上传失败", status: 507 });
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });
});
