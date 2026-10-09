// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import { SettingsView } from "../src/components/SettingsView";
import type { ProjectSettings } from "../src/types";

type Response = Awaited<ReturnType<typeof api.diagnoseSettings>>;
const fixture = (): ProjectSettings => ({
  language: "zh-CN", provider: "offline", model: "", baseUrl: "", systemPrompt: "原系统提示词",
  modelProfiles: [{ id: "local", name: "原名称", provider: "ollama", model: "", baseUrl: "http://localhost:11434", enabled: true }],
  webSearchProvider: "typesense", webSearchUrl: "http://localhost:8108", webSearchApiKey: "fixture-key", webSearchCollection: "web_pages", webSearchQueryBy: "",
  skills: [{ id: "rules", name: "引用规则", prompt: "请引用来源", enabled: true }],
  mcpServers: [{ id: "tools", name: "", transport: "http", url: "http://localhost:8000/mcp", tools: [], resources: [], enabled: true }]
});
let host: HTMLDivElement, root: Root;
function Harness({ initial, onSave }: { initial?: ProjectSettings; onSave?: (settings: ProjectSettings) => void }) {
  const [settings, setSettings] = useState(initial || fixture);
  return <SettingsView projectId="fixture" settings={settings} setSettings={setSettings} onReload={() => setSettings(structuredClone(settings))} onSave={() => onSave?.(settings)} busy={false} />;
}
async function mount(initial?: ProjectSettings, onSave?: (settings: ProjectSettings) => void) { await act(async () => root.render(<Harness initial={initial} onSave={onSave} />)); }
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === text)!;
  expect(button, text).toBeDefined();
  await act(async () => button.click());
}
function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const node = [...host.querySelectorAll("label")].find((item) => item.firstChild?.textContent === label)?.querySelector("input, textarea");
  expect(node, label).toBeDefined();
  return node as HTMLInputElement | HTMLTextAreaElement;
}
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(element: HTMLSelectElement, value: string) {
  expect(element).toBeTruthy();
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}
function deferred() {
  let resolve!: (response: Response) => void;
  vi.spyOn(api, "diagnoseSettings").mockImplementation(() => new Promise<Response>((finish) => { resolve = finish; }));
  return async (response: Response) => { await act(async () => resolve(response)); };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("settings review regressions", () => {
  it("preserves a manually selected model and card edits while discovery is pending", async () => {
    const finish = deferred(); await mount(); await click("获取模型");
    await input(field("名称"), "新名称"); await input(field("模型"), "hand-picked-model");
    await finish({ message: "已获取模型", models: ["discovered-model"] });
    expect(field("名称").value).toBe("新名称"); expect(field("模型").value).toBe("hand-picked-model");
    expect(host.querySelector('datalist option')?.getAttribute("value")).toBe("discovered-model");
  });
  it("fills the sole discovered model without reverting a card disabled during discovery", async () => {
    const finish = deferred(); await mount(); await click("获取模型");
    await input(field("名称"), "新名称");
    await act(async () => host.querySelector<HTMLInputElement>('.model-profile-card input[type="checkbox"]')!.click());
    await finish({ message: "已获取模型", models: ["discovered-model"] });
    expect(field("名称").value).toBe("新名称"); expect(field("模型").value).toBe("discovered-model");
    expect(host.querySelector<HTMLInputElement>('.model-profile-card input[type="checkbox"]')?.checked).toBe(false);
    expect(host.querySelector(".model-profile-card")?.classList.contains("active")).toBe(false);
  });
  it("rejects a skill test response after the system prompt used by that test changes", async () => {
    const finish = deferred(); await mount(); await click("测试效果");
    await input(field("系统提示词"), "新系统提示词");
    await finish({ message: "旧提示词通过", response: "旧提示词回答" });
    expect(host.textContent).not.toContain("旧提示词通过"); expect(host.textContent).not.toContain("旧提示词回答");
  });
  it("preserves manual MCP tools while populating untouched discovered resources", async () => {
    const finish = deferred(); await mount(); await click("获取工具和资源");
    await input(field("工具（每行一个）"), "manual_tool");
    await finish({ message: "已获取能力", name: "服务名称", tools: ["remote_tool"], resources: ["docs://remote"] });
    expect(field("工具（每行一个）").value).toBe("manual_tool");
    expect(field("资源（每行一个）").value).toBe("docs://remote");
  });
  it("invalidates discovered collection choices when connection credentials change", async () => {
    vi.spyOn(api, "diagnoseSettings").mockResolvedValue({ message: "已获取集合", collections: ["web_pages", "restricted_pages"], queryBy: "title,content" });
    await mount(); await click("获取集合和字段");
    expect(host.querySelectorAll('#web-typesense-collections option')).toHaveLength(2);
    await input(field("搜索 API Key"), "other-fixture-key");
    expect(host.querySelectorAll('#web-typesense-collections option')).toHaveLength(0);
  });
  it("does not show discarded pending diagnostics as failed tests when returning to an earlier configuration", async () => {
    const finish = deferred(); await mount(); await click("测试模型");
    await input(field("Base URL"), "http://localhost:11435");
    await finish({ message: "旧配置通过" });
    await input(field("Base URL"), "http://localhost:11434");
    expect(host.textContent).not.toContain("正在测试，请稍候…"); expect(host.querySelector('.settings-diagnostic.error')).toBeNull();
  });
  it("keeps save and reload actions outside the scrolling settings grid", async () => {
    await mount();
    expect(host.querySelector('.settings-actions')?.parentElement).toBe(host.querySelector('.settings-view'));
    expect(host.querySelector('.settings-grid .settings-actions')).toBeNull();
  });
  it("stops the remaining connection tests after leaving settings during the builtin check", async () => {
    let finish!: (response: Response) => void;
    const diagnose = vi.spyOn(api, "diagnoseSettings").mockImplementation((_project, action) => action === "builtin-search"
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve({ message: "完成" }));
    await mount(); await click("测试全部连接");
    expect(diagnose.mock.calls.map((call) => call[1])).toEqual(["model-test", "builtin-search"]);
    await act(async () => root.render(null));
    await act(async () => finish({ message: "检查完成" }));
    expect(diagnose.mock.calls.map((call) => call[1])).toEqual(["model-test", "builtin-search"]);
  });
  it("keeps discovered collections when the user fills search fields while discovery is pending", async () => {
    const finish = deferred(); await mount(); await click("获取集合和字段");
    await input(field("检索字段"), "manual_content");
    await finish({ message: "已获取集合", collections: ["web_pages", "other_pages"], queryBy: "title,content" });
    expect(field("检索字段").value).toBe("manual_content");
    expect(host.querySelectorAll('#web-typesense-collections option')).toHaveLength(2);
    expect(host.textContent).toContain("已获取集合");
  });
  it.each(["获取集合和字段", "测试搜索"])("prevents competing search diagnostics while %s is pending", async (action) => {
    const finish = deferred(); await mount(); await click(action);
    const other = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === (action === "获取集合和字段" ? "测试搜索" : "获取集合和字段"))!;
    expect(other.disabled).toBe(true);
    await act(async () => other.click());
    expect(api.diagnoseSettings).toHaveBeenCalledTimes(1);
    await finish({ message: "成功", collections: ["web_pages"], queryBy: "title,content" });
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].filter((item) => ["获取集合和字段", "测试搜索"].includes(item.textContent?.trim() || "")).every((item) => !item.disabled)).toBe(true);
  });
  it("uses a newly chosen collection for field discovery and subsequent search tests", async () => {
    const diagnose = vi.spyOn(api, "diagnoseSettings")
      .mockResolvedValueOnce({ message: "已获取集合", collections: ["web_pages", "other_pages"], queryBy: "title,content" })
      .mockResolvedValueOnce({ message: "已获取字段", collections: ["web_pages", "other_pages"], queryBy: "title,body" })
      .mockResolvedValueOnce({ message: "搜索测试成功", queryBy: "title,body" });
    await mount(); await click("获取集合和字段");
    await input(field("网页索引集合"), "other_pages");
    expect(field("检索字段").value).toBe("");
    expect(host.querySelectorAll('#web-typesense-collections option')).toHaveLength(2);
    await click("获取集合和字段");
    expect(field("检索字段").value).toBe("title,body");
    expect(diagnose.mock.calls[1]).toEqual(["fixture", "web-search-collections", { settings: expect.objectContaining({ webSearchCollection: "other_pages", webSearchQueryBy: "" }) }]);
    await click("测试搜索");
    expect(diagnose.mock.calls[2]).toEqual(["fixture", "web-search", { settings: expect.objectContaining({ webSearchCollection: "other_pages", webSearchQueryBy: "title,body" }) }]);
    expect(host.textContent).toContain("搜索测试成功");
  });
  it("shows discovery and search failures accurately and allows retry after an empty collection list", async () => {
    const diagnose = vi.spyOn(api, "diagnoseSettings")
      .mockResolvedValueOnce({ message: "服务中尚无集合，请先创建网页索引。", collections: [] })
      .mockRejectedValueOnce(new Error("网页索引集合不存在。"))
      .mockResolvedValueOnce({ message: "搜索测试成功", queryBy: "title,content" });
    await mount(); await click("获取集合和字段");
    expect(host.querySelectorAll('#web-typesense-collections option')).toHaveLength(0);
    expect(host.textContent).toContain("服务中尚无集合");
    await click("测试搜索");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("网页索引集合不存在");
    await input(field("网页索引集合"), "new_pages");
    await click("测试搜索");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(field("检索字段").value).toBe("title,content");
    expect(diagnose).toHaveBeenCalledTimes(3);
  });
  it("shows a visible collection selector and fetches fields immediately when a collection is chosen", async () => {
    const diagnose = vi.spyOn(api, "diagnoseSettings")
      .mockResolvedValueOnce({ message: "请选择集合", collections: ["web_pages", "other_pages"] })
      .mockResolvedValueOnce({ message: "字段已获取", collections: ["web_pages", "other_pages"], queryBy: "title,body" });
    await mount(); await input(field("网页索引集合"), ""); await click("获取集合和字段");
    const selector = host.querySelector<HTMLSelectElement>('select[aria-label="选择网页索引集合"]')!;
    expect(selector).not.toBeNull();
    expect([...selector.options].map((option) => option.value)).toEqual(["", "web_pages", "other_pages"]);
    await select(selector, "other_pages");
    expect(field("网页索引集合").value).toBe("other_pages");
    expect(field("检索字段").value).toBe("title,body");
    expect(diagnose.mock.calls[1]).toEqual(["fixture", "web-search-collections", { settings: expect.objectContaining({ webSearchCollection: "other_pages", webSearchQueryBy: "" }) }]);
    await input(field("网页索引集合"), "manual_alias"); await input(field("检索字段"), "manual_body");
    expect(diagnose).toHaveBeenCalledTimes(2);
    expect(field("网页索引集合").value).toBe("manual_alias");
  });
  it("keeps the chosen collection and allows manual fields when automatic field discovery fails", async () => {
    const diagnose = vi.spyOn(api, "diagnoseSettings")
      .mockResolvedValueOnce({ message: "请选择集合", collections: ["web_pages", "other_pages"] })
      .mockRejectedValueOnce(new Error("字段获取权限不足，请手动填写"))
      .mockResolvedValueOnce({ message: "搜索测试成功" });
    await mount(); await click("获取集合和字段");
    await select(host.querySelector<HTMLSelectElement>('select[aria-label="选择网页索引集合"]')!, "other_pages");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("权限不足");
    expect(field("网页索引集合").value).toBe("other_pages");
    await input(field("检索字段"), "body"); await click("测试搜索");
    expect(diagnose.mock.calls[2][2]).toEqual({ settings: expect.objectContaining({ webSearchCollection: "other_pages", webSearchQueryBy: "body" }) });
  });
  it("lets users type a second Skill tag after a separator", async () => {
    await mount(); const tags = field("标签");
    await input(tags, "first"); await input(tags, `${tags.value},`);
    expect(tags.value).toBe("first,");
    await input(tags, `${tags.value}second`);
    vi.spyOn(api, "diagnoseSettings").mockResolvedValue({ message: "成功" }); await click("测试效果");
    expect(vi.mocked(api.diagnoseSettings).mock.calls[0][2]).toEqual(expect.objectContaining({ settings: expect.objectContaining({ skills: [expect.objectContaining({ tags: ["first", "second"] })] }) }));
  });
  it.each(["工具（每行一个）", "资源（每行一个）"])("lets users type a second MCP item after a newline in %s", async (label) => {
    await mount(); const items = field(label);
    await input(items, "first"); await input(items, `${items.value}\n`);
    expect(items.value).toBe("first\n");
    await input(items, `${items.value}second`);
    vi.spyOn(api, "diagnoseSettings").mockResolvedValue({ message: "成功" });
    await click("测试 MCP 连接");
    expect(vi.mocked(api.diagnoseSettings).mock.calls[0][2]).toEqual({ server: expect.objectContaining({ [label.startsWith("工具") ? "tools" : "resources"]: ["first", "second"] }) });
  });
  it("lets users type a second stdio argument after a newline", async () => {
    await mount();
    await select([...host.querySelectorAll("label")].find((label) => label.firstChild?.textContent === "传输方式")!.querySelector("select")!, "stdio");
    const args = field("参数（每行一个）");
    await input(args, "--first"); await input(args, `${args.value}\n`);
    expect(args.value).toBe("--first\n");
    await input(args, `${args.value}second argument`);
    vi.spyOn(api, "diagnoseSettings").mockResolvedValue({ message: "成功" }); await click("测试 MCP 连接");
    expect(vi.mocked(api.diagnoseSettings).mock.calls[0][2]).toEqual({ server: expect.objectContaining({ args: ["--first", "second argument"] }) });
  });
  it("clears the collection selector without sending an automatic request for an empty collection", async () => {
    const diagnose = vi.spyOn(api, "diagnoseSettings").mockResolvedValue({ message: "已获取集合", collections: ["web_pages"], queryBy: "title,content" });
    await mount(); await click("获取集合和字段");
    await select(host.querySelector<HTMLSelectElement>('select[aria-label="选择网页索引集合"]')!, "");
    expect(field("网页索引集合").value).toBe(""); expect(field("检索字段").value).toBe("");
    expect(diagnose).toHaveBeenCalledTimes(1);
  });
  it("rejects empty or corrupted Skill instructions and clears the error after correction", async () => {
    await mount(); await input(field("Skill 指令"), ""); await click("验证指令");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("请填写 Skill 指令");
    await input(field("Skill 指令"), "损坏\uFFFD指令"); await click("验证指令");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("无法识别字符");
    await input(field("Skill 指令"), "引用知识库来源"); await click("验证指令");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain("指令格式有效");
  });
  it("submits the latest normalized arrays without requiring a blur", async () => {
    const save = vi.fn(); await mount(undefined, save);
    await input(field("标签"), "first, second,");
    await input(field("工具（每行一个）"), "search\nfetch\n");
    await click("保存设置");
    expect(save.mock.calls[0][0]).toMatchObject({ skills: [expect.objectContaining({ tags: ["first", "second"] })], mcpServers: [expect.objectContaining({ tools: ["search", "fetch"] })] });
  });
  it("clears raw list drafts when reloaded settings replace the current object", async () => {
    await mount(); await input(field("标签"), "first,"); await input(field("工具（每行一个）"), "search\n");
    await click("重载");
    expect(field("标签").value).toBe("first");
    expect(field("工具（每行一个）").value).toBe("search");
  });
  it.each([
    ["modelProfiles", 24, "添加模型", "删除模型"],
    ["skills", 24, "添加 Skill", "删除 Skill"],
    ["mcpServers", 16, "添加 MCP", "删除 MCP 服务器"]
  ] as const)("enforces the %s card limit and reopens addition after deletion", async (key, limit, add, remove) => {
    const initial = fixture();
    if (key === "modelProfiles") initial.modelProfiles = Array.from({ length: limit }, (_, index) => ({ ...initial.modelProfiles[0], id: `model-${index}` }));
    if (key === "skills") initial.skills = Array.from({ length: limit }, (_, index) => ({ ...initial.skills[0], id: `skill-${index}` }));
    if (key === "mcpServers") initial.mcpServers = Array.from({ length: limit }, (_, index) => ({ ...initial.mcpServers[0], id: `mcp-${index}` }));
    await mount(initial);
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === add)!;
    expect(button.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>(`button[title="${remove}"]`)!.click());
    expect(button.disabled).toBe(false);
    await click(add); expect(button.disabled).toBe(true);
  });
});
