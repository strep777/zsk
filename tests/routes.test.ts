import { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { errorHandler, safeUploadFileName, safeUploadToken } from "../server/routes.js";

describe("routes helpers", () => {
  it("sanitizes upload tokens and file names within filesystem byte limits", () => {
    expect(safeUploadToken("abc../中文_123")).toBe("abc_123");
    const longName = `${"上海市人民代表大会常务委员会关于市人民政府机构改革".repeat(8)}.docx`;
    const safeName = safeUploadFileName(longName);
    expect(safeName.endsWith(".docx")).toBe(true);
    expect(Buffer.byteLength(`payload-${safeName}`, "utf8")).toBeLessThanOrEqual(240);
    expect(safeUploadFileName("??.txt")).toBe("source.txt");
    expect(safeUploadFileName("../a/bad:name?.md")).toBe("bad_name_.md");
  });

  it("returns a 499 response for aborted uploads without throwing", () => {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn().mockReturnThis();
    const req = { aborted: true, destroyed: false } as Request;
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
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "REQUEST_ABORTED" }));
    expect(next).not.toHaveBeenCalled();
  });
});
