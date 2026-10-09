import fs from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = await fs.readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
function popup() {
  let click!: () => Promise<void>;
  const elements: Record<string, { value?: string; textContent?: string; disabled?: boolean; addEventListener?: (event: string, handler: typeof click) => void }> = {
    baseUrl: { value: "http://localhost:19827" }, projectId: { value: "p" }, apiToken: { value: "" }, status: { textContent: "" },
    clip: { disabled: false, addEventListener: (_event, handler) => { click = handler; } }
  };
  const chrome = {
    storage: { sync: { get: (_keys: string[], callback: (values: object) => void) => callback({}), set: vi.fn() } },
    tabs: { query: vi.fn(async () => [{ id: 1, url: "https://example.test" }]) },
    scripting: { executeScript: vi.fn(async () => [{ result: { title: "中文页面", content: "中文正文", url: "https://example.test" } }]) }
  };
  const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
  vm.runInNewContext(source, { document: { getElementById: (id: string) => elements[id] }, chrome, fetch: fetchMock, URL, Error });
  return { elements, chrome, fetchMock, click: () => click() };
}
describe("browser clipper", () => {
  it("rejects invalid service addresses before reading or submitting a page", async () => {
    const instance = popup(); instance.elements.baseUrl.value = "javascript:alert(1)";
    await instance.click();
    expect(instance.elements.status.textContent).toContain("有效的 HTTP");
    expect(instance.chrome.tabs.query).not.toHaveBeenCalled();
    expect(instance.chrome.storage.sync.set).not.toHaveBeenCalled();
  });
  it("prevents duplicate clicks and gives a clear notice for restricted tabs", async () => {
    const instance = popup();
    let resolve!: (tabs: Array<{ id: number; url: string }>) => void;
    instance.chrome.tabs.query.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = instance.click(); await instance.click();
    expect(instance.elements.clip.disabled).toBe(true);
    expect(instance.chrome.tabs.query).toHaveBeenCalledTimes(1);
    resolve([{ id: 1, url: "chrome://settings" }]); await pending;
    expect(instance.elements.status.textContent).toContain("内部页面无法剪藏");
    expect(instance.elements.clip.disabled).toBe(false);
    expect(instance.fetchMock).not.toHaveBeenCalled();
  });
});
