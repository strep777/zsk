// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { api } from "../src/api";
import type { Project, ProjectSettings } from "../src/types";

const projects: Project[] = ["a", "b"].map((id) => ({ id, name: `知识库 ${id}`, description: "", createdAt: "", updatedAt: "", root: "" }));
const fixture = (systemPrompt = "原提示词", name = "原模型"): ProjectSettings => ({
  language: "zh-CN", provider: "ollama", model: "fixture", baseUrl: "http://localhost:11434", systemPrompt,
  webSearchProvider: "none", skills: [], mcpServers: [], activeModelId: "local",
  modelProfiles: [{ id: "local", name, provider: "ollama", model: "fixture", baseUrl: "http://localhost:11434", enabled: true }]
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail; });
  return { promise, resolve, reject };
}
type SettingsResponse = Awaited<ReturnType<typeof api.settings>>;
let host: HTMLDivElement, root: Root;
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click()); await flush();
}
function prompt() { return [...host.querySelectorAll("label")].find((node) => node.firstChild?.textContent === "系统提示词")!.querySelector("textarea")!; }
async function editPrompt(value: string) {
  await act(async () => {
    const field = prompt(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mount() { await act(async () => root.render(<App />)); await flush(); await click("设置"); }
async function switchProject() {
  await act(async () => {
    const select = host.querySelector<HTMLSelectElement>('[aria-label="当前知识库"]')!;
    select.value = "b"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush(); await click("设置");
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); HTMLElement.prototype.scrollTo = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(api, "projects").mockResolvedValue({ projects });
  vi.spyOn(api, "wikiFiles").mockResolvedValue({ files: [] });
  vi.spyOn(api, "activity").mockResolvedValue({ queue: [], sources: [] });
  vi.spyOn(api, "fileContent").mockImplementation(async (id, path) => ({ path, content: `# ${id}` }));
  vi.spyOn(api, "chats").mockResolvedValue({ chats: [] });
  vi.spyOn(api, "researchTasks").mockResolvedValue({ tasks: [] });
  vi.spyOn(api, "settings").mockImplementation(async (id) => ({ settings: fixture(id === "a" ? "原提示词" : "项目B提示词", id === "a" ? "原模型" : "项目B模型") }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("app settings request regressions", () => {
  it("preserves edits made after a reload started", async () => {
    await mount(); const request = deferred<SettingsResponse>();
    vi.mocked(api.settings).mockReturnValueOnce(request.promise);
    await click("重载"); await editPrompt("重载期间的新草稿");
    await act(async () => request.resolve({ settings: fixture("重载响应中的旧提示词", "旧响应模型") }));
    expect(prompt().value).toBe("重载期间的新草稿");
    await click("查询"); expect(host.querySelector(".model-select-action select")?.textContent).toContain("原模型");
  });
  it("uses the newest reload when responses arrive out of order", async () => {
    await mount(); const first = deferred<SettingsResponse>(), second = deferred<SettingsResponse>();
    vi.mocked(api.settings).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await click("重载"); await click("重载");
    await act(async () => second.resolve({ settings: fixture("最新提示词", "最新模型") }));
    await act(async () => first.resolve({ settings: fixture("旧响应提示词", "旧响应模型") }));
    expect(prompt().value).toBe("最新提示词");
    await click("查询"); expect(host.querySelector(".model-select-action select")?.textContent).toContain("最新模型");
  });
  it("ignores an older reload failure after a newer reload succeeded", async () => {
    await mount(); const first = deferred<SettingsResponse>(), second = deferred<SettingsResponse>();
    vi.mocked(api.settings).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await click("重载"); await click("重载");
    await act(async () => second.resolve({ settings: fixture("最新提示词") }));
    await act(async () => first.reject(new Error("旧请求失败")));
    expect(prompt().value).toBe("最新提示词"); expect(host.textContent).not.toContain("旧请求失败");
  });
  it("does not let an older reload undo a completed save", async () => {
    await mount(); const request = deferred<SettingsResponse>();
    vi.mocked(api.settings).mockReturnValueOnce(request.promise);
    vi.spyOn(api, "saveSettings").mockImplementation(async (_id, settings) => ({ settings: { ...settings, systemPrompt: "保存后的提示词" } as ProjectSettings }));
    await click("重载"); await editPrompt("待保存提示词"); await click("保存设置");
    expect(prompt().value).toBe("保存后的提示词");
    await act(async () => request.resolve({ settings: fixture("旧重载提示词") }));
    expect(prompt().value).toBe("保存后的提示词");
  });
  it("preserves edits made while saving and acknowledges the saved configuration separately", async () => {
    await mount(); const request = deferred<Awaited<ReturnType<typeof api.saveSettings>>>();
    const save = vi.spyOn(api, "saveSettings").mockReturnValueOnce(request.promise);
    await editPrompt("提交保存的提示词"); await click("保存设置"); await editPrompt("保存期间的新草稿");
    await act(async () => request.resolve({ settings: fixture("提交保存的提示词", "服务器保存模型") }));
    expect(save.mock.calls[0][0]).toBe("a"); expect(save.mock.calls[0][1].systemPrompt).toBe("提交保存的提示词");
    expect(prompt().value).toBe("保存期间的新草稿");
    await click("查询"); expect(host.querySelector(".model-select-action select")?.textContent).toContain("服务器保存模型");
  });
  it("discards a reload response from the project that was left", async () => {
    await mount(); const request = deferred<SettingsResponse>(); vi.mocked(api.settings).mockReturnValueOnce(request.promise);
    await click("重载"); await switchProject();
    await act(async () => request.resolve({ settings: fixture("项目A迟到提示词", "项目A迟到模型") }));
    expect(prompt().value).toBe("项目B提示词");
    await click("查询"); expect(host.querySelector(".model-select-action select")?.textContent).toContain("项目B模型");
  });
  it("discards a save response from the project that was left", async () => {
    await mount(); const request = deferred<Awaited<ReturnType<typeof api.saveSettings>>>();
    vi.spyOn(api, "saveSettings").mockReturnValueOnce(request.promise);
    await editPrompt("项目A保存草稿"); await click("保存设置"); await switchProject();
    await act(async () => request.resolve({ settings: fixture("项目A保存响应", "项目A保存模型") }));
    expect(prompt().value).toBe("项目B提示词"); expect(host.textContent).not.toContain("设置已保存。");
  });
});
