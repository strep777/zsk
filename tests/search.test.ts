import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { answerQuestion, deleteChat, listChats, saveLatestChatAnswer, searchProject } from "../server/lib/search.js";
import { safeJoin, writeSettings, writeSources } from "../server/lib/storage.js";
import { writeWikiFile } from "../server/lib/wiki.js";
import { makeProject } from "./helpers.js";

const unreadableQuestion = "?".repeat(6);

afterEach(() => {
  vi.restoreAllMocks();
});

function mockNetworkUnavailable(): void {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network unavailable"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
}

describe("search and chat", () => {
  it("preserves all turns when answers append to the same chat concurrently", async () => {
    mockNetworkUnavailable();
    const project = await makeProject();
    const first = await answerQuestion(project, { query: "开场", modelId: "summary", useHistory: false });
    await Promise.all(Array.from({ length: 8 }, (_, index) => answerQuestion(project, { query: `同时提问 ${index}`, chatId: first.chat.id, modelId: "summary", useHistory: false })));
    const chats = await listChats(project);
    expect(chats[0].messages).toHaveLength(18);
    expect(chats[0].messages.filter((item) => item.role === "user").map((item) => item.content)).toEqual(expect.arrayContaining(Array.from({ length: 8 }, (_, index) => `同时提问 ${index}`)));
  });
  it("rejects questions to removed chats instead of recreating them", async () => {
    mockNetworkUnavailable();
    const project = await makeProject();
    const first = await answerQuestion(project, { query: "开场", modelId: "summary" });
    await deleteChat(project, first.chat.id);
    await expect(answerQuestion(project, { query: "已删除的追问", chatId: first.chat.id, modelId: "summary" })).rejects.toMatchObject({ status: 404 });
    expect(await listChats(project)).toHaveLength(0);
  });
  it("searches wiki pages and source registry summaries", async () => {
    const project = await makeProject();
    await writeWikiFile(
      project,
      "wiki/concepts/company-charter.md",
      "---\ntitle: 公司章程\ntype: concept\ntags: [concept]\nsources: []\n---\n# 公司章程\n\n公司章程是公司治理的基础文件。"
    );
    await writeSources(project, [
      {
        id: "source-1",
        fileName: "公司法.txt",
        relativePath: "raw/sources/company-law.txt",
        kind: "text",
        size: 10,
        sha256: "sha",
        title: "公司法",
        summary: "公司法规定公司章程必须载明的事项。",
        importedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "ready",
        wikiPath: "wiki/sources/company-law.md"
      }
    ]);

    const hits = await searchProject(project, "公司章程", { includeRaw: true });
    expect(hits.map((hit) => hit.title)).toContain("公司章程");
    expect(hits.map((hit) => hit.title)).toContain("公司法");
    const registryHit = hits.find((hit) => hit.title === "公司法");
    expect(registryHit?.path).toBe("wiki/sources/company-law.md");
    expect(registryHit?.citations).toEqual(["wiki/sources/company-law.md"]);
  });

  it("excludes unreadable materials and saved query pages from evidence", async () => {
    const project = await makeProject();
    const timestamp = new Date().toISOString();
    await writeWikiFile(
      project,
      "wiki/queries/bad-answer.md",
      "---\ntitle: 无法识别的问题\ntype: query\ntags: [query]\nsources: []\n---\n# 无法识别的问题\n\n中国 组建党派 原文包含无法识别字符。"
    );
    await writeWikiFile(
      project,
      "wiki/sources/bad-source.md",
      "---\ntitle: 无法识别的问题\ntype: source\ntags: [source]\nsources: [raw/sources/bad.txt]\n---\n# 无法识别的问题\n\n原文包含无法识别字符，请重新上传原始文件或检查编码。中国 组建党派"
    );
    await writeSources(project, [
      {
        id: "bad-source",
        fileName: "bad.txt",
        relativePath: "raw/sources/bad.txt",
        kind: "text",
        size: 10,
        sha256: "bad",
        title: "无法识别的问题",
        summary: "原文包含无法识别字符，请重新上传原始文件或检查编码。中国 组建党派",
        importedAt: timestamp,
        updatedAt: timestamp,
        status: "ready",
        wikiPath: "wiki/sources/bad-source.md"
      }
    ]);

    const hits = await searchProject(project, "在中国怎么组建党派", { includeRaw: true });
    expect(hits).toEqual([]);

    mockNetworkUnavailable();
    const result = await answerQuestion(project, { query: "在中国怎么组建党派" });
    expect(result.hits).toEqual([]);
    expect(result.answer).toContain("知识库没有相关内容");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uses the configured web search when the knowledge base has no evidence", async () => {
    const project = await makeProject();
    await writeSettings(project, { webSearchProvider: "searxng", webSearchUrl: "https://search.example" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ title: "外部法规资料", url: "https://example.com/law", content: "这是来自联网搜索的法规摘要。" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await answerQuestion(project, { query: "zzzz-web-only-needle" });

    const webHit = result.hits.find((hit) => hit.path === "https://example.com/law");
    expect(webHit?.type).toBe("web");
    expect(result.answer).toContain("联网搜索");
    expect(result.chat.messages[1].citations).toContain("https://example.com/law");
  });

  it("combines knowledge base evidence with configured web search results", async () => {
    const project = await makeProject();
    await writeWikiFile(
      project,
      "wiki/sources/company-law.md",
      "---\ntitle: 中华人民共和国公司法\ntype: source\ntags: [source]\nsources: [raw/sources/company-law.txt]\n---\n# 中华人民共和国公司法\n\n公司章程应当载明公司名称、住所、经营范围等事项。"
    );
    await writeSettings(project, {
      webSearchProvider: "searxng",
      webSearchUrl: "https://search.example"
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: "最新公司登记规定",
              url: "https://example.com/company-registration",
              content: "联网搜索补充：公司登记材料需要符合最新登记机关要求。"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await answerQuestion(project, { query: "公司章程最新登记要求" });

    expect(result.hits.map((hit) => hit.path)).toContain("wiki/sources/company-law.md");
    expect(result.hits.map((hit) => hit.path)).toContain("https://example.com/company-registration");
    expect(result.answer).toContain("当前知识库");
    expect(result.answer).toContain("联网搜索");
    expect(result.chat.messages[1].citations).toContain("wiki/sources/company-law.md");
    expect(result.chat.messages[1].citations).toContain("https://example.com/company-registration");
  });

  it("forces web search from the chat option even when local evidence is strong", async () => {
    const project = await makeProject();
    await writeSettings(project, { webSearchProvider: "searxng", webSearchUrl: "https://search.example" });
    await writeWikiFile(
      project,
      "wiki/sources/company-law.md",
      "---\ntitle: 中华人民共和国公司法\ntype: source\ntags: [source]\nsources: [raw/sources/company-law.txt]\n---\n# 中华人民共和国公司法\n\n公司章程 公司章程 公司章程 应当载明公司名称、住所、经营范围等事项。"
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ title: "联网补充资料", url: "https://example.com/live", content: "这是用户手动开启联网后得到的补充材料。" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await answerQuestion(project, { query: "公司章程", webSearch: true });

    expect(result.hits.map((hit) => hit.path)).toContain("wiki/sources/company-law.md");
    expect(result.hits.map((hit) => hit.path)).toContain("https://example.com/live");
    expect(result.answer).toContain("联网搜索");
  });

  it("uses the live model for a normal answer when knowledge base and web search have no evidence", async () => {
    const project = await makeProject();
    await writeSettings(project, {
      provider: "custom",
      apiKey: "test-key",
      baseUrl: "https://llm.example/v1",
      model: "chat-model"
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "知识库没有相关内容。\n\n普通回答：可以根据通用知识解释这个问题。"
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error("network unavailable");
    });

    const result = await answerQuestion(project, { query: "普通常识问题" });

    expect(result.hits).toEqual([]);
    expect(result.answer).toContain("知识库没有相关内容");
    expect(result.answer).toContain("普通回答");
  });

  it("uses the selected model profile for chat answers", async () => {
    const project = await makeProject();
    await writeSettings(project, {
      modelProfiles: [
        {
          id: "fast",
          name: "Fast model",
          provider: "custom",
          model: "fast-model",
          baseUrl: "https://fast.example/v1",
          apiKey: "fast-key",
          enabled: true
        },
        {
          id: "deep",
          name: "Deep model",
          provider: "custom",
          model: "deep-model",
          baseUrl: "https://deep.example/v1",
          apiKey: "deep-key",
          enabled: true
        }
      ],
      activeModelId: "fast"
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const chatBodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/chat/completions")) {
        chatBodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "selected model answer" } }]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error("network unavailable");
    });

    const result = await answerQuestion(project, {
      query: "unmatched external question",
      modelId: "deep"
    });

    expect(result.answer).toBe("selected model answer");
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({ model: "deep-model" });
  });

  it("does not reuse unrelated history evidence for a new question", async () => {
    const project = await makeProject();
    await writeWikiFile(
      project,
      "wiki/sources/alpha.md",
      "---\ntitle: Alpha lease evidence\ntype: source\ntags: [source]\nsources: [raw/sources/alpha.txt]\n---\n# Alpha lease evidence\n\nalpha lease renewal notice and rent terms."
    );
    mockNetworkUnavailable();

    const first = await answerQuestion(project, { query: "alpha lease" });
    const second = await answerQuestion(project, {
      query: "newtopic",
      chatId: first.chat.id,
      useHistory: true
    });

    expect(first.hits.map((hit) => hit.title)).toContain("Alpha lease evidence");
    expect(second.hits).toEqual([]);
    expect(second.answer).not.toContain("Alpha lease evidence");
  });

  it("does not treat the default index page as query evidence", async () => {
    const project = await makeProject();
    await writeSettings(project, { webSearchProvider: "searxng", webSearchUrl: "https://search.example" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ title: "外部结果", url: "https://example.com/outside", content: "这是外部搜索结果。" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await answerQuestion(project, { query: "查一个知识库里没有的问题" });

    expect(result.hits.map((hit) => hit.path)).not.toContain("wiki/index.md");
    expect(result.hits[0]?.path).toBe("https://example.com/outside");
    expect(result.answer).toContain("联网搜索");
  });

  it("does not use unrelated source registry records as evidence", async () => {
    const project = await makeProject();
    await writeSettings(project, { webSearchProvider: "searxng", webSearchUrl: "https://search.example" });
    const timestamp = new Date().toISOString();
    await writeSources(project, [
      {
        id: "source-unrelated",
        fileName: "公司法.txt",
        relativePath: "raw/sources/company-law.txt",
        kind: "text",
        size: 10,
        sha256: "sha",
        title: "中华人民共和国公司法",
        summary: "公司章程应当载明公司名称、住所、经营范围等事项。",
        importedAt: timestamp,
        updatedAt: timestamp,
        status: "ready",
        wikiPath: "wiki/sources/company-law.md",
        convertedPath: "wiki/sources/converted/company-law.md"
      }
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ title: "火星地貌资料", url: "https://example.com/mars", content: "这是外部搜索的火星地貌摘要。" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await answerQuestion(project, { query: "火星奥林帕斯山高度" });

    expect(result.hits.map((hit) => hit.path)).not.toContain("wiki/sources/company-law.md");
    expect(result.hits[0]?.path).toBe("https://example.com/mars");
    expect(result.answer).toContain("联网搜索");
  });

  it("creates multi-turn chats and can save the latest answer", async () => {
    mockNetworkUnavailable();
    const project = await makeProject();
    await writeWikiFile(
      project,
      "wiki/sources/company-law.md",
      "---\ntitle: 中华人民共和国公司法\ntype: source\ntags: [source]\nsources: [raw/sources/company-law.txt]\n---\n# 中华人民共和国公司法\n\n公司章程不得只写一句话，应载明法律要求的必要事项。"
    );

    const first = await answerQuestion(project, { query: "公司章程可以不写吗" });
    expect(first.chat.messages).toHaveLength(2);
    expect(first.answer).toContain("公司章程");
    expect(first.chat.messages[1].citations).toEqual(["wiki/sources/company-law.md"]);

    const second = await answerQuestion(project, {
      query: "那最简单的模板呢",
      chatId: first.chat.id,
      useHistory: true
    });
    expect(second.chat.messages).toHaveLength(4);
    expect(second.hits.map((hit) => hit.path)).toContain("wiki/sources/company-law.md");
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const savedPath = await saveLatestChatAnswer(project, second.chat.id);
    expect(savedPath).toMatch(/^wiki\/queries\/.+\.md$/);
    const saved = await fs.readFile(safeJoin(project.root, savedPath), "utf8");
    expect(saved).toContain("那最简单的模板呢");

    const chats = await listChats(project);
    expect(chats[0].messages).toHaveLength(4);
  });

  it("keeps long repeated questions in separate persisted sessions", async () => {
    mockNetworkUnavailable();
    const project = await makeProject();
    const query = "请解释知识库中这个主题的背景和具体内容".repeat(8);
    const first = await answerQuestion(project, { query });
    const second = await answerQuestion(project, { query });
    expect(first.chat.id).not.toBe(second.chat.id);
    const chats = await listChats(project);
    expect(chats).toHaveLength(2);
    expect(chats.every((chat) => chat.messages.length === 2)).toBe(true);
    await saveLatestChatAnswer(project, second.chat.id);
    await deleteChat(project, second.chat.id);
    expect((await listChats(project)).map((chat) => chat.id)).toEqual([first.chat.id]);
  });

  it("preserves the complete image data URL in persisted history", async () => {
    mockNetworkUnavailable();
    const project = await makeProject();
    const dataUrl = `data:image/png;base64,${"YWJj".repeat(60000)}`;
    const result = await answerQuestion(project, {
      query: "说明附件", attachments: [{ name: "large.png", mimeType: "image/png", size: 180000, kind: "image", dataUrl }]
    });
    expect(result.chat.messages[0].attachments?.[0].dataUrl).toBe(dataUrl);
    expect((await listChats(project))[0].messages[0].attachments?.[0].dataUrl).toBe(dataUrl);
  });

  it("handles unreadable question text without polluting chat titles", async () => {
    const project = await makeProject();
    const result = await answerQuestion(project, { query: unreadableQuestion });
    expect(result.hits).toEqual([]);
    expect(result.answer).toContain("无法识别");
    expect(result.chat.title).toBe("无法识别的问题");
    expect(await fs.readdir(path.join(project.root, "chats"))).toHaveLength(1);
  });

  it("stores text and image chat attachments safely", async () => {
    const project = await makeProject();
    mockNetworkUnavailable();
    const result = await answerQuestion(project, {
      query: "根据附件总结",
      attachments: [
        {
          id: "a",
          name: "note.txt",
          mimeType: "text/plain",
          size: 12,
          kind: "text",
          text: "公司章程附件内容"
        },
        {
          id: "b",
          name: "tiny.png",
          mimeType: "image/png",
          size: 4,
          kind: "image",
          dataUrl: "data:image/png;base64,iVBORw0KGgo="
        }
      ]
    });
    expect(result.chat.messages[0].attachments?.map((item) => item.name)).toEqual(["note.txt", "tiny.png"]);
  });

  it("starts a separate chat even when the first question is repeated", async () => {
    const project = await makeProject();
    mockNetworkUnavailable();

    const first = await answerQuestion(project, { query: "公司章程可以不写吗" });
    const second = await answerQuestion(project, { query: "公司章程可以不写吗" });

    expect(first.chat.id).not.toBe(second.chat.id);
    expect(first.chat.messages).toHaveLength(2);
    expect(second.chat.messages).toHaveLength(2);
    expect(await listChats(project)).toHaveLength(2);
  });

  it("deletes persisted chat sessions", async () => {
    const project = await makeProject();
    mockNetworkUnavailable();

    const result = await answerQuestion(project, { query: "公司章程可以不写吗" });

    expect(await listChats(project)).toHaveLength(1);
    await expect(deleteChat(project, result.chat.id)).resolves.toBe(true);
    expect(await listChats(project)).toHaveLength(0);
    await expect(deleteChat(project, result.chat.id)).resolves.toBe(false);
  });

  it("loads enabled skills and mcp servers into chat context", async () => {
    const project = await makeProject();
    mockNetworkUnavailable();
    await writeSettings(project, {
      skills: [
        {
          id: "law-review",
          name: "法规审查",
          prompt: "回答时必须区分事实、依据和风险。",
          enabled: true
        }
      ],
      mcpServers: [
        {
          id: "law-tools",
          name: "法规工具",
          transport: "http",
          url: "http://localhost:8765/mcp",
          tools: ["search_law"],
          resources: ["docs://law"],
          enabled: true
        }
      ]
    });

    const result = await answerQuestion(project, { query: "公司章程可以不写吗" });

    expect(result.answer).toContain("已启用扩展能力");
    expect(result.answer).toContain("Skill：法规审查");
    expect(result.answer).toContain("MCP：法规工具");
  });

  it("calls configured HTTP MCP tools and includes their results", async () => {
    const project = await makeProject();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeSettings(project, {
      mcpServers: [
        {
          id: "law-tools",
          name: "法规工具",
          transport: "http",
          url: "http://localhost:8765/mcp",
          tools: ["search_law"],
          enabled: true
        }
      ]
    });
    let initialized = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) === "http://localhost:8765/mcp") {
        if (init?.method === "GET" || init?.method === "DELETE") return new Response(null, { status: 405 });
        const body = JSON.parse(String(init?.body));
        if (body.method === "initialize") { initialized = true; return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "法规服务", version: "1.0" } } }), { headers: { "content-type": "application/json" } }); }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (body.method === "tools/list") return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "search_law", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } }] } }), { headers: { "content-type": "application/json" } });
        expect(initialized).toBe(true);
        expect(body.method).toBe("tools/call");
        expect(body.params).toEqual({
          name: "search_law",
          arguments: { query: "公司章程是否必须记载注册资本" }
        });
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              content: [{ type: "text", text: "MCP 返回：公司章程应记载注册资本。" }]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("<html><body></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    });

    const result = await answerQuestion(project, { query: "公司章程是否必须记载注册资本" });

    expect(fetchMock.mock.calls.some(([url, options]) => String(url) === "http://localhost:8765/mcp" && options?.method === "POST")).toBe(true);
    expect(result.answer).toContain("MCP 工具调用结果");
    expect(result.answer).toContain("MCP 返回：公司章程应记载注册资本");
  });
});
