import http from "node:http";
import { pathToFileURL } from "node:url";

// Protocol fixture only: never uses real provider credentials or production data.
export async function startServiceFixture(port = 0) {
  const requests = [], collections = new Map(), documents = new Map();
  collections.set("web_pages", { name: "web_pages", fields: [{ name: "title", type: "string" }, { name: "content", type: "string" }, { name: "url", type: "string" }] });
  documents.set("web_pages:public-law", { id: "public-law", title: "公开网页法规", content: "网页补充资料：公开会议规范。", url: "https://example.test/public-law" });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const request = { path: url.pathname, method: req.method, query: url.searchParams.get("q"), authenticated: Boolean(req.headers.authorization || req.headers["x-typesense-api-key"]) };
      requests.push(request);
      let raw = ""; for await (const chunk of req) raw += chunk;
      const payload = raw && !url.pathname.endsWith("/import") ? JSON.parse(raw) : {};
      const send = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
      if (url.pathname === "/v1/models") return send({ data: [{ id: "qwen-fixture" }, { id: "llama-fixture" }] });
      if (url.pathname === "/api/tags") return send({ models: [{ name: "qwen-fixture" }] });
      if (url.pathname === "/v1/chat/completions") {
        if (payload.model === "unavailable") return send({ error: { message: `Invalid key ${req.headers.authorization || ""}` } }, 401);
        return send({ choices: [{ message: { content: "OK，模型连接测试成功。" }, finish_reason: "stop" }] });
      }
      if (url.pathname === "/api/chat") {
        request.think = payload.think;
        if (payload.model === "unavailable") return send({ error: `Invalid key ${req.headers.authorization || ""}` }, 401);
        if (payload.model === "qwen-thinking-fixture") return send(payload.think === false
          ? { message: { content: payload.options?.num_predict === 256 ? "OK" : "当前知识库中未找到足够的信息。请补充制作要求和验收约定。" }, done_reason: "stop" }
          : { message: { content: "", thinking: "分析缺少的材料。" }, done_reason: "length" });
        return send({ message: { content: "OK，原生模型接口可用。" }, done_reason: "stop" });
      }
      if (url.pathname === "/search") return send({ results: [{ title: "连接测试结果", url: "https://example.com/", content: "隔离测试" }] });
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") return send({}, 405);
        if (payload.id === undefined) { res.writeHead(202); return res.end(); }
        const result = payload.method === "initialize" ? { protocolVersion: "2025-11-25", serverInfo: { name: "隔离 MCP 服务", version: "1.0" }, capabilities: { tools: {}, resources: {} } } :
          payload.method === "tools/list" ? { tools: [{ name: "search_fixture", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } }] } :
          payload.method === "resources/list" ? { resources: [{ name: "测试资源", uri: "test://resource" }] } :
          { content: [{ type: "text", text: "工具返回的测试证据" }] };
        return send({ jsonrpc: "2.0", id: payload.id, result });
      }
      if (url.pathname === "/health") return send({ ok: true });
      if (url.pathname === "/collections") {
        if (req.method === "POST") { collections.set(payload.name, payload); return send(payload); }
        return send([...collections.values()]);
      }
      const match = url.pathname.match(/^\/collections\/([^/]+)(.*)$/);
      if (match) {
        const name = decodeURIComponent(match[1]), suffix = match[2];
        if (!collections.has(name)) return send({}, 404);
        if (!suffix) return send(collections.get(name));
        if (suffix === "/documents/import") {
          const docs = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
          for (const doc of docs) documents.set(name + ":" + doc.id, doc);
          res.writeHead(200, { "content-type": "text/plain" }); return res.end(docs.map(() => '{"success":true}').join("\n"));
        }
        const filter = url.searchParams.get("filter_by") || "", scope = filter.match(/project_id:=([a-f0-9]+)/)?.[1];
        if (suffix === "/documents/search") {
          const q = url.searchParams.get("q");
          return send({ hits: [...documents.entries()].filter(([key, doc]) => key.startsWith(name + ":") && (!scope || doc.project_id === scope) && (q === "*" || (doc.title + doc.content).includes(q)) && (!filter.includes("kind:=wiki") || doc.kind === "wiki")).map(([, document]) => ({ document })) });
        }
        if (suffix === "/documents" && req.method === "DELETE") {
          const ids = filter.match(/id:=\[([^\]]+)\]/)?.[1].split(",") || [];
          let num_deleted = 0;
          for (const id of ids) if (documents.get(name + ":" + id)?.project_id === scope && documents.delete(name + ":" + id)) num_deleted++;
          return send({ num_deleted });
        }
      }
      send({ error: "Fixture endpoint not found" }, 404);
    } catch { res.writeHead(500); res.end('{"error":"Fixture failure"}'); }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startServiceFixture(Number(process.argv[2] || 3014));
  console.log(`Isolated service fixture: ${fixture.url}`);
}
