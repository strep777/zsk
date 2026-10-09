// @vitest-environment jsdom
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { api, ApiError } from "../src/api";
import { MarkdownView, resolveDocumentLink } from "../src/components/MarkdownView";
import { Project, ProjectSettings, WikiFile } from "../src/types";

const projects: Project[] = ["a", "b"].map((id) => ({ id, name: `知识库 ${id}`, description: "", createdAt: "", updatedAt: "", root: "" }));
const settings: ProjectSettings = { language: "zh-CN", provider: "ollama", model: "test", baseUrl: "http://localhost:11434", systemPrompt: "", webSearchProvider: "none", skills: [], mcpServers: [], activeModelId: "local", modelProfiles: [{ id: "local", name: "本地测试模型", provider: "ollama", model: "test", baseUrl: "http://localhost:11434", enabled: true }] };
const file = (path: string, title: string): WikiFile => ({ path, title, type: "concept", tags: [], sources: [], links: [], size: 10, mtime: "" });
let host: HTMLDivElement;
let root: Root;

async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === text || node.title === text);
  expect(button, `找不到按钮：${text}`).toBeDefined();
  await act(async () => { button!.click(); });
  await flush();
}
async function input(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mount() { await act(async () => root.render(<App />)); await flush(); }

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollTo = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(api, "projects").mockResolvedValue({ projects });
  vi.spyOn(api, "wikiFiles").mockResolvedValue({ files: [file("wiki/index.md", "首页"), file("wiki/concepts/topic.md", "概念")] });
  vi.spyOn(api, "activity").mockResolvedValue({ queue: [], sources: [] });
  vi.spyOn(api, "fileContent").mockImplementation(async (id, path) => ({ path, content: `# ${id} ${path}` }));
  vi.spyOn(api, "chats").mockResolvedValue({ chats: [] });
  vi.spyOn(api, "researchTasks").mockResolvedValue({ tasks: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings });
  vi.spyOn(api, "saveFile").mockResolvedValue({ ok: true });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("workspace regressions", () => {
  it("disables manual web search until an external service is configured", async () => {
    await mount(); await click("查询");
    const button = host.querySelector<HTMLButtonElement>(".web-search-action")!;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("设置");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });
  it("uses saved model configuration in queries while keeping unsaved settings drafts", async () => {
    await mount(); await click("设置");
    const name = [...host.querySelectorAll<HTMLInputElement>(".model-profile-card input")].find((input) => input.value === "本地测试模型")!;
    await input(name, "尚未保存的模型名称");
    await click("查询");
    const selector = host.querySelector<HTMLSelectElement>(".model-select-action select")!;
    expect(selector.textContent).toContain("本地测试模型");
    expect(selector.textContent).not.toContain("尚未保存的模型名称");
    await click("设置");
    expect([...host.querySelectorAll<HTMLInputElement>(".model-profile-card input")].some((input) => input.value === "尚未保存的模型名称")).toBe(true);
  });
  it("initially selects the saved default model and preserves an explicit summary-mode choice", async () => {
    await mount(); await click("查询");
    const selector = host.querySelector<HTMLSelectElement>(".model-select-action select")!;
    expect(selector.value).toBe("local");
    await act(async () => { selector.value = "summary"; selector.dispatchEvent(new Event("change", { bubbles: true })); });
    await click("设置");
    await click("重载");
    await click("查询");
    expect(host.querySelector<HTMLSelectElement>(".model-select-action select")?.value).toBe("summary");
  });

  it("protects unsaved settings when a reload is cancelled", async () => {
    await mount(); await click("设置"); await click("添加模型");
    const before = host.querySelectorAll(".model-profile-card").length;
    const reloads = vi.mocked(api.settings).mock.calls.length;
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await click("重载");
    expect(window.confirm).toHaveBeenCalled();
    expect(vi.mocked(api.settings).mock.calls).toHaveLength(reloads);
    expect(host.querySelectorAll(".model-profile-card")).toHaveLength(before);
  });
  it("reports a completed save accurately when the later refresh fails", async () => {
    await mount(); await input(host.querySelector(".editor-grid textarea")!, "# 已保存的正文");
    vi.mocked(api.wikiFiles).mockRejectedValueOnce(new Error("网络已断开"));
    await click("保存");
    expect(host.textContent).toContain("Markdown 已保存，但刷新列表失败");
    expect((host.querySelector(".editor-grid textarea") as HTMLTextAreaElement).value).toBe("# 已保存的正文");
  });
  it("offers actual model tests and model discovery without claiming untested models are available", async () => {
    const diagnose = vi.spyOn(api, "diagnoseSettings").mockResolvedValue({ message: "已获取 2 个模型", models: ["qwen-a", "qwen-b"] });
    await mount(); await click("设置");
    expect(host.textContent).not.toContain("配置完整，可在查询页使用。");
    await click("获取模型");
    expect(diagnose).toHaveBeenCalledWith("a", "models", expect.objectContaining({ profile: expect.objectContaining({ provider: "ollama" }) }));
    expect(host.querySelectorAll('datalist option')).toHaveLength(2);
    diagnose.mockResolvedValue({ message: "模型测试成功", response: "OK", latencyMs: 10 });
    await click("测试模型");
    expect(host.textContent).toContain("模型测试成功");
    expect(host.textContent).toContain("OK");
  });

  it("starts new capability cards without sample instructions, URLs or model IDs", async () => {
    await mount(); await click("设置");
    await click("添加模型"); await click("添加 Skill"); await click("添加 MCP");
    const cards = host.querySelectorAll(".model-profile-card");
    expect([...cards[1].querySelectorAll("input")].filter((node) => node.type !== "checkbox").every((node) => node.value === "")).toBe(true);
    expect(host.querySelector<HTMLTextAreaElement>('[placeholder="填写真实任务规则"]')?.value).toBe("");
    expect(host.querySelector<HTMLInputElement>('[placeholder="填写真实的 MCP 服务地址"]')?.value).toBe("");
    expect(host.textContent).not.toContain("新 MCP 服务器");
  });

  it("ignores an old successful model test after its connection configuration changes", async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.diagnoseSettings>>) => void;
    vi.spyOn(api, "diagnoseSettings").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount(); await click("设置"); await click("测试模型");
    const base = [...host.querySelectorAll("input")].find((node) => node.value === "http://localhost:11434")!;
    await input(base, "http://localhost:11435");
    await act(async () => finish({ message: "旧配置成功", response: "OK" }));
    expect(host.textContent).not.toContain("旧配置成功");
    expect([...host.querySelectorAll("button")].find((button) => button.textContent === "测试模型")?.disabled).toBe(false);
  });

  it("fills MCP tools and resources from discovery while preserving edits in other settings", async () => {
    const diagnose = vi.spyOn(api, "diagnoseSettings").mockResolvedValue({ message: "已发现能力", tools: ["search_law"], resources: ["docs://law"] });
    await mount(); await click("设置"); await click("添加 MCP");
    await input(host.querySelector<HTMLInputElement>('[placeholder="填写真实的 MCP 服务地址"]')!, "http://localhost:8000/mcp");
    await click("获取工具和资源");
    expect(diagnose).toHaveBeenCalledWith("a", "mcp", expect.anything());
    expect([...host.querySelectorAll("textarea")].map((node) => node.value)).toEqual(expect.arrayContaining(["search_law", "docs://law"]));
    expect(host.textContent).toContain("已发现能力");
  });
  it("defers file and activity refresh until the entire upload batch finishes", async () => {
    const rawFiles = vi.spyOn(api, "rawFiles").mockResolvedValue({ files: [] });
    vi.spyOn(api, "resumeQueue").mockResolvedValue({ ok: true });
    let finish!: (value: Awaited<ReturnType<typeof api.uploadSources>>) => void;
    let uploadOptions!: NonNullable<Parameters<typeof api.uploadSources>[2]>;
    vi.spyOn(api, "uploadSources").mockImplementation((_id, _files, options) => {
      uploadOptions = options!;
      return new Promise((resolve) => { finish = resolve; });
    });
    await mount(); vi.useFakeTimers();
    await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent === "文件")!.click());
    await act(async () => vi.advanceTimersByTimeAsync(250));
    rawFiles.mockClear(); vi.mocked(api.activity).mockClear(); vi.mocked(api.wikiFiles).mockClear();
    const element = host.querySelector('.file-manager input[type="file"]')!;
    Object.defineProperty(element, "files", { value: [new File(["甲"], "甲.txt"), new File(["乙"], "乙.txt")] });
    await act(async () => element.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => uploadOptions.onProgress?.({ batchIndex: 1, batchCount: 2, uploadedFiles: 1, totalFiles: 2, queued: 1, skipped: 0, uploadedBytes: 3, totalBytes: 6, fileName: "甲.txt", detail: "甲.txt 上传完成" }));
    expect(host.querySelector(".notice")?.textContent || "").not.toContain("上传中：");
    await act(async () => vi.advanceTimersByTimeAsync(31000));
    expect(rawFiles).not.toHaveBeenCalled();
    expect(api.activity).not.toHaveBeenCalled();
    expect(api.wikiFiles).not.toHaveBeenCalled();
    expect(host.querySelector(".file-loading-strip")).toBeNull();
    await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === "暂停")!.click());
    await input(host.querySelector('.file-search input')!, "最新筛选");
    await act(async () => vi.advanceTimersByTimeAsync(31000));
    expect(rawFiles).not.toHaveBeenCalled();
    expect(api.activity).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === "继续")!.click());
    await act(async () => finish({ sources: [], total: 2, queued: 2, skipped: 0, archives: [], activity: { queue: [], sources: [] } }));
    expect(rawFiles).toHaveBeenCalledTimes(1);
    expect(rawFiles.mock.calls[0][1]?.query).toBe("最新筛选");
    expect(api.activity).toHaveBeenCalledTimes(1);
    expect(api.wikiFiles).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".upload-progress-panel")?.textContent).toContain("已完成");
  });

  it("uses the actual sliced uploader without refreshing between chunks or between files", async () => {
    const rawFiles = vi.spyOn(api, "rawFiles").mockResolvedValue({ files: [] });
    vi.spyOn(api, "resumeQueue").mockResolvedValue({ ok: true });
    let releaseSecond!: () => void, releaseThird!: () => void;
    const fetchMock = vi.fn(async (url: string) => {
      const params = new URL(url, "http://localhost").searchParams;
      expect(params.get("deferRefresh")).toBe("1");
      if (fetchMock.mock.calls.length === 2) await new Promise<void>((resolve) => { releaseSecond = resolve; });
      if (fetchMock.mock.calls.length === 3) await new Promise<void>((resolve) => { releaseThird = resolve; });
      return new Response(JSON.stringify({ done: params.get("totalChunks") === "1" || params.get("index") === "1", queued: 1 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await mount(); await click("文件");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    rawFiles.mockClear(); vi.mocked(api.activity).mockClear(); vi.mocked(api.wikiFiles).mockClear();
    const element = host.querySelector('.file-manager input[type="file"]')!;
    Object.defineProperty(element, "files", { value: [new File([new Uint8Array(8 * 1024 * 1024 + 1)], "大文件.txt"), new File(["乙"], "第二份.txt")] });
    await act(async () => element.dispatchEvent(new Event("change", { bubbles: true })));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".upload-progress-panel")?.textContent).toContain("分片 1/2");
    expect(rawFiles).not.toHaveBeenCalled(); expect(api.activity).not.toHaveBeenCalled();
    expect(host.querySelector(".notice")).toBeNull(); expect(host.querySelector(".file-loading-strip")).toBeNull();
    await act(async () => releaseSecond());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(rawFiles).not.toHaveBeenCalled(); expect(api.activity).not.toHaveBeenCalled();
    await act(async () => releaseThird());
    expect(rawFiles).toHaveBeenCalledTimes(1); expect(api.activity).toHaveBeenCalledTimes(1); expect(api.wikiFiles).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".upload-progress-panel")?.textContent).toContain("已完成");
  });

  it("configures Typesense in external search while keeping the knowledge base built-in", async () => {
    vi.mocked(api.settings).mockResolvedValue({ settings: { ...settings, localSearchProvider: "builtin", webSearchProvider: "typesense", webSearchUrl: "http://localhost:8108", webSearchApiKey: "fixture-key", webSearchCollection: "web_pages" } });
    const diagnose = vi.spyOn(api, "diagnoseSettings").mockResolvedValue({ message: "已获取集合", collections: ["web_pages"], queryBy: "title,content" });
    await mount(); await click("设置");
    expect(host.textContent).toContain("当前引擎：内置文件搜索");
    expect(host.querySelectorAll('select option[value="typesense"]')).toHaveLength(1);
    expect(host.textContent).not.toContain("同步知识库索引");
    await click("获取集合和字段");
    expect(diagnose).toHaveBeenCalledWith("a", "web-search-collections", expect.anything());
    expect(host.querySelector<HTMLInputElement>('[placeholder="留空自动获取，例如 title,content"]')?.value).toBe("title,content");
    expect(host.querySelector('#web-typesense-collections option')?.getAttribute("value")).toBe("web_pages");
  });

  it.each(["cancel", "error"])("refreshes uploaded results and resumes polling after upload %s", async (ending) => {
    const rawFiles = vi.spyOn(api, "rawFiles").mockResolvedValue({ files: [] });
    let fail!: (error: Error) => void;
    vi.spyOn(api, "uploadSources").mockImplementation((_id, _files, options) => new Promise((_resolve, reject) => {
      fail = reject;
      options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("取消"), { name: "AbortError" })));
    }));
    await mount(); vi.useFakeTimers();
    await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent === "文件")!.click());
    await act(async () => vi.advanceTimersByTimeAsync(250));
    const element = host.querySelector('.file-manager input[type="file"]')!;
    Object.defineProperty(element, "files", { value: [new File(["材料"], "材料.txt")] });
    await act(async () => element.dispatchEvent(new Event("change", { bubbles: true })));
    rawFiles.mockClear(); vi.mocked(api.activity).mockClear();
    if (ending === "cancel") {
      await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === "取消")!.click());
    } else {
      await act(async () => fail(new Error("分片连接失败")));
    }
    expect(rawFiles).toHaveBeenCalledTimes(1);
    expect(api.activity).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(ending === "cancel" ? "上传已取消" : "分片连接失败");
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(api.activity).toHaveBeenCalledTimes(2);
    expect(rawFiles).toHaveBeenCalledTimes(2);
  });

  it("hides and invalidates a file refresh that was already pending when upload starts", async () => {
    let finishList!: (value: Awaited<ReturnType<typeof api.rawFiles>>) => void;
    vi.spyOn(api, "rawFiles").mockImplementation(() => new Promise((resolve) => { finishList = resolve; }));
    vi.spyOn(api, "uploadSources").mockImplementation(() => new Promise(() => {}));
    await mount(); vi.useFakeTimers();
    await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent === "文件")!.click());
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(host.querySelector(".file-loading-strip")).not.toBeNull();
    const element = host.querySelector('.file-manager input[type="file"]')!;
    Object.defineProperty(element, "files", { value: [new File(["材料"], "材料.txt")] });
    await act(async () => element.dispatchEvent(new Event("change", { bubbles: true })));
    expect(host.querySelector(".file-loading-strip")).toBeNull();
    expect(vi.mocked(api.rawFiles).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => finishList({ files: [{ id: "old", fileName: "旧刷新结果.txt", relativePath: "raw/sources/old.txt", kind: "text", size: 1, sha256: "", importedAt: "", updatedAt: "", status: "ready" }] }));
    expect(host.querySelector(".file-table")?.textContent).not.toContain("旧刷新结果");
    expect([...host.querySelectorAll(".file-actions button")].filter((button) => ["上传", "扫描", "刷新"].includes(button.textContent?.trim() || "")).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("refreshes the current clean document after generated files change", async () => {
    await mount();
    vi.mocked(api.fileContent).mockResolvedValue({ path: "wiki/index.md", content: "# 更新后的知识库索引" });
    await click("刷新");
    expect((host.querySelector(".editor-grid textarea") as HTMLTextAreaElement).value).toBe("# 更新后的知识库索引");
    await input(host.querySelector(".editor-grid textarea")!, "# 尚未保存的修改");
    vi.mocked(api.fileContent).mockResolvedValue({ path: "wiki/index.md", content: "# 再次更新的后台内容" });
    await click("刷新");
    expect((host.querySelector(".editor-grid textarea") as HTMLTextAreaElement).value).toBe("# 尚未保存的修改");
  });
  it("keeps the selected session when another session finishes deleting", async () => {
    const sessions = ["A", "B"].map((id) => ({ id, title: `会话 ${id}`, createdAt: "", updatedAt: id === "A" ? "2" : "1", messages: [{ role: "assistant" as const, content: `${id} 的回答`, createdAt: "" }] }));
    vi.mocked(api.chats).mockResolvedValue({ chats: sessions });
    let finish!: (value: { deleted: boolean }) => void;
    vi.spyOn(api, "deleteChat").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await mount(); await click("查询"); await click("删除会话"); await click("会话 B");
    vi.mocked(api.chats).mockResolvedValue({ chats: [sessions[1]] });
    await act(async () => finish({ deleted: true })); await flush();
    expect(host.querySelector(".chat-log")?.textContent).toContain("B 的回答");
  });
  it("preserves an unsent question when cancelling a new-session switch", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await mount(); await click("查询"); await input(host.querySelector(".ask-composer textarea")!, "尚未发送的问题");
    await click("新建会话");
    expect((host.querySelector(".ask-composer textarea") as HTMLTextAreaElement).value).toBe("尚未发送的问题");
  });
  it("shows the selected document after returning from a chat to Wiki", async () => {
    vi.spyOn(api, "chat").mockResolvedValue({ answer: "这是聊天回答", hits: [], chat: { id: "c1", title: "问题", createdAt: "", updatedAt: "", messages: [{ role: "assistant", content: "这是聊天回答", createdAt: "" }] } });
    await mount(); await click("查询");
    await input(host.querySelector(".ask-composer textarea")!, "问题"); await click("提问"); await click("Wiki");
    expect(host.querySelector(".preview-pane")?.textContent).toContain("a wiki/index.md");
    expect(host.querySelector(".preview-pane")?.textContent).not.toContain("这是聊天回答");
  });
  it("keeps a successful answer when refreshing the session list fails", async () => {
    vi.spyOn(api, "chat").mockResolvedValue({ answer: "回答已生成", hits: [], chat: { id: "c1", title: "中文问题", createdAt: "", updatedAt: "", messages: [{ role: "user", content: "中文问题", createdAt: "" }, { role: "assistant", content: "回答已生成", createdAt: "" }] } });
    await mount(); await click("查询");
    vi.mocked(api.chats).mockRejectedValueOnce(new Error("刷新列表失败"));
    await input(host.querySelector(".ask-composer textarea")!, "中文问题"); await click("提问");
    expect(host.querySelector(".chat-log")?.textContent).toContain("回答已生成");
    expect((host.querySelector(".ask-composer textarea") as HTMLTextAreaElement).value).toBe("");
    expect(host.textContent).not.toContain("本次提问失败");
  });

  it("restores the question when creating a research task fails", async () => {
    vi.spyOn(api, "research").mockRejectedValue(new Error("研究服务暂不可用"));
    await mount(); await click("查询");
    await input(host.querySelector(".ask-composer textarea")!, "需要保留的研究问题"); await click("深研");
    expect((host.querySelector(".ask-composer textarea") as HTMLTextAreaElement).value).toBe("需要保留的研究问题");
    expect(host.querySelector(".chat-session-list")?.textContent).not.toContain("需要保留的研究问题");
    expect(host.querySelector(".typing-indicator")).toBeNull();
  });

  it("does not let an earlier file failure overwrite the current preview", async () => {
    let fail!: (error: Error) => void;
    await mount();
    vi.mocked(api.fileContent).mockImplementation((_id, path) => path.includes("topic") ? new Promise((_resolve, reject) => { fail = reject; }) : Promise.resolve({ path, content: "# 当前首页" }));
    await click("概念"); await click("首页");
    await act(async () => fail(new Error("旧文件读取失败"))); await flush();
    expect(host.querySelector(".preview-pane")?.textContent).not.toContain("无法打开文件");
    expect(host.querySelector(".notice")?.textContent || "").not.toContain("旧文件读取失败");
  });

  it("preserves attachments added for the next question while waiting for an answer", async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.chat>>) => void;
    vi.spyOn(api, "chat").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(api, "extractAttachment").mockResolvedValue({ text: "下一轮的附件", warnings: [] });
    await mount(); await click("查询");
    await input(host.querySelector(".ask-composer textarea")!, "第一轮问题"); await click("提问");
    const element = host.querySelector('.ask-shell input[type="file"]')!;
    Object.defineProperty(element, "files", { value: [new File(["下一轮的附件"], "下一轮.txt")] });
    await act(async () => element.dispatchEvent(new Event("change", { bubbles: true }))); await flush();
    await input(host.querySelector(".ask-composer textarea")!, "下一轮问题");
    await act(async () => finish({ answer: "第一轮回答", hits: [], chat: { id: "c1", title: "第一轮问题", createdAt: "", updatedAt: "", messages: [{ role: "assistant", content: "第一轮回答", createdAt: "" }] } })); await flush();
    expect(host.querySelector(".attachment-tray")?.textContent).toContain("下一轮.txt");
    expect((host.querySelector(".ask-composer textarea") as HTMLTextAreaElement).value).toBe("下一轮问题");
  });

  it("preserves a new clip draft and prevents duplicate submission while importing", async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.clip>>) => void;
    const submit = vi.spyOn(api, "clip").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount(); await click("来源");
    await input(host.querySelector(".clip-form textarea")!, "第一份材料"); await click("入队");
    await input(host.querySelector(".clip-form textarea")!, "第二份材料");
    const pendingButton = host.querySelector('.clip-form button[type="submit"]') as HTMLButtonElement;
    expect(pendingButton.disabled).toBe(true);
    await act(async () => pendingButton.click());
    expect(submit).toHaveBeenCalledTimes(1);
    await act(async () => finish({ source: {} as Awaited<ReturnType<typeof api.clip>>["source"] })); await flush();
    expect((host.querySelector(".clip-form textarea") as HTMLTextAreaElement).value).toBe("第二份材料");
  });

  it("guards unsaved document drafts before creating and switching to another project", async () => {
    const create = vi.spyOn(api, "createProject").mockResolvedValue({ project: projects[1] });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await mount(); await input(host.querySelector(".editor-grid textarea")!, "# 尚未保存的文档");
    await click("新建"); await click("创建");
    expect(create).not.toHaveBeenCalled();
    expect((host.querySelector(".editor-grid textarea") as HTMLTextAreaElement).value).toBe("# 尚未保存的文档");
  });

  it("protects unsaved model settings when leaving the page", async () => {
    await mount(); await click("设置"); await click("添加模型");
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const select = host.querySelector(".project-bar select")! as HTMLSelectElement;
    await act(async () => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(select.value).toBe("a");
  });
  it("keeps editing drafts while reauthenticating an expired session", async () => {
    vi.spyOn(api, "authenticate").mockResolvedValue({ ok: true });
    await mount(); await input(host.querySelector(".editor-grid textarea")!, "# 登录前的草稿");
    await act(async () => window.dispatchEvent(new Event("llmwiki-auth-required")));
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await input(host.querySelector('input[type="password"]')!, "token"); await click("登录");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect((host.querySelector(".editor-grid textarea") as HTMLTextAreaElement).value).toBe("# 登录前的草稿");
  });
  it("continues polling a restored research session until it completes", async () => {
    const task = { id: "r1", topic: "恢复中的研究", queries: [], status: "running" as const, progress: 30, steps: [], createdAt: "", updatedAt: "" };
    vi.mocked(api.researchTasks).mockResolvedValue({ tasks: [task] });
    vi.spyOn(api, "researchTask").mockResolvedValue({ task: { ...task, status: "done", progress: 100, result: { path: "wiki/research/result.md", markdown: "# 恢复后的研究结果", queries: [] } } });
    await mount(); vi.useFakeTimers();
    await act(async () => [...host.querySelectorAll("button")].find((node) => node.textContent === "查询")!.click());
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    vi.useRealTimers(); await flush();
    expect(api.researchTask).toHaveBeenCalledWith("a", "r1");
    expect(host.querySelector(".chat-log")?.textContent).toContain("恢复后的研究结果");
  });
  it("snapshots a live FileList before clearing the file input", async () => {
    const extract = vi.spyOn(api, "extractAttachment").mockResolvedValue({ text: "公司章程附件正文", warnings: [] });
    await mount(); await click("查询");
    const attachment = new File(["公司章程附件正文"], "中文附件.txt", { type: "text/plain" });
    let selected = [attachment];
    const liveFiles = { get length() { return selected.length; }, [Symbol.iterator]: function* () { yield* selected; } };
    const element = host.querySelector('.ask-shell input[type="file"]')!;
    Object.defineProperty(element, "files", { get: () => liveFiles });
    Object.defineProperty(element, "value", { get: () => "", set: () => { selected = []; } });
    await act(async () => element.dispatchEvent(new Event("change", { bubbles: true })));
    await flush();
    expect(extract).toHaveBeenCalledWith("a", attachment);
    expect(host.querySelector(".attachment-tray")?.textContent).toContain("中文附件.txt");
  });
  it("can sign in when the server requires an API token", async () => {
    vi.mocked(api.projects).mockRejectedValueOnce(new ApiError(401, "请登录"));
    vi.spyOn(api, "authenticate").mockResolvedValue({ ok: true });
    await mount();
    await input(host.querySelector('input[type="password"]')!, "test-token");
    await click("登录");
    expect(api.authenticate).toHaveBeenCalledWith("test-token");
    expect(host.querySelector(".project-bar select")).not.toBeNull();
  });
  it("restores persisted research sessions after reloading", async () => {
    vi.mocked(api.researchTasks).mockResolvedValue({ tasks: [{ id: "r1", topic: "已完成的研究", queries: [], status: "done", progress: 100, steps: [], createdAt: "", updatedAt: "", result: { path: "wiki/research/result.md", markdown: "# 研究结果", queries: [] } }] });
    await mount(); await click("查询");
    expect(host.querySelector(".chat-session-list")?.textContent).toContain("已完成的研究");
  });
  it("isolates file responses when switching knowledge bases", async () => {
    let finish!: (value: { path: string; content: string }) => void;
    vi.mocked(api.fileContent).mockImplementation((id, path) => id === "a" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ path, content: "# B 首页" }));
    await mount();
    const select = host.querySelector(".project-bar select")! as HTMLSelectElement;
    await act(async () => { select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    await act(async () => finish({ path: "wiki/index.md", content: "# A 迟到的内容" }));
    expect((host.querySelector(".editor-grid textarea") as HTMLTextAreaElement).value).toBe("# B 首页");
  });

  it("loads model choices before visiting settings", async () => {
    await mount(); await click("查询");
    expect(host.querySelector(".model-select-action")?.textContent).toContain("本地测试模型");
  });

  it("restores failed questions and retries without a temporary chat ID", async () => {
    const chatMock = vi.spyOn(api, "chat").mockRejectedValue(new Error("网络失败"));
    await mount(); await click("查询");
    await input(host.querySelector(".ask-composer textarea")!, "中文问题"); await click("提问");
    expect((host.querySelector(".ask-composer textarea") as HTMLTextAreaElement).value).toBe("中文问题");
    expect(host.querySelector(".typing-indicator")).toBeNull();
    expect(host.querySelector(".chat-log")?.textContent).not.toContain("中文问题");
    await click("提问");
    expect(chatMock.mock.calls[1][1].chatId).toBeUndefined();
  });

  it("keeps unsaved drafts when navigating between documents", async () => {
    await mount(); await input(host.querySelector(".editor-grid textarea")!, "# 未保存草稿");
    await click("概念"); await click("首页");
    expect((host.querySelector(".editor-grid textarea") as HTMLTextAreaElement).value).toBe("# 未保存草稿");
  });

  it("does not overwrite a research note with the previous editor content", async () => {
    vi.spyOn(api, "research").mockResolvedValue({ task: { id: "r1", topic: "研究主题", queries: [], status: "done", progress: 100, steps: [], createdAt: "", updatedAt: "", result: { path: "wiki/research/result.md", markdown: "# 研究结果", queries: [] } } });
    await mount(); await click("查询"); await input(host.querySelector(".ask-composer textarea")!, "研究主题"); await click("深研"); await click("Wiki"); await click("保存");
    expect(api.saveFile).toHaveBeenCalledWith("a", "wiki/index.md", "# a wiki/index.md");
  });

  it("shows a completed clean health check distinctly from an unchecked state", async () => {
    vi.spyOn(api, "lint").mockResolvedValue({ issues: [] });
    await mount(); await click("体检"); await click("开始检查");
    expect(host.textContent).toContain("体检完成，未发现问题");
  });
});

