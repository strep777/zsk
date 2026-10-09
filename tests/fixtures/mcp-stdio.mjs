import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const server = new McpServer({ name: "自动化测试 MCP", version: "1.0" });
server.registerTool("search_fixture", { description: "测试目录" }, async () => ({ content: [{ type: "text", text: "测试回答" }] }));
server.registerResource("fixture", "test://resource", {}, async () => ({ contents: [{ uri: "test://resource", text: "测试资源" }] }));
await server.connect(new StdioServerTransport());
