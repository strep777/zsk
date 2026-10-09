import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverModels } from "../server/lib/modelDiscovery.js";
import { testModelConnection } from "../server/lib/llm.js";
import { testExternalSearch } from "../server/lib/webSearch.js";
import { diagnosticError } from "../server/lib/serviceHttp.js";
import { DEFAULT_SETTINGS } from "../server/lib/storage.js";
import { discoverMcp } from "../server/lib/mcpClient.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { once } from "node:events";
import path from "node:path";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const profile = { id: "local", name: "", provider: "ollama" as const, baseUrl: "http://localhost:11434", model: "qwen", enabled: true };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("settings diagnostics", () => {
  it("discovers native Ollama models and compatible models using the user's proxy key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ models: [{ name: "中文-qwen" }, { name: "中文-qwen" }, { model: "llama" }] })).mockResolvedValueOnce(json({ data: [{ id: "qwen" }] }));
    expect((await discoverModels(profile)).models).toEqual(["llama", "中文-qwen"]);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:11434/api/tags");
    await discoverModels({ ...profile, baseUrl: "http://localhost:11434/v1/", apiKey: "proxy-key" });
    expect(fetchMock.mock.calls[1][0]).toBe("http://localhost:11434/v1/models");
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ authorization: "Bearer proxy-key" });
  });
  it("paginates Anthropic models and filters Gemini to chat models", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ data: [{ id: "claude-a" }], has_more: true, last_id: "claude-a" })).mockResolvedValueOnce(json({ data: [{ id: "claude-b" }], has_more: false })).mockResolvedValueOnce(json({ models: [{ name: "models/gemini-test", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }] }));
    expect((await discoverModels({ ...profile, provider: "anthropic", baseUrl: "https://example.test/v1", apiKey: "key" })).models).toEqual(["claude-a", "claude-b"]);
    expect(String(mock.mock.calls[1][0])).toContain("after_id=claude-a");
    expect((await discoverModels({ ...profile, provider: "gemini", baseUrl: "https://example.test/v1beta", apiKey: "key" })).models).toEqual(["gemini-test"]);
    expect(mock.mock.calls[2][1]?.headers).toMatchObject({ "x-goog-api-key": "key" });
  });
  it("does not treat HTTP errors, HTML or empty completions as success", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ error: "forbidden" }, 401)).mockResolvedValueOnce(json({ choices: [] })).mockResolvedValueOnce(json({ choices: [{ message: { content: "OK" } }] }));
    await expect(discoverModels(profile)).rejects.toThrow("401");
    await expect(testModelConnection({ ...profile, baseUrl: profile.baseUrl + "/v1", systemPrompt: "" })).rejects.toThrow("空回答");
    const result = await testModelConnection({ ...profile, provider: "custom", baseUrl: "http://localhost:8000/v1", systemPrompt: "" });
    expect(result.response).toBe("OK");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(String(mock.mock.calls[2][1]?.body)).max_tokens).toBe(256);
  });
  it("reports configured web search failure without using a fallback", async () => {
    const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "forbidden" }, 403));
    await expect(testExternalSearch({ ...DEFAULT_SETTINGS, webSearchProvider: "searxng", webSearchUrl: "http://localhost:8080" })).rejects.toThrow("403");
    expect(mock).toHaveBeenCalledTimes(1);
    await expect(testExternalSearch({ ...DEFAULT_SETTINGS, webSearchProvider: "none" })).rejects.toMatchObject({ status: 400 });
  });
  it("redacts credentials in failures and rejects unsupported URL schemes", async () => {
    expect(diagnosticError(new Error("key-secret Bearer key-secret"), ["key-secret"]).message).not.toContain("key-secret");
    await expect(discoverModels({ ...profile, baseUrl: "file:///etc/passwd" })).rejects.toMatchObject({ status: 400 });
    await expect(discoverModels({ ...profile, baseUrl: "http://user:secret@localhost/" })).rejects.toMatchObject({ status: 400 });
  });
  it("initializes a real HTTP MCP session and obtains actual tools and resources", async () => {
    const app = express(); app.use(express.json());
    const transports: StreamableHTTPServerTransport[] = [];
    const servers: McpServer[] = [];
    app.post("/mcp", async (req, res) => {
      const server = new McpServer({ name: "测试能力服务", version: "1.0" });
      server.registerTool("search_law", { description: "检索法律" }, async () => ({ content: [{ type: "text", text: "结果" }] }));
      server.registerResource("法规", "docs://law", {}, async () => ({ contents: [{ uri: "docs://law", text: "法规" }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      transports.push(transport); servers.push(server);
      await server.connect(transport); await transport.handleRequest(req, res, req.body);
    });
    const listener = app.listen(0, "127.0.0.1"); await once(listener, "listening");
    try {
      const port = (listener.address() as { port: number }).port;
      const response = await discoverMcp({ id: "mcp", name: "", enabled: true, transport: "http", url: `http://127.0.0.1:${port}/mcp` });
      expect(response.tools).toEqual(["search_law"]); expect(response.resources).toEqual(["docs://law"]);
      expect(response.message).toContain("测试能力服务");
    } finally { await Promise.all(servers.map((server) => server.close())); listener.closeAllConnections(); await new Promise<void>((resolve) => listener.close(() => resolve())); }
  });
  it("discovers a local stdio MCP server and closes its child process", async () => {
    const response = await discoverMcp({ id: "stdio", name: "", enabled: true, transport: "stdio", command: process.execPath, args: [path.resolve("tests/fixtures/mcp-stdio.mjs")] });
    expect(response.tools).toEqual(["search_fixture"]);
    expect(response.resources).toEqual(["test://resource"]);
  });
});