describe("Markdown preview", () => {
  it("hides metadata, renders working wiki links and preserves code examples", async () => {
    const onOpen = vi.fn();
    await act(async () => root.render(<MarkdownView content={'---\r\ntitle: 元数据标题\r\n---\r\n# 正文标题\n\n[[概念|打开概念]]\n\n`[[概念]]`'} files={[file("wiki/concepts/topic.md", "概念")]} onOpen={onOpen} />));
    expect(host.textContent).not.toContain("元数据标题");
    expect(host.querySelector("code")?.textContent).toBe("[[概念]]");
    await act(async () => host.querySelector("a")!.click());
    expect(onOpen).toHaveBeenCalledWith("wiki/concepts/topic.md");
  });
  it("resolves local relative paths without escaping the wiki", () => {
    expect(resolveDocumentLink("../concepts/topic.md", "wiki/sources/doc.md")).toBe("wiki/concepts/topic.md");
    expect(resolveDocumentLink("../../.llm-wiki/settings.json", "wiki/sources/doc.md")).toBeUndefined();
    expect(resolveDocumentLink("%bad")).toBeUndefined();
    expect(resolveDocumentLink("../concepts/100%25.md", "wiki/sources/doc.md")).toBe("wiki/concepts/100%.md");
    expect(resolveDocumentLink("//example.com/wiki/doc.md")).toBeUndefined();
  });
  it("does not crash a preview with a malformed image URL", async () => {
    await act(async () => root.render(<MarkdownView projectId="p" content="![图片](raw/assets/%bad)" />));
    expect(host.querySelector("img")?.alt).toBe("图片");
  });
});
