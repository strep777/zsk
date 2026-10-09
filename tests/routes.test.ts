import fs from "node:fs/promises";
import path from "node:path";
import { Request, Response } from "express";
import iconv from "iconv-lite";
import { describe, expect, it, vi } from "vitest";
import {
  authMiddleware,
  normalizePublicFilePath,
  canDisplayRawSourceAsText,
  errorHandler,
  assertReadableProjectFile,
  readRawSourceForDisplay,
  safeUploadFileName,
  safeUploadToken,
  deleteProjectSource,
  sourceMatchesQuery
} from "../server/routes.js";
import { writeSources } from "../server/lib/storage.js";
import { readWikiFile, upsertConceptPages } from "../server/lib/wiki.js";
import type { SourceRecord } from "../server/types.js";
import { makeProject, writeProjectFile } from "./helpers.js";

describe("routes helpers", () => {
  it("removes deleted evidence from generated topic notes while preserving other sources and user text", async () => {
    const project = await makeProject();
    await writeProjectFile(project, "raw/sources/one.txt", "原文甲");
    await writeProjectFile(project, "raw/sources/two.txt", "原文乙");
    await writeProjectFile(project, "wiki/sources/one.md", "# 材料甲");
    await writeProjectFile(project, "wiki/sources/two.md", "# 材料乙");
    const [topic] = await upsertConceptPages(project, ["共同概念"], "wiki/sources/one.md", "材料甲", "应被移除的事实甲");
    await upsertConceptPages(project, ["共同概念"], "wiki/sources/two.md", "材料乙", "应保留的事实乙");
    await fs.appendFile(path.join(project.root, topic), "\n## 用户补充\n\n手写资料保留。\n");
    await writeSources(project, ["one", "two"].map((id) => ({ id, fileName: `${id}.txt`, relativePath: `raw/sources/${id}.txt`, wikiPath: `wiki/sources/${id}.md`, kind: "text", size: 9, sha256: id, importedAt: "", updatedAt: "", status: "ready" })));
    await deleteProjectSource(project, "one");
    const content = await readWikiFile(project, topic);
    expect(content).not.toContain("应被移除的事实甲");
    expect(content).not.toContain("wiki/sources/one.md");
    expect(content).toContain("应保留的事实乙");
    expect(content).toContain("手写资料保留");
  });
  it("preserves validation errors after a request body has completed", () => {
    const status = vi.fn().mockReturnThis(); const json = vi.fn();
    const req = { aborted: false, destroyed: true, complete: true } as Request;
    const res = { headersSent: false, status, json } as unknown as Response;
    errorHandler(Object.assign(new Error("问题不能为空。"), { status: 400 }), req, res, vi.fn());
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: "问题不能为空。" });
  });
  it("prevents raw previews and assets from accessing project metadata", () => {
    expect(() => normalizePublicFilePath("raw/sources/../../.llm-wiki/settings.json")).toThrow("允许访问");
    expect(() => normalizePublicFilePath("raw/assets/../../.llm-wiki/settings.json")).toThrow("允许访问");
    expect(normalizePublicFilePath("wiki/concepts/../index.md")).toBe("wiki/index.md");
  });
  it("sets an httpOnly login cookie and authenticates later asset requests", () => {
    const original = process.env.LLM_WIKI_API_TOKEN;
    process.env.LLM_WIKI_API_TOKEN = "test-token";
    try {
      const cookie = vi.fn(); const status = vi.fn().mockReturnThis(); const json = vi.fn(); const next = vi.fn();
      const res = { cookie, status, json } as unknown as Response;
      authMiddleware({ path: "/session", method: "POST", secure: false, header: (name: string) => name === "x-api-token" ? "test-token" : undefined } as Request, res, next);
      expect(cookie.mock.calls[0]?.[2]).toMatchObject({ httpOnly: true, sameSite: "strict" });
      const token = cookie.mock.calls[0]?.[1];
      authMiddleware({ path: "/projects/p/assets", header: (name: string) => name === "cookie" ? `llm_wiki_auth=${token}` : undefined } as Request, res, next);
      expect(next).toHaveBeenCalledTimes(2);
      authMiddleware({ path: "/projects", header: () => `llm_wiki_auth=${"中".repeat(64)}` } as unknown as Request, res, next);
      expect(status).toHaveBeenCalledWith(401);
    } finally { if (original === undefined) delete process.env.LLM_WIKI_API_TOKEN; else process.env.LLM_WIKI_API_TOKEN = original; }
  });
  it("sanitizes upload tokens and file names within filesystem byte limits", () => {
    expect(safeUploadToken("abc../中文_123")).toBe("abc_123");
    const longName = `${"上海市人民代表大会常务委员会关于市人民政府机构改革".repeat(8)}.docx`;
    const safeName = safeUploadFileName(longName);
    expect(safeName.endsWith(".docx")).toBe(true);
    expect(Buffer.byteLength(`payload-${safeName}`, "utf8")).toBeLessThanOrEqual(240);
    expect(safeUploadFileName("??.txt")).toBe("source.txt");
    expect(safeUploadFileName("../a/bad:name?.md")).toBe("bad_name_.md");
  });

  it("matches file manager status aliases in Chinese", () => {
    const now = new Date().toISOString();
    const source: SourceRecord = {
      id: "source-queued",
      fileName: "合同.docx",
      relativePath: "raw/sources/合同.docx",
      kind: "word",
      size: 10,
      sha256: "sha",
      importedAt: now,
      updatedAt: now,
      status: "queued"
    };

    expect(sourceMatchesQuery(source, "排队摄入")).toBe(true);
    expect(sourceMatchesQuery({ ...source, status: "ready" }, "可用文件")).toBe(true);
    expect(sourceMatchesQuery({ ...source, status: "failed" }, "需要处理")).toBe(true);
  });

  it("returns a 499 response for aborted uploads without throwing", () => {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn().mockReturnThis();
    const req = {
      aborted: true,
      destroyed: false,
      originalUrl: "/api/v1/projects/demo/sources/upload-chunk",
      path: "/projects/demo/sources/upload-chunk"
    } as Request;
    const res = {
      headersSent: false,
      destroyed: false,
      writable: true,
      status,
      json
    } as unknown as Response;
    const next = vi.fn();

    errorHandler(new Error("request aborted"), req, res, next);
    expect(status).toHaveBeenCalledWith(499);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      code: "REQUEST_ABORTED",
      error: expect.stringContaining("上传连接已中断")
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it("does not describe aborted chat requests as upload failures", () => {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn().mockReturnThis();
    const req = {
      aborted: true,
      destroyed: false,
      originalUrl: "/api/v1/projects/demo/chat",
      path: "/projects/demo/chat"
    } as Request;
    const res = {
      headersSent: false,
      destroyed: false,
      writable: true,
      status,
      json
    } as unknown as Response;
    const next = vi.fn();

    errorHandler(new Error("request aborted"), req, res, next);
    expect(status).toHaveBeenCalledWith(499);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      code: "REQUEST_ABORTED",
      error: "请求连接已中断，请重新发送。"
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it("returns a readable notice instead of binary raw source content", async () => {
    const project = await makeProject("原文预览测试");
    const timestamp = new Date().toISOString();
    await writeProjectFile(project, "raw/sources/report.docx", "fake binary payload");
    await writeSources(project, [
      {
        id: "source-1",
        fileName: "合同.docx",
        relativePath: "raw/sources/report.docx",
        kind: "word",
        size: 19,
        sha256: "hash",
        importedAt: timestamp,
        updatedAt: timestamp,
        status: "ready",
        wikiPath: "wiki/sources/report.md",
        convertedPath: "wiki/sources/converted/report.md"
      }
    ]);

    expect(canDisplayRawSourceAsText("raw/sources/report.docx")).toBe(false);
    expect(canDisplayRawSourceAsText("raw/sources/report.md")).toBe(true);

    const content = await readRawSourceForDisplay(project, "raw/sources/report.docx");
    expect(content).toContain("不能按纯文本直接打开");
    expect(content).toContain("wiki/sources/converted/report.md");
    expect(content).toContain("wiki/sources/report.md");
  });

  it("decodes raw text previews with Chinese legacy encodings", async () => {
    const project = await makeProject("GBK 原文预览");
    const timestamp = new Date().toISOString();
    const relativePath = "raw/sources/gbk.txt";
    const filePath = path.join(project.root, "raw", "sources", "gbk.txt");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, iconv.encode("公司章程与股东出资。", "gb18030"));
    await writeSources(project, [
      {
        id: "source-gbk",
        fileName: "gbk.txt",
        relativePath,
        kind: "text",
        size: 20,
        sha256: "hash",
        importedAt: timestamp,
        updatedAt: timestamp,
        status: "ready"
      }
    ]);

    const content = await readRawSourceForDisplay(project, relativePath);
    expect(content).toContain("公司章程");
    expect(content).not.toContain("锟斤拷");
    expect(content).not.toContain(String.fromCharCode(0xfffd));
  });

  it("reports a clear 404 when a referenced file no longer exists", async () => {
    const project = await makeProject("缺失文件提示");
    await expect(assertReadableProjectFile(project, "wiki/missing.md")).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("文件不存在或已被移除")
    });
  });
});
