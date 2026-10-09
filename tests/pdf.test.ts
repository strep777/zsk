import { describe, expect, it, vi } from "vitest";
import { makeProject, writeProjectFile } from "./helpers.js";

const fixture = vi.hoisted(() => ({ text: "", fail: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: async () => {
    if (fixture.fail) throw Object.assign(new Error("missing converter"), { code: "ENOENT" });
    return { stdout: fixture.text, stderr: "" };
  } });
  return { ...original, execFile };
});
import { extractDocument } from "../server/lib/extract.js";

describe("PDF conversion correctness", () => {
  it("preserves actual page numbers when blank PDF pages occur", async () => {
    fixture.fail = false; fixture.text = "第一页正文\f\f第三页正文\f";
    const project = await makeProject();
    const filePath = await writeProjectFile(project, "raw/sources/document.pdf", "%PDF-1.4");
    const document = await extractDocument(filePath);
    expect(document.markdown).toContain("## Page 1");
    expect(document.markdown).toContain("## Page 3");
    expect(document.markdown).not.toContain("## Page 2");
  });
  it("identifies unavailable PDF conversion as metadata only", async () => {
    fixture.fail = true;
    const project = await makeProject();
    const filePath = await writeProjectFile(project, "raw/sources/missing.pdf", "%PDF-1.4");
    expect((await extractDocument(filePath)).metadataOnly).toBe(true);
  });
});
