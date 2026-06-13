import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listFiles,
  readSettings,
  safeJoin,
  writeSettings,
  writeText
} from "../server/lib/storage.js";
import { makeProject } from "./helpers.js";

describe("storage", () => {
  it("initializes a project with readable Chinese defaults", async () => {
    const project = await makeProject("我的 LLM Wiki");
    const index = await fs.readFile(path.join(project.root, "wiki", "index.md"), "utf8");
    const settings = await readSettings(project);
    expect(index).toContain("我的 LLM Wiki");
    expect(index).toContain("知识库总览");
    expect(settings.systemPrompt).toContain("知识库编译器");
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
});
