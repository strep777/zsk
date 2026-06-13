import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

describe("frontend api client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
        useHistory: false
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
      useHistory: false
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

  it("reports chunk upload progress and passes abort signals", async () => {
    const controller = new AbortController();
    const progress: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toContain("/api/v1/projects/p1/sources/upload-chunk?");
      expect(init?.signal).toBe(controller.signal);
      return new Response(
        JSON.stringify({
          done: false,
          activity: { queue: [], sources: [], queueTotal: 0, sourceTotal: 0 },
          message: "文件已上传，后台正在解包并登记到摄入队列。"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.uploadSources("p1", [new File(["abcdef"], "a.txt", { type: "text/plain" })], {
      chunkBytes: 3,
      signal: controller.signal,
      onProgress: (item) => progress.push(`${item.fileName}:${item.currentChunk}/${item.totalChunks}`)
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(progress).toEqual(["a.txt:1/2", "a.txt:2/2", "a.txt:undefined/undefined"]);
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
});
