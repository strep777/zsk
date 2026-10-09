// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { api, ApiError } from "../src/api";
import type { ChatSession, KnowledgeGraph, Project, ProjectSettings, ResearchTask, WikiFile } from "../src/types";

const projects: Project[] = ["a", "b"].map((id) => ({ id, name: `知识库 ${id}`, description: "", createdAt: "", updatedAt: "", root: "" }));
const settings: ProjectSettings = { language: "zh-CN", provider: "offline", model: "", baseUrl: "", systemPrompt: "", webSearchProvider: "none", skills: [], mcpServers: [], modelProfiles: [] };
const files: WikiFile[] = [{ path: "wiki/index.md", title: "首页", type: "index", tags: [], sources: [], links: [], size: 10, mtime: "" }];
const session: ChatSession = { id: "chat-a", title: "保留的聊天", createdAt: "", updatedAt: "", messages: [{ role: "assistant", content: "保留的回答", createdAt: "" }] };
const task: ResearchTask = { id: "research-a", topic: "保留的研究", queries: [], status: "done", progress: 100, steps: [], createdAt: "", updatedAt: "", result: { path: "wiki/research/note.md", markdown: "# 研究结果", queries: [] } };
const graph = (title: string): KnowledgeGraph => ({ nodes: [], edges: [], insights: [{ kind: "test", title, detail: "图谱结果", paths: [] }] });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail; }); return { promise, resolve, reject }; }
let host: HTMLDivElement, root: Root;
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function mount() { await act(async () => root.render(<App />)); await flush(); }
function button(text: string) { return [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === text || node.title === text)!; }
async function click(text: string) { expect(button(text), text).toBeDefined(); await act(async () => button(text).click()); await flush(); }
async function input(node: HTMLInputElement | HTMLTextAreaElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")!.set!.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); HTMLElement.prototype.scrollTo = vi.fn();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(api, "projects").mockResolvedValue({ projects });
  vi.spyOn(api, "wikiFiles").mockResolvedValue({ files });
  vi.spyOn(api, "activity").mockResolvedValue({ queue: [], sources: [] });
  vi.spyOn(api, "fileContent").mockImplementation(async (id, path) => ({ path, content: `# ${id} 首页\n\n[查看概念](wiki/concepts/topic.md)` }));
  vi.spyOn(api, "chats").mockResolvedValue({ chats: [] });
  vi.spyOn(api, "researchTasks").mockResolvedValue({ tasks: [] });
  vi.spyOn(api, "settings").mockResolvedValue({ settings });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("workspace journey and accessibility", () => {
  it("opens the project returned by creation even when a later project-list request would fail", async () => {
    await mount(); await input(host.querySelector<HTMLTextAreaElement>(".editor-grid textarea")!, "# 已确认可丢弃的草稿");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(api.projects).mockRejectedValueOnce(new Error("项目列表暂时不可用"));
    const created = { ...projects[0], id: "created", name: "新知识库" };
    const create = vi.spyOn(api, "createProject").mockResolvedValue({ project: created });
    await click("新建"); await input(host.querySelector<HTMLInputElement>(".sidebar-create-panel input")!, "新知识库"); await click("创建");
    expect(create).toHaveBeenCalledTimes(1);
    expect(host.querySelector<HTMLSelectElement>('[aria-label="当前知识库"]')?.value).toBe("created");
    expect(host.querySelector<HTMLTextAreaElement>(".editor-grid textarea")?.value).toContain("created 首页");
    expect(host.querySelector('[aria-label="当前知识库"]')?.textContent).toContain("新知识库");
  });
  it("keeps the existing document and creation input when creation fails", async () => {
    vi.spyOn(api, "createProject").mockRejectedValue(new Error("创建暂不可用")); vi.spyOn(window, "confirm").mockReturnValue(true);
    await mount(); await input(host.querySelector<HTMLTextAreaElement>(".editor-grid textarea")!, "# 应保留的草稿");
    await click("新建"); await input(host.querySelector<HTMLInputElement>(".sidebar-create-panel input")!, "输入的新知识库"); await click("创建");
    expect(host.querySelector<HTMLTextAreaElement>(".editor-grid textarea")?.value).toBe("# 应保留的草稿");
    expect(host.querySelector<HTMLInputElement>(".sidebar-create-panel input")?.value).toBe("输入的新知识库");
    expect(host.textContent).toContain("创建暂不可用");
  });
  it("does not create or discard document drafts when the project-switch confirmation is declined", async () => {
    const create = vi.spyOn(api, "createProject").mockResolvedValue({ project: projects[1] }); vi.spyOn(window, "confirm").mockReturnValue(false);
    await mount(); await input(host.querySelector<HTMLTextAreaElement>(".editor-grid textarea")!, "# 未保存的文档");
    await click("新建"); await input(host.querySelector<HTMLInputElement>(".sidebar-create-panel input")!, "新项目"); await click("创建");
    expect(create).not.toHaveBeenCalled(); expect(window.confirm).toHaveBeenCalled();
    expect(host.querySelector<HTMLTextAreaElement>(".editor-grid textarea")?.value).toBe("# 未保存的文档");
  });
  it("disables duplicate saves and preserves a document edited while its save is pending", async () => {
    const request = deferred<{ ok: true }>(), save = vi.spyOn(api, "saveFile").mockReturnValue(request.promise);
    await mount(); await input(host.querySelector<HTMLTextAreaElement>(".editor-grid textarea")!, "# 提交保存的内容"); await click("保存");
    expect(button("保存").disabled).toBe(true); await click("保存"); expect(save).toHaveBeenCalledTimes(1);
    await input(host.querySelector<HTMLTextAreaElement>(".editor-grid textarea")!, "# 保存期间的新内容");
    await act(async () => request.resolve({ ok: true })); await flush();
    expect(host.querySelector<HTMLTextAreaElement>(".editor-grid textarea")?.value).toBe("# 保存期间的新内容");
    expect(button("保存").disabled).toBe(false);
  });
  it("supports first-project creation and disables empty or pending duplicate submission", async () => {
    vi.mocked(api.projects).mockResolvedValue({ projects: [] }); const request = deferred<{ project: Project }>();
    const create = vi.spyOn(api, "createProject").mockReturnValue(request.promise);
    await mount(); expect(button("创建知识库").disabled).toBe(true);
    await input(host.querySelector<HTMLInputElement>(".create-panel input")!, "首个知识库"); await click("创建知识库");
    expect(button("创建知识库").disabled).toBe(true); await click("创建知识库"); expect(create).toHaveBeenCalledTimes(1);
    await act(async () => request.resolve({ project: { ...projects[0], id: "first", name: "首个知识库" } })); await flush();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="当前知识库"]')?.value).toBe("first");
  });
  it("keeps usable normal conversations when the research history request fails", async () => {
    vi.mocked(api.chats).mockResolvedValue({ chats: [session] }); vi.mocked(api.researchTasks).mockRejectedValue(new Error("研究历史不可用"));
    await mount(); await click("查询");
    expect(host.querySelector(".chat-session-list")?.textContent).toContain("保留的聊天");
    expect(host.querySelector(".chat-log")?.textContent).toContain("保留的回答");
    expect(host.textContent).toContain("研究历史不可用");
  });
  it("keeps usable research history when the normal conversation request fails", async () => {
    vi.mocked(api.researchTasks).mockResolvedValue({ tasks: [task] }); vi.mocked(api.chats).mockRejectedValue(new Error("聊天历史不可用"));
    await mount(); await click("查询");
    expect(host.querySelector(".chat-session-list")?.textContent).toContain("保留的研究");
    expect(host.querySelector(".chat-log")?.textContent).toContain("研究结果");
    expect(host.textContent).toContain("聊天历史不可用");
  });
  it.each(["response", "error"])("ignores an old conversation-list %s after a newer refresh completed", async (mode) => {
    const old = deferred<Awaited<ReturnType<typeof api.chats>>>();
    const other = { ...session, id: "other", title: "另一条历史" };
    vi.mocked(api.chats).mockReturnValueOnce(old.promise).mockResolvedValue({ chats: [session, other] });
    vi.spyOn(api, "chat").mockResolvedValue({ answer: "保留的回答", hits: [], chat: session });
    await mount(); await click("查询"); await input(host.querySelector<HTMLTextAreaElement>(".ask-composer textarea")!, "新问题"); await click("提问");
    expect(host.querySelector(".chat-session-list")?.textContent).toContain("保留的聊天");
    await act(async () => mode === "response" ? old.resolve({ chats: [] }) : old.reject(new Error("过期列表错误")));
    expect(host.querySelector(".chat-session-list")?.textContent).toContain("另一条历史"); expect(host.textContent).not.toContain("过期列表错误");
  });
  it("does not lose a newly created project to an older project-list refresh", async () => {
    await mount(); const old = deferred<Awaited<ReturnType<typeof api.projects>>>();
    vi.mocked(api.projects).mockReturnValueOnce(old.promise);
    vi.mocked(api.activity).mockRejectedValueOnce(new ApiError(404, "项目已移除"));
    vi.useFakeTimers(); await act(async () => button("查询").click()); await act(async () => vi.advanceTimersByTimeAsync(30000)); vi.useRealTimers();
    expect(api.projects).toHaveBeenCalledTimes(2);
    vi.spyOn(api, "createProject").mockResolvedValue({ project: { ...projects[0], id: "new", name: "新项目" } });
    await click("新建"); await input(host.querySelector<HTMLInputElement>(".sidebar-create-panel input")!, "新项目"); await click("创建");
    await act(async () => old.resolve({ projects })); await flush();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="当前知识库"]')?.value).toBe("new");
  });
  it("keeps the newest graph recalculation when an older response arrives last", async () => {
    const first = deferred<KnowledgeGraph>(), latest = deferred<KnowledgeGraph>();
    vi.spyOn(api, "graph").mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    await mount(); await click("图谱"); await click("重算");
    await act(async () => latest.resolve(graph("最新图谱"))); await act(async () => first.resolve(graph("过期图谱")));
    expect(host.querySelector(".graph-work")?.textContent).toContain("最新图谱"); expect(host.textContent).not.toContain("过期图谱");
  });
  it("ignores an older graph failure after the newer graph succeeds", async () => {
    const first = deferred<KnowledgeGraph>(), latest = deferred<KnowledgeGraph>();
    vi.spyOn(api, "graph").mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    await mount(); await click("图谱"); await click("重算");
    await act(async () => latest.resolve(graph("最新图谱"))); await act(async () => first.reject(new Error("过期图谱错误")));
    expect(host.textContent).not.toContain("过期图谱错误");
  });
  it("releases graph loading after the newest result without waiting for an older stalled request", async () => {
    const old = deferred<KnowledgeGraph>(), latest = deferred<KnowledgeGraph>();
    vi.spyOn(api, "graph").mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    await mount(); await click("图谱"); await click("重算"); await act(async () => latest.resolve(graph("最新图谱")));
    expect(host.querySelector(".workspace-header .spin")).toBeNull();
    await click("Wiki"); expect(button("保存").disabled).toBe(false);
    await act(async () => old.resolve(graph("旧图谱")));
  });
  it("gives the editor, question, clipping and graph inputs accessible names", async () => {
    await mount(); expect(host.querySelector(".editor-grid textarea")?.getAttribute("aria-label")).toBe("Markdown 正文");
    await click("来源");
    expect([...host.querySelectorAll(".clip-form input, .clip-form textarea")].map((node) => node.getAttribute("aria-label"))).toEqual(["剪藏标题", "来源 URL", "剪藏正文"]);
    await click("查询"); expect(host.querySelector(".ask-composer textarea")?.getAttribute("aria-label")).toBe("问题");
    vi.spyOn(api, "graph").mockResolvedValue(graph("图谱")); await click("图谱");
    expect(host.querySelector(".graph-controls input")?.getAttribute("aria-label")).toBe("过滤图谱节点");
  });
  it("moves focus into a compact preview, cycles focus and restores it on Escape", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    await mount(); const trigger = button("查看预览"); trigger.focus(); await click("查看预览");
    const dialog = host.querySelector<HTMLElement>('[role="dialog"][aria-label="文档预览"]');
    expect(dialog).not.toBeNull(); expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.contains(document.activeElement)).toBe(true);
    const close = dialog!.querySelector<HTMLButtonElement>('button[title="关闭预览"]')!, link = dialog!.querySelector<HTMLAnchorElement>("a[href]")!;
    close.focus(); await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
    expect(document.activeElement).toBe(link);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement).toBe(close);
    expect(host.querySelector(".workspace")?.hasAttribute("inert")).toBe(true);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(host.querySelector('.preview-open')).toBeNull(); expect(document.activeElement).toBe(trigger);
    expect(host.querySelector(".workspace")?.hasAttribute("inert")).toBe(false);
  });
  it("keeps the desktop preview as a nonmodal side pane", async () => {
    await mount(); await click("查看预览");
    expect(host.querySelector(".preview-pane")?.getAttribute("role")).not.toBe("dialog");
    expect(host.querySelector(".workspace")?.hasAttribute("inert")).toBe(false);
  });
});
