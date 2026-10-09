import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerConfig } from "../types.js";
import { serviceUrl } from "./serviceHttp.js";
import { validateSettingsInput } from "./validation.js";

export async function withMcpClient<T>(server: McpServerConfig, work: (client: Client, signal: AbortSignal) => Promise<T>, timeoutMs = 20000): Promise<T> {
  if (!server || !["http", "sse", "stdio"].includes(server.transport)) throw Object.assign(new Error("请选择有效的 MCP 传输方式。"), { status: 400 });
  validateSettingsInput({ mcpServers: [server] });
  const client = new Client({ name: "llm-wiki-web", version: "0.1.0" });
  const controller = new AbortController();
  const headers: Record<string, string> = server.apiKey ? { authorization: `Bearer ${server.apiKey}` } : {};
  const transport = server.transport === "stdio"
    ? new StdioClientTransport({ command: requiredCommand(server.command), args: server.args || [], stderr: "pipe" })
    : server.transport === "sse"
      ? new SSEClientTransport(new URL(serviceUrl(server.url)), { requestInit: { headers }, fetch: (url, init) => fetch(url, { ...init, headers: { ...headers, ...Object.fromEntries(new Headers(init?.headers)) }, signal: controller.signal }) })
      : new StreamableHTTPClientTransport(new URL(serviceUrl(server.url)), { requestInit: { headers }, fetch: (url, init) => fetch(url, { ...init, signal: controller.signal }) });
  if (transport instanceof StdioClientTransport) transport.stderr?.on("data", () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => { await client.connect(transport, { signal: controller.signal, timeout: timeoutMs }); return await work(client, controller.signal); })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("MCP 连接或能力获取超时。")); }, timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (transport instanceof StreamableHTTPClientTransport && !controller.signal.aborted) {
      const closeTimer = setTimeout(() => controller.abort(), 1000);
      try { await transport.terminateSession(); } catch { /* Servers without sessions can reject DELETE. */ }
      finally { clearTimeout(closeTimer); }
    }
    controller.abort();
    // close() also terminates stdio children and closes SSE streams.
    await client.close().catch(() => undefined);
  }
}

export async function invokeMcpQueryTool(server: McpServerConfig, name: string, query: string, timeoutMs: number): Promise<unknown | null> {
  return withMcpClient(server, async (client, signal) => {
    const tools = await listAllTools(client, signal, timeoutMs);
    const tool = tools.find((item) => item.name === name);
    if (!tool) throw new Error("工具不在服务返回的目录中，请重新获取工具列表。");
    const required = tool.inputSchema.required || [];
    const querySchema = tool.inputSchema.properties?.query as { type?: string | string[] } | undefined;
    // Query-time retrieval only invokes tools that accept a query and are read-only.
    // Other tools remain in the capability catalog instead of receiving invented arguments.
    if (!querySchema || (querySchema.type && querySchema.type !== "string" && (!Array.isArray(querySchema.type) || !querySchema.type.includes("string"))) || required.some((key) => key !== "query") ||
      tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true ||
      (tool.annotations?.readOnlyHint !== true && !/search|query|lookup|retrieve/i.test(name))) return null;
    const result = await client.callTool({ name, arguments: { query } }, undefined, { signal, timeout: timeoutMs });
    if (result.isError) throw new Error("MCP 工具报告执行失败。");
    return result;
  }, timeoutMs);
}

function requiredCommand(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error("请填写 MCP 启动命令。"), { status: 400 });
  return value.trim();
}

export async function discoverMcp(server: McpServerConfig): Promise<{ message: string; name: string; tools: string[]; resources: string[]; latencyMs: number }> {
  const start = Date.now();
  return withMcpClient(server, async (client, signal) => {
    const capabilities = client.getServerCapabilities();
    const tools: string[] = [], resources: string[] = [];
    if (capabilities?.tools) {
      tools.push(...(await listAllTools(client, signal, 15000)).map((tool) => tool.name));
    }
    if (capabilities?.resources) {
      let cursor: string | undefined;
      let pages = 0;
      const seen = new Set<string>();
      do {
        if (++pages > 100) throw new Error("MCP 资源列表超过分页上限。");
        const page = await client.listResources(cursor ? { cursor } : {}, { signal, timeout: 15000 });
        resources.push(...page.resources.map((resource) => resource.uri));
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("MCP 资源列表分页重复。");
        if (cursor) seen.add(cursor);
        if (resources.length > 2000) throw new Error("MCP 资源数量超过上限。");
      } while (cursor);
    }
    return { message: `已连接 ${client.getServerVersion()?.name || "MCP 服务"}，发现 ${tools.length} 个工具、${resources.length} 个资源。`, name: client.getServerVersion()?.name || "", tools: [...new Set(tools)], resources: [...new Set(resources)], latencyMs: Date.now() - start };
  });
}

async function listAllTools(client: Client, signal: AbortSignal, timeout: number) {
  const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageCount = 0; pageCount < 100; pageCount++) {
    const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout });
    tools.push(...page.tools);
    if (tools.length > 2000) throw new Error("MCP 工具数量超过上限。");
    cursor = page.nextCursor;
    if (!cursor) return tools;
    if (seen.has(cursor)) throw new Error("MCP 工具列表分页重复。");
    seen.add(cursor);
  }
  throw new Error("MCP 工具列表超过分页上限。");
}
