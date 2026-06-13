import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import {
  getActivity,
  importUploadedSource,
  importUploadedSources,
  recordFailedUploadedSources
} from "../server/lib/ingest.js";
import { readQueue, readSources, writeQueue, writeSources } from "../server/lib/storage.js";
import { makeProject, multerFile, writeProjectFile } from "./helpers.js";

describe("bulk ingestion", () => {
  it("imports a single uploaded file and registers it once", async () => {
    const project = await makeProject();
    const uploadPath = await writeProjectFile(project, "upload.txt", "公司章程材料");
    const source = await importUploadedSource(project, multerFile(uploadPath, "公司章程.txt", 18));
    expect(source.relativePath).toMatch(/^raw\/sources\/公司章程\.txt$/);
    expect((await readSources(project)).map((item) => item.relativePath)).toContain(source.relativePath);
    expect((await readQueue(project)).length).toBeGreaterThanOrEqual(1);
  });

  it("extracts ZIP files with #U unicode names and shortens long path segments", async () => {
    const project = await makeProject();
    const zipPath = path.join(project.root, "laws.zip");
    const zip = new AdmZip();
    const longEscapedName = `${"#U4e0a#U6d77#U5e02#U4eba#U6c11#U4ee3#U8868#U5927#U4f1a".repeat(8)}_20200623.txt`;
    zip.addFile(longEscapedName, Buffer.from("上海市人民代表大会材料", "utf8"));
    zip.writeZip(zipPath);

    const result = await importUploadedSources(project, [multerFile(zipPath, "laws.zip")]);
    expect(result.archives[0].extracted).toBe(1);
    expect(result.queued).toBe(1);
    const source = result.sources[0];
    expect(source.relativePath).toContain("上海市人民代表大会");
    expect(Buffer.byteLength(path.basename(source.relativePath), "utf8")).toBeLessThanOrEqual(180);
  });

  it("rejects unsafe ZIP paths and records failed uploads", async () => {
    const project = await makeProject();
    const zipPath = path.join(project.root, "unsafe.zip");
    const zip = new AdmZip();
    zip.addFile("#U002e#U002e/evil.txt", Buffer.from("evil", "utf8"));
    zip.writeZip(zipPath);

    await expect(importUploadedSources(project, [multerFile(zipPath, "unsafe.zip")])).rejects.toThrow(/unsafe path/i);
    await recordFailedUploadedSources(project, [multerFile(zipPath, "??.txt", 10)], new Error("bad upload"));
    const failed = (await readSources(project)).find((source) => source.status === "failed");
    expect(failed?.fileName).toBe("source.txt");
    expect(failed?.error).toContain("bad upload");
  });

  it("keeps activity snapshots compact and includes active queue items", async () => {
    const project = await makeProject();
    const now = new Date().toISOString();
    await writeSources(
      project,
      Array.from({ length: 12 }, (_, index) => ({
        id: `s-${index}`,
        fileName: `${index}.txt`,
        relativePath: `raw/sources/${index}.txt`,
        kind: "text",
        size: index,
        sha256: `sha-${index}`,
        summary: "x".repeat(1000),
        importedAt: now,
        updatedAt: now,
        status: index === 0 ? "queued" : "ready"
      }))
    );
    await writeQueue(project, [
      {
        id: "q-0",
        sourceId: "s-0",
        relativePath: "raw/sources/0.txt",
        status: "queued",
        createdAt: now,
        updatedAt: now
      }
    ]);
    const activity = await getActivity(project, { sourceLimit: 3, queueLimit: 1, compact: true });
    expect(activity.sourceTotal).toBe(12);
    expect(activity.sources.length).toBeLessThanOrEqual(3);
    expect(activity.sources.some((source) => source.status === "queued")).toBe(true);
    expect(activity.sources[0].summary).toBeUndefined();
  });
});
