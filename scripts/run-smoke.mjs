import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { startServiceFixture } from "../tests/fixtures/service-http.mjs";

// Exercise the built server with isolated, disposable data and synthetic credentials.
const workspace = process.cwd();
const services = await startServiceFixture();
const testRoot = await fs.mkdtemp(path.join(workspace, "tests", ".qa-http-"));
const portProbe = net.createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const base = `http://127.0.0.1:${port}/api/v1`;
const env = { ...process.env, PORT: String(port), LLM_WIKI_DATA_DIR: testRoot, LLM_WIKI_API_TOKEN: "smoke-only-token" };
for (const key of Object.keys(env)) if (/(?:API_KEY|BASE_URL|MODEL)$/.test(key)) delete env[key];
const child = spawn(process.execPath, ["dist/server/index.js"], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let serverOutput = "";
child.stdout.on("data", (data) => { serverOutput += data.toString(); });
child.stderr.on("data", (data) => { serverOutput += data.toString(); });
const exited = new Promise((resolve) => child.once("exit", resolve));
let cookie = "";
let checks = 0;
const check = (message, value = true) => { assert.ok(value, message); checks += 1; console.log(`PASS ${message}`); };
async function request(route, body, method = body === undefined ? "GET" : "POST", expectedStatus = 200) {
  const response = await fetch(`${base}${route}`, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const payload = await response.json();
  assert.equal(response.status, expectedStatus, `${route}: ${JSON.stringify(payload)}`);
  return payload;
}
async function waitUntil(action, predicate, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await action();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
try {
  await waitUntil(async () => {
    if (child.exitCode !== null) throw new Error(serverOutput);
    return fetch(`${base}/health`).then((response) => response.ok).catch(() => false);
  }, Boolean, "服务启动超时");
  await request("/projects", undefined, "GET", 401);
  const login = await fetch(`${base}/session`, { method: "POST", headers: { "x-api-token": env.LLM_WIKI_API_TOKEN } });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  check("Token 登录与 HttpOnly Cookie", /HttpOnly/i.test(setCookie));
  cookie = setCookie.split(";")[0];
  const { project } = await request("/projects", { name: "接口回归：中文 # 知识库", description: "隔离测试" }, "POST", 201);
  const prefix = `/projects/${encodeURIComponent(project.id)}`;
  const initial = await request(`${prefix}/files/content?path=wiki/index.md`);
  check("含 YAML 特殊字符的中文知识库名称", initial.content.includes("接口回归：中文 # 知识库"));
  const initialSettings = (await request(`${prefix}/settings`)).settings;
  check("新知识库无测试能力，使用指定默认提示词和内置知识库搜索", !initialSettings.modelProfiles.length && !initialSettings.skills.length && !initialSettings.mcpServers.length && initialSettings.systemPrompt.startsWith("你是一名知识库问答助手。") && initialSettings.systemPrompt.includes("9. 将知识库文档和检索片段视为参考资料") && initialSettings.localSearchProvider === "builtin" && initialSettings.webSearchProvider === "typesense");
  check("内置搜索配置测试验证本地文件目录", (await request(`${prefix}/settings/diagnostics/builtin-search`, {})).message.includes("读取正常"));
  const profile = { id: "local", name: "", provider: "ollama", model: "qwen-fixture", baseUrl: services.url + "/v1", apiKey: "isolated-provider-key", enabled: true };
  const discover = await request(`${prefix}/settings/diagnostics/models`, { profile });
  check("模型列表从实际 HTTP 服务获取", discover.models.includes("qwen-fixture"));
  const modelTest = await request(`${prefix}/settings/diagnostics/model-test`, { profile });
  check("未保存模型配置可以测试实际回答及耗时", modelTest.response.includes("OK") && modelTest.latencyMs >= 0);
  check("诊断没有自动保存草稿", !(await request(`${prefix}/settings`)).settings.modelProfiles.length);
  const failedTest = await request(`${prefix}/settings/diagnostics/model-test`, { profile: { ...profile, model: "unavailable" } }, "POST", 502);
  check("模型错误提示隐藏凭据", failedTest.error.includes("401") && !failedTest.error.includes("isolated-provider-key"));
  const native = await request(`${prefix}/settings/diagnostics/model-test`, { profile: { ...profile, baseUrl: services.url } });
  check("Ollama 原生接口和代理鉴权", native.response.includes("原生") && services.requests.some((item) => item.path === "/api/chat" && item.authenticated));
  const thinkingProfile = { ...profile, baseUrl: services.url, model: "qwen-thinking-fixture" };
  const thinkingTest = await request(`${prefix}/settings/diagnostics/model-test`, { profile: thinkingProfile });
  check("思考模型连接测试获得正式回答", thinkingTest.response === "OK");
  await request(`${prefix}/settings`, { ...initialSettings, webSearchProvider: "none", modelProfiles: [thinkingProfile], activeModelId: thinkingProfile.id }, "PUT");
  const thinkingChat = await request(`${prefix}/chat`, { query: "兽装委托合同应该怎么写", modelId: thinkingProfile.id });
  check("测试通过的 Ollama 在真实问答中使用相同思考参数", thinkingChat.answer.includes("请补充制作要求和验收约定") && services.requests.filter((item) => item.path === "/api/chat").every((item) => item.think === false));
  await request(`${prefix}/chats/${thinkingChat.chat.id}`, undefined, "DELETE");
  await request(`${prefix}/settings`, { ...initialSettings, webSearchProvider: "none", modelProfiles: [{ ...thinkingProfile, model: "unavailable" }], activeModelId: thinkingProfile.id }, "PUT");
  const nativeFailure = await request(`${prefix}/chat`, { query: "兽装委托合同应该怎么写", modelId: thinkingProfile.id });
  check("问答呈现具体模型错误且不泄露凭据", nativeFailure.answer.includes("HTTP 401") && !nativeFailure.answer.includes("isolated-provider-key") && !nativeFailure.answer.includes("没有获取到可用的联网搜索结果"));
  await request(`${prefix}/chats/${nativeFailure.chat.id}`, undefined, "DELETE");
  await request(`${prefix}/settings`, initialSettings, "PUT");
  const mcp = await request(`${prefix}/settings/diagnostics/mcp`, { server: { id: "mcp", name: "", transport: "http", url: services.url + "/mcp", enabled: true } });
  check("MCP 初始化后获取工具、资源和服务名称", mcp.tools.includes("search_fixture") && mcp.resources.includes("test://resource") && mcp.name === "隔离 MCP 服务");
  const web = await request(`${prefix}/settings/diagnostics/web-search`, { settings: { ...initialSettings, webSearchProvider: "searxng", webSearchUrl: services.url, webSearchApiKey: "isolated-search-key" } });
  check("外部搜索服务测试并发送配置的鉴权", web.results === 1 && services.requests.some((item) => item.path === "/search" && item.authenticated));
  const searchSettings = { ...initialSettings, localSearchProvider: "builtin", webSearchProvider: "typesense", webSearchUrl: services.url, webSearchApiKey: "isolated-typesense-key", webSearchCollection: "web_pages" };
  check("Typesense 外部搜索获取集合和字段", (await request(`${prefix}/settings/diagnostics/web-search-collections`, { settings: searchSettings })).collections.includes("web_pages"));
  const discovered = await request(`${prefix}/settings/diagnostics/web-search-collections`, { settings: { ...searchSettings, webSearchCollection: "" } });
  check("未选择集合时可以先获取现有集合", discovered.collections.includes("web_pages"));
  const missingCollection = await request(`${prefix}/settings/diagnostics/web-search`, { settings: { ...searchSettings, webSearchCollection: "" } }, "POST", 400);
  check("缺少集合时搜索测试明确报错", Boolean(missingCollection.error));
  const staleCollection = await request(`${prefix}/settings/diagnostics/web-search-collections`, { settings: { ...searchSettings, webSearchCollection: "removed_collection" } });
  check("失效集合不阻止获取可用集合", staleCollection.collections.includes("web_pages") && !staleCollection.queryBy);
  const externalTest = await request(`${prefix}/settings/diagnostics/web-search`, { settings: searchSettings });
  check("Typesense 外部搜索验证实际引用", externalTest.results === 1 && externalTest.queryBy === "title,content");
  await request(`${prefix}/files/content`, { path: "wiki/concepts/typesense-test.md", content: "# 中文索引验证\n索引回归证据。" }, "PUT");
  await request(`${prefix}/settings`, searchSettings, "PUT");
  const beforeLocalSearch = services.requests.length;
  const search = await request(`${prefix}/search`, { query: "索引回归证据" });
  check("知识库检索使用内置搜索且不访问 Typesense", search.hits.some((hit) => hit.path === "wiki/concepts/typesense-test.md") && services.requests.length === beforeLocalSearch);
  const externalChat = await request(`${prefix}/chat`, { query: "公开会议规范", webSearch: true });
  check("问答联网从 Typesense 获取网页引用", externalChat.hits.some((hit) => hit.path === "https://example.test/public-law") && services.requests.filter((item) => item.path.startsWith("/collections")).every((item) => item.method === "GET"));
  await request(`${prefix}/chats/${externalChat.chat.id}`, undefined, "DELETE");
  await request(`${prefix}/settings/diagnostics/typesense-sync`, { settings: searchSettings }, "POST", 400);
  check("拒绝把知识库同步到外部网页集合");
  await request(`${prefix}/settings`, initialSettings, "PUT");
  const beforeInvalidDiagnostics = services.requests.length;
  await request(`${prefix}/settings/diagnostics/models`, { profile: { ...profile, apiKey: 42 } }, "POST", 400);
  await request(`${prefix}/settings/diagnostics/mcp`, { server: { id: "invalid", name: "", transport: "http", url: services.url + "/mcp", tools: [42], enabled: true } }, "POST", 400);
  check("诊断拒绝错误字段类型且不请求外部服务", services.requests.length === beforeInvalidDiagnostics);
  await request(`${prefix}/settings`, { ...initialSettings, webSearchProvider: "none" }, "PUT");
  const beforeDisabledSearch = services.requests.length;
  const disabledChat = await request(`${prefix}/chat`, { query: "关闭搜索后的独立问题", webSearch: true, modelId: "summary" });
  check("外部搜索关闭时强制开关也不发送请求", services.requests.length === beforeDisabledSearch && !disabledChat.hits.some((hit) => hit.type === "web"));
  await request(`${prefix}/chats/${disabledChat.chat.id.toUpperCase()}`, undefined, "DELETE", 400);
  check("错误会话 ID 不会误删正确会话", (await request(`${prefix}/chats`)).chats.some((chat) => chat.id === disabledChat.chat.id));
  await request(`${prefix}/chats/${disabledChat.chat.id}`, undefined, "DELETE");
  const longAttachment = "附件前文。".repeat(900) + "附件末尾的完整验收条款。";
  const attachmentChat = await request(`${prefix}/chat`, { query: "保存完整附件", modelId: "summary", attachments: [{ name: "验收条款.txt", kind: "text", mimeType: "text/plain", text: longAttachment }] });
  check("合法附件完整保存在会话中并可重新读取", (await request(`${prefix}/chats`)).chats.find((chat) => chat.id === attachmentChat.chat.id)?.messages[0].attachments?.[0].text === longAttachment);
  await request(`${prefix}/chats/${attachmentChat.chat.id}`, undefined, "DELETE");
  await request(`${prefix}/settings`, initialSettings, "PUT");
  for (const filePath of ["wiki/../.llm-wiki/settings.json", "raw/sources/../../.llm-wiki/settings.json"]) {
    await request(`${prefix}/files/content?path=${encodeURIComponent(filePath)}`, undefined, "GET", 400);
  }
  await request(`${prefix}/assets?path=${encodeURIComponent("raw/assets/../../.llm-wiki/settings.json")}`, undefined, "GET", 400);
  check("Wiki、原文和图片接口限制访问目录");
  await request(`${prefix}/chat`, { query: "   " }, "POST", 400);
  await request(`${prefix}/sources/clip`, { content: "   " }, "POST", 400);
  check("空问题与空剪藏内容校验");
  const clip = await request(`${prefix}/sources/clip`, { title: "公司章程", content: '# 公司章程\n\n公司章程约定股东的出资期限。\n\n```python\nif True:\n    print("中文")\n```' }, "POST", 201);
  const clipFile = await request(`${prefix}/files/content?path=${encodeURIComponent(clip.source.relativePath)}`);
  check("Markdown 剪藏保留缩进且不重复标题", clipFile.content.includes('    print("中文")') && clipFile.content.match(/# 公司章程/g)?.length === 1);
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# 公司章程\n\n公司章程规定股东的出资方式、出资期限和治理规则。", "utf16le")]);
  const attachmentResponse = await fetch(`${base}${prefix}/attachments/extract?fileName=${encodeURIComponent("中文附件.txt")}`, { method: "POST", headers: { "content-type": "application/octet-stream", cookie }, body: bytes });
  assert.equal(attachmentResponse.status, 200);
  const attachment = await attachmentResponse.json();
  check("聊天附件共享中文编码解析", attachment.text.includes("公司章程规定股东") && !attachment.text.includes("\uFFFD"));
  async function chunk(params, buffer, expectedStatus) {
    const query = new URLSearchParams({ uploadId: "smoke-utf16", fileName: "中文材料.txt", fileSize: String(bytes.length), totalChunks: "2", deferRefresh: "1", ...params });
    const response = await fetch(`${base}${prefix}/sources/upload-chunk?${query}`, { method: "PUT", headers: { "content-type": "application/octet-stream", cookie }, body: buffer });
    const data = await response.json();
    assert.equal(response.status, expectedStatus, JSON.stringify(data));
    return data;
  }
  await chunk({ index: "1", offset: "10", chunkSize: "2" }, bytes.subarray(10, 12), 409);
  await chunk({ index: "0", offset: "0", chunkSize: "10" }, bytes.subarray(0, 10), 200);
  await chunk({ index: "0", offset: "0", chunkSize: "10" }, Buffer.alloc(10, 120), 409);
  check("已接收分片拒绝不同内容的重复提交");
  await chunk({ index: "0", offset: "0", chunkSize: "10" }, Buffer.from("xx"), 400);
  check("分片实际大小错误时不破坏已接收内容");
  await chunk({ uploadId: "too-large", index: "0", offset: "0", chunkSize: "1", fileSize: String(10240 * 1024 * 1024 + 1), totalChunks: "1" }, Buffer.from("x"), 413);
  check("分片上传遵守文件总大小限制");
  await chunk({ index: "1", offset: "12", chunkSize: "2" }, bytes.subarray(12, 14), 409);
  const upload = await chunk({ index: "1", offset: "10", chunkSize: String(bytes.length - 10) }, bytes.subarray(10), 201);
  check("中文文件分片上传及错序、间隙检测，上传响应不刷新状态", upload.done && !("activity" in upload));
  const activity = await waitUntil(() => request(`${prefix}/activity`), (value) => value.sources.some((source) => source.id === upload.sources[0].id && source.status === "ready") && !value.queue.some((item) => item.status === "running" || item.status === "queued"), "摄入未完成");
  const source = activity.sources.find((item) => item.id === upload.sources[0].id);
  const converted = await request(`${prefix}/files/content?path=${encodeURIComponent(source.convertedPath)}`);
  check("UTF-16 中文提取与完整摄入", converted.content.includes("公司章程规定股东") && !converted.content.includes("\uFFFD"));
  const substantiveClip = await request(`${prefix}/sources/clip`, {
    title: "测试旅游规则",
    content: "# 安徽省人民代表大会常务委员会\n\n第一条 本文仅为自动化测试材料。文明旅游应遵守公共秩序，保护环境，不得损坏公共设施。\n\n第二条 旅游经营者应公开服务价格并提供投诉渠道。"
  }, "POST", 201);
  const substantiveActivity = await waitUntil(() => request(`${prefix}/activity`), (value) => value.sources.some((item) => item.id === substantiveClip.source.id && item.status === "ready"), "正文摘要摄入完成");
  const substantiveSource = substantiveActivity.sources.find((item) => item.id === substantiveClip.source.id);
  check("摄入摘要采用实质正文而非机关标题", substantiveSource.summary.includes("公共秩序") && substantiveSource.summary !== "安徽省人民代表大会常务委员会");
  const topics = (await request(`${prefix}/files?scope=wiki`)).files.filter((item) => ["concept", "entity"].includes(item.type));
  let substantiveTopic = false;
  for (const topic of topics) {
    const page = await request(`${prefix}/files/content?path=${encodeURIComponent(topic.path)}`);
    if (page.content.includes(substantiveSource.wikiPath) && page.content.includes("公共秩序") && !page.content.includes("等待更多来源沉淀")) substantiveTopic = true;
  }
  check("主题页包含正文依据和来源而非占位定义", substantiveTopic);
  const legacyOptions = {
    noSort: true,
    decoder: { encode: (name) => iconv.encode(name, "gbk"), decode: (name) => iconv.decode(name, "gbk"), efs: false }
  };
  const archive = new AdmZip(undefined, legacyOptions);
  const zipDocuments = [
    { name: "法律/啊.docx", text: "第一份法律材料：公司章程规定股东出资。" },
    { name: "法律/吧.docx", text: "第二份法律材料：合同约定履行期限。" }
  ];
  for (const document of zipDocuments) {
    const word = new AdmZip();
    word.addFile("word/document.xml", Buffer.from(`<w:document><w:body><w:p><w:r><w:t>${document.text}</w:t></w:r></w:p></w:body></w:document>`));
    archive.addFile(document.name, word.toBuffer());
  }
  const zipBytes = archive.toBuffer();
  const zipSplit = Math.floor(zipBytes.length / 2);
  const zipParams = { uploadId: "smoke-gbk-zip", fileName: "laws.zip", fileSize: String(zipBytes.length), totalChunks: "2" };
  await chunk({ ...zipParams, index: "0", offset: "0", chunkSize: String(zipSplit) }, zipBytes.subarray(0, zipSplit), 200);
  const zipUpload = await chunk({ ...zipParams, index: "1", offset: String(zipSplit), chunkSize: String(zipBytes.length - zipSplit) }, zipBytes.subarray(zipSplit), 202);
  check("GBK 中文 Word 压缩包分片上传完成", zipUpload.done && zipUpload.pending);
  const zipActivity = await waitUntil(() => request(`${prefix}/activity`), (value) => {
    const progress = value.archiveProgress.find((item) => item.fileName === "laws.zip");
    if (progress?.status === "failed") throw new Error(progress.error);
    const imported = value.sources.filter((item) => /(?:啊|吧)\.docx$/.test(item.fileName));
    return progress?.status === "done" && progress.extractedFiles === 2 && imported.length === 2 && imported.every((item) => item.status === "ready");
  }, "ZIP 解包和 Word 摄入未完成");
  const zipSources = zipActivity.sources.filter((item) => /(?:啊|吧)\.docx$/.test(item.fileName));
  check("ZIP 中文文件名不误判重复且均可用", zipSources.every((item) => !item.relativePath.includes("\uFFFD")));
  for (const imported of zipSources) {
    const page = await request(`${prefix}/files/content?path=${encodeURIComponent(imported.wikiPath)}`);
    assert.ok(page.content.includes(imported.fileName === "啊.docx" ? "第一份法律材料" : "第二份法律材料"));
  }
  check("ZIP 内两份 Word 正文分别生成知识库页面");
  for (const imported of zipSources) await request(`${prefix}/sources/${imported.id}`, undefined, "DELETE");
  const chat = await request(`${prefix}/chat`, { query: "公司章程对股东出资有什么规定？", modelId: "summary" });
  check("本地问答及引用", chat.answer.includes("公司章程") && chat.hits.length > 0);
  const followup = await request(`${prefix}/chat`, { query: "那出资期限呢？", chatId: chat.chat.id, modelId: "summary" });
  check("多轮追问保持本地证据", followup.chat.messages.length === 4 && followup.hits.length > 0);
  const saved = await request(`${prefix}/chats/${chat.chat.id}/save`, {});
  const note = await request(`${prefix}/files/content?path=${encodeURIComponent(saved.savedPath)}`);
  check("问答保存并可重新打开", note.content.includes("公司章程"));
  const research = await request(`${prefix}/research`, { topic: "公司章程", modelId: "summary" }, "POST", 202);
  const done = await waitUntil(() => request(`${prefix}/research/${research.task.id}`), (value) => value.task.status === "done" || value.task.status === "failed", "研究未完成");
  check("深研完成并保存 Wiki", done.task.status === "done" && Boolean(done.task.result?.path));
  check("研究会话持久化", (await request(`${prefix}/research`)).tasks.length === 1);
  const graph = await request(`${prefix}/graph`);
  check("图谱节点坐标有效", graph.nodes.length > 0 && graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
  check("体检接口正常返回", Array.isArray((await request(`${prefix}/lint`, {})).issues));
  await request(`${prefix}/research/${research.task.id}`, undefined, "DELETE");
  check("研究会话删除持久化", (await request(`${prefix}/research`)).tasks.length === 0);
  await request(`${prefix}/chats/${chat.chat.id}`, undefined, "DELETE");
  check("普通会话删除持久化", (await request(`${prefix}/chats`)).chats.length === 0);
  await request(`${prefix}/sources/${source.id}`, undefined, "DELETE");
  await request(`${prefix}/sources/${clip.source.id}`, undefined, "DELETE");
  await request(`${prefix}/sources/${substantiveClip.source.id}`, undefined, "DELETE");
  const remaining = await request(`${prefix}/activity`);
  check("移除来源同步更新记录和队列", remaining.sources.length === 0 && remaining.queue.length === 0);
  await request(`${prefix}/files/content?path=${encodeURIComponent(source.convertedPath)}`, undefined, "GET", 404);
  console.log(`HTTP smoke: ${checks} checks passed.`);
} catch (error) {
  console.error(serverOutput);
  throw error;
} finally {
  child.kill();
  await exited;
  await services.close();
  const relative = path.relative(path.join(workspace, "tests"), testRoot);
  if (relative.startsWith(".qa-http-") && !relative.includes(path.sep)) await fs.rm(testRoot, { recursive: true, force: true });
}
