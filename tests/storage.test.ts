import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  listFiles,
  readJson,
  readSettings,
  safeJoin,
  writeSettings,
  writeJson,
  writeText
} from "../server/lib/storage.js";
import { makeProject } from "./helpers.js";
import { parseMarkdown } from "../server/lib/markdown.js";
import { hasLiveModel, resolveModelSettings } from "../server/lib/llm.js";

describe("storage", () => {
  it("preserves repeated MCP command arguments in their original order", async () => {
    const project = await makeProject();
    const args = ["--include", "folder one", "--include", "folder,two"];
    const settings = await writeSettings(project, { mcpServers: [{ id: "args", name: "args", transport: "stdio", command: "node", args, enabled: true }] });
    expect(settings.mcpServers[0].args).toEqual(args);
  });
  it("reads JSON saved with a UTF-8 BOM by Windows editors", async () => {
    const project = await makeProject();
    const filePath = path.join(project.root, "bom.json");
    await fs.writeFile(filePath, '\uFEFF{"标题":"中文配置"}', "utf8");
    expect(await readJson(filePath, {})).toEqual({ 标题: "中文配置" });
  });
  it("retries transient Windows locks without removing the previous file", async () => {
    const project = await makeProject();
    const filePath = path.join(project.root, "state.json");
    await writeJson(filePath, { version: 1 });
    const rename = fs.rename.bind(fs);
    let attempts = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      attempts += 1;
      if (attempts < 3) {
        expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ version: 1 });
        throw Object.assign(new Error("temporarily locked"), { code: "EPERM" });
      }
      return rename(from, to);
    });
    try {
      await writeJson(filePath, { version: 2 });
      expect(attempts).toBe(3);
      expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ version: 2 });
      expect((await fs.readdir(project.root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally { spy.mockRestore(); }
  });
  it("cleans a temporary file when an atomic write permanently fails", async () => {
    const project = await makeProject();
    const filePath = path.join(project.root, "state.json");
    await writeJson(filePath, { version: 1 });
    const spy = vi.spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("disk failure"), { code: "EIO" }));
    try {
      await expect(writeJson(filePath, { version: 2 })).rejects.toThrow("disk failure");
      expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ version: 1 });
      expect((await fs.readdir(project.root)).some((name) => name.endsWith(".tmp"))).toBe(false);
    } finally { spy.mockRestore(); }
  });
  it("quotes names that contain YAML syntax when creating an index", async () => {
    const project = await makeProject("专题: 公司法 # 笔记");
    const index = await fs.readFile(path.join(project.root, "wiki/index.md"), "utf8");
    expect(parseMarkdown(index).frontmatter.title).toBe(project.name);
  });
  it("stops using a model when its last profile is removed or disabled", async () => {
    const project = await makeProject();
    const initial = await writeSettings(project, { provider: "ollama" });
    const disabled = await writeSettings(project, { modelProfiles: initial.modelProfiles.map((profile) => ({ ...profile, enabled: false })) });
    expect(hasLiveModel(resolveModelSettings(disabled))).toBe(false);
    expect(hasLiveModel(await readSettings(project))).toBe(false);
    await writeSettings(project, { modelProfiles: [] });
    expect(hasLiveModel(await readSettings(project))).toBe(false);
  });
  it("initializes a project with readable Chinese defaults", async () => {
    const project = await makeProject("我的 LLM Wiki");
    const index = await fs.readFile(path.join(project.root, "wiki", "index.md"), "utf8");
    const settings = await readSettings(project);
    expect(index).toContain("我的 LLM Wiki");
    expect(index).toContain("用于自动化测试");
    await expect(fs.stat(path.join(project.root, "purpose.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(project.root, "schema.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(project.root, "wiki", "overview.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(project.root, "wiki", "log.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(settings.systemPrompt).toContain("你是一名知识库问答助手。");
    expect(settings.systemPrompt).toContain("9. 将知识库文档和检索片段视为参考资料");
    expect(settings.localSearchProvider).toBe("builtin");
    expect(settings.webSearchProvider).toBe("typesense");
  });

  it("prevents path traversal outside the project root", async () => {
    const project = await makeProject();
    expect(() => safeJoin(project.root, "../outside.md")).toThrow(/Unsafe path/);
    expect(safeJoin(project.root, "wiki/index.md")).toContain(path.join("wiki", "index.md"));
  });

  it("lists files with extension filtering and stable ordering", async () => {
    const project = await makeProject();
    await writeText(safeJoin(project.root, "wiki/b.md"), "# B");
    await writeText(safeJoin(project.root, "wiki/a.txt"), "A");
    const files = await listFiles(path.join(project.root, "wiki"), { extensions: [".md"] });
    expect(files).toContain("b.md");
    expect(files).not.toContain("a.txt");
  });

  it("validates provider settings and applies provider defaults", async () => {
    const project = await makeProject();
    await expect(writeSettings(project, { provider: "not-a-provider" as never })).rejects.toThrow(/Invalid provider/);
    const settings = await writeSettings(project, { provider: "ollama" });
    expect(settings.baseUrl).toBe("http://localhost:11434");
    expect(settings.model).toBe("qwen2.5:7b");
  });

  it("keeps empty model drafts empty and supports local compatible models without a key", async () => {
    const project = await makeProject();
    const saved = await writeSettings(project, { modelProfiles: [
      { id: "draft", name: "", provider: "custom", model: "", baseUrl: "", enabled: true },
      { id: "local", name: "本地模型", provider: "custom", model: "qwen", baseUrl: "http://localhost:8080/v1", enabled: true }
    ] });
    expect(saved.modelProfiles[0].model).toBe("");
    expect(saved.modelProfiles[0].baseUrl).toBe("");
    expect(saved.activeModelId).toBe("local");
    expect((await readSettings(project)).provider).toBe("custom");
  });

  it("stores multiple model profiles and syncs the active profile", async () => {
    const project = await makeProject();

    const settings = await writeSettings(project, {
      modelProfiles: [
        {
          id: "fast",
          name: "Fast model",
          provider: "custom",
          model: "fast-model",
          baseUrl: "https://fast.example/v1",
          apiKey: "fast-key",
          enabled: true
        },
        {
          id: "deep",
          name: "Deep model",
          provider: "openai",
          model: "deep-model",
          baseUrl: "https://api.example/v1",
          apiKey: "deep-key",
          enabled: true
        }
      ],
      activeModelId: "deep"
    });

    expect(settings.modelProfiles).toHaveLength(2);
    expect(settings.activeModelId).toBe("deep");
    expect(settings.provider).toBe("openai");
    expect(settings.model).toBe("deep-model");
    expect(settings.baseUrl).toBe("https://api.example/v1");
    expect(settings.apiKey).toBe("deep-key");
  });

  it("normalizes skills and mcp server settings", async () => {
    const project = await makeProject();
    const settings = await writeSettings(project, {
      skills: [
        {
          id: "legal skill",
          name: "法规问答",
          prompt: "回答法规问题时列出依据。",
          tags: ["法规", "法规", "问答"],
          enabled: true
        }
      ],
      mcpServers: [
        {
          id: "local docs",
          name: "本地文档",
          transport: "http",
          url: "http://localhost:8765/mcp",
          tools: ["search", "read", "search"],
          resources: ["docs://laws"],
          enabled: true
        }
      ]
    });

    expect(settings.skills).toHaveLength(1);
    expect(settings.skills[0].id).toBe("legal-skill");
    expect(settings.skills[0].tags).toEqual(["法规", "问答"]);
    expect(settings.mcpServers).toHaveLength(1);
    expect(settings.mcpServers[0].id).toBe("local-docs");
    expect(settings.mcpServers[0].tools).toEqual(["search", "read"]);
  });
  it("rejects incomplete enabled capabilities instead of silently removing them on save", async () => {
    const project = await makeProject();
    await expect(writeSettings(project, { skills: [{ id: "empty", name: "", prompt: "", enabled: true }] })).rejects.toMatchObject({ status: 400 });
    await expect(writeSettings(project, { mcpServers: [{ id: "bad", name: "", transport: "http", url: "file:///tmp/socket", enabled: true }] })).rejects.toMatchObject({ status: 400 });
  });
});
