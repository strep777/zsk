import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { describe, expect, it, vi } from "vitest";
import * as wiki from "../server/lib/wiki.js";
import {
  getActivity,
  importUploadedSource,
  importUploadedSources,
  importWebClip,
  repairProjectActivity,
  recordFailedUploadedSources
} from "../server/lib/ingest.js";
import { readQueue, readSources, safeJoin, writeQueue, writeSources } from "../server/lib/storage.js";
import type { Project, SourceRecord } from "../server/types.js";
import { makeProject, multerFile, writeProjectFile } from "./helpers.js";

describe("bulk ingestion", () => {
  it("continues processing files uploaded while the previous batch is updating navigation", async () => {
    const project = await makeProject();
    let release!: () => void;
    let reached!: () => void;
    const finishing = new Promise<void>((resolve) => { reached = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const original = wiki.updateIndex;
    let first = true;
    const spy = vi.spyOn(wiki, "updateIndex").mockImplementation(async (current) => {
      if (current.id === project.id && first) { first = false; reached(); await blocked; }
      return original(current);
    });
    try {
      const pathOne = await writeProjectFile(project, "first.txt", "第一批公司章程资料");
      await importUploadedSource(project, multerFile(pathOne, "first.txt"));
      await finishing;
      const pathTwo = await writeProjectFile(project, "late.txt", "后续上传公司章程资料");
      const late = await importUploadedSource(project, multerFile(pathTwo, "late.txt"));
      release();
      expect((await waitForReadySource(project, late.id)).status).toBe("ready");
    } finally { release(); spy.mockRestore(); }
  });
  it("keeps concurrent same-name uploads and clips as separate immutable sources", async () => {
    const project = await makeProject();
    const first = await writeProjectFile(project, "first.txt", "第一份正文");
    const second = await writeProjectFile(project, "second.txt", "第二份正文");
    const sources = await Promise.all([
      importUploadedSource(project, multerFile(first, "same.txt")),
      importUploadedSource(project, multerFile(second, "same.txt"))
    ]);
    expect(new Set(sources.map((source) => source.relativePath)).size).toBe(2);
    expect(await fs.readFile(safeJoin(project.root, sources[0].relativePath), "utf8")).toBe("第一份正文");
    expect(await fs.readFile(safeJoin(project.root, sources[1].relativePath), "utf8")).toBe("第二份正文");
    const clips = await Promise.all([
      importWebClip(project, { title: "重复标题", content: "剪藏甲" }),
      importWebClip(project, { title: "重复标题", content: "剪藏乙" })
    ]);
    expect(new Set(clips.map((source) => source.relativePath)).size).toBe(2);
    for (const source of [...sources, ...clips]) await waitForReadySource(project, source.id);
  });
  it("imports a single uploaded file and registers it once", async () => {
    const project = await makeProject();
    const uploadPath = await writeProjectFile(project, "upload.txt", "公司章程材料");
    const source = await importUploadedSource(project, multerFile(uploadPath, "公司章程.txt", 18));
    expect(source.relativePath).toMatch(/^raw\/sources\/公司章程\.txt$/);
    expect((await readSources(project)).map((item) => item.relativePath)).toContain(source.relativePath);
    expect((await readQueue(project)).length).toBeGreaterThanOrEqual(1);
  });
  it("marks a whitespace-only source as failed and creates no source Wiki page", async () => {
    const project = await makeProject();
    const filePath = await writeProjectFile(project, "blank.txt", " \n\t ");
    const source = await importUploadedSource(project, multerFile(filePath, "blank.txt"));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = (await readSources(project)).find((item) => item.id === source.id)!;
      if (current.status === "failed" || current.status === "ready") {
        expect(current.status).toBe("failed");
        expect(current.wikiPath).toBeUndefined();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("queue did not settle");
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
    const activity = await getActivity(project);
    expect(activity.archiveProgress[0]).toMatchObject({
      fileName: "laws.zip",
      status: "done",
      totalEntries: 1,
      processedEntries: 1,
      extractedFiles: 1
    });
    expect(activity.archiveProgress[0].currentEntry).toContain("20200623.txt");
    const source = result.sources[0];
    expect(source.relativePath).toContain("上海市人民代表大会");
    expect(Buffer.byteLength(path.basename(source.relativePath), "utf8")).toBeLessThanOrEqual(180);
  });

  it("keeps decoded archive text readable after queue conversion to markdown", async () => {
    const project = await makeProject();
    const zipPath = path.join(project.root, "encoded-laws.zip");
    const zip = new AdmZip();
    zip.addFile("材料/公司章程.txt", iconv.encode("公司章程与股东出资。", "gb18030"));
    zip.writeZip(zipPath);

    const result = await importUploadedSources(project, [multerFile(zipPath, "encoded-laws.zip")]);
    const ready = await waitForReadySource(project, result.sources[0].id);

    expect(ready.convertedPath).toBeTruthy();
    const converted = await fs.readFile(safeJoin(project.root, ready.convertedPath!), "utf8");
    expect(converted).toContain("公司章程与股东出资");
    expect(converted).not.toContain("鍏");
    expect(converted).not.toContain("锟");
  });

  it("imports distinct GBK ZIP names that collide when decoded as UTF-8", async () => {
    const project = await makeProject();
    const zipPath = path.join(project.root, "legacy-laws.zip");
    const legacyOptions = {
      noSort: true,
      decoder: {
        encode: (name: string) => iconv.encode(name, "gbk"),
        decode: (name: Buffer) => iconv.decode(name, "gbk"),
        efs: false
      }
    };
    const zip = new AdmZip(undefined, legacyOptions);
    const names = ["法律/啊.txt", "法律/吧.txt"];
    expect(iconv.encode(names[0], "gbk").toString("utf8")).toBe(iconv.encode(names[1], "gbk").toString("utf8"));
    zip.addFile(names[0], Buffer.from("第一份法律材料：公司章程。", "utf8"));
    zip.addFile(names[1], Buffer.from("第二份法律材料：合同条款。", "utf8"));
    for (const entry of zip.getEntries()) entry.header.flags &= ~0x0800;
    zip.writeZip(zipPath);

    const result = await importUploadedSources(project, [multerFile(zipPath, "laws.zip")]);
    expect(result.archives[0].extracted).toBe(2);
    expect(result.queued).toBe(2);
    expect(result.sources.map((source) => source.fileName).sort()).toEqual(["啊.txt", "吧.txt"].sort());
    for (const source of result.sources) {
      const ready = await waitForReadySource(project, source.id);
      expect(ready.relativePath).toContain("法律/");
      const converted = await fs.readFile(safeJoin(project.root, ready.convertedPath!), "utf8");
      expect(converted).toContain(source.fileName === "啊.txt" ? "第一份法律材料" : "第二份法律材料");
      expect(converted).not.toContain("\uFFFD");
    }
    expect((await getActivity(project)).archiveProgress[0]).toMatchObject({status: "done", extractedFiles: 2});
  });

  it("preserves UTF-8 ZIP names even when the language encoding flag is absent", async () => {
    const project = await makeProject();
    const zipPath = path.join(project.root, "unflagged.zip");
    const zip = new AdmZip();
    zip.addFile("法律/中华人民共和国法律.txt", Buffer.from("人民代表大会审议法律材料。", "utf8"));
    for (const entry of zip.getEntries()) entry.header.flags &= ~0x0800;
    zip.writeZip(zipPath);

    const result = await importUploadedSources(project, [multerFile(zipPath, "unflagged.zip")]);
    expect(result.sources[0].fileName).toBe("中华人民共和国法律.txt");
    expect(result.sources[0].relativePath).toContain("法律/");
    await waitForReadySource(project, result.sources[0].id);
  });

  it("keeps mixed ZIP encodings and decoded name collisions as separate documents", async () => {
    const project = await makeProject();
    const zipPath = path.join(project.root, "mixed.zip");
    const rawOptions = {
      noSort: true,
      decoder: {
        encode: (name: string) => Buffer.from(name, "latin1"),
        decode: (name: Buffer) => name.toString("latin1"),
        efs: false
      }
    };
    const zip = new AdmZip(undefined, rawOptions);
    const fixtures = [
      { name: "法律/合同.txt", encoding: "gbk", content: "第一份合同：股东出资。" },
      { name: "法律/合同.txt", encoding: "utf8", content: "第二份合同：履行期限。" },
      { name: "法律/𠀀.txt", encoding: "gb18030", content: "扩展字符命名的法律文档。" }
    ];
    for (const fixture of fixtures) {
      zip.addFile(iconv.encode(fixture.name, fixture.encoding).toString("latin1"), Buffer.from(fixture.content, "utf8"));
    }
    zip.getEntries()[1].header.flags |= 0x0800;
    zip.writeZip(zipPath);

    const result = await importUploadedSources(project, [multerFile(zipPath, "mixed.zip")]);
    expect(result.archives[0].extracted).toBe(3);
    expect(result.sources.map((source) => source.fileName).sort()).toEqual(["合同.txt", "合同-2.txt", "𠀀.txt"].sort());
    const contents = [];
    for (const source of result.sources) {
      await waitForReadySource(project, source.id);
      contents.push(await fs.readFile(safeJoin(project.root, source.relativePath), "utf8"));
    }
    expect(contents.sort()).toEqual(fixtures.map((fixture) => fixture.content).sort());
  });

  it("still rejects byte-identical duplicate ZIP entries with a readable error", async () => {
    const project = await makeProject();
    const zipPath = path.join(project.root, "duplicates.zip");
    const zip = new AdmZip();
    zip.addFile("sameA.txt", Buffer.from("first"));
    zip.addFile("sameB.txt", Buffer.from("second"));
    const bytes = zip.toBuffer();
    for (let offset = bytes.indexOf("sameB.txt"); offset !== -1; offset = bytes.indexOf("sameB.txt", offset + 9)) {
      Buffer.from("sameA.txt").copy(bytes, offset);
    }
    await fs.writeFile(zipPath, bytes);
    await expect(importUploadedSources(project, [multerFile(zipPath, "duplicates.zip")])).rejects.toThrow("ZIP 包含完全相同的重复条目");
    expect(await readSources(project)).toEqual([]);
    expect(await readQueue(project)).toEqual([]);
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
    expect(activity.sourceStats.total).toBe(12);
    expect(activity.queueStats.total).toBe(1);
    expect(activity.ingestProgress.total).toBe(1);
    expect(activity.ingestProgress.processed).toBe(0);
    expect(activity.ingestProgress.percent).toBe(0);
    expect(activity.ingestProgress.next?.relativePath).toBe("raw/sources/0.txt");
    expect(activity.sources.length).toBeLessThanOrEqual(3);
    expect(activity.sources.some((source) => source.status === "queued")).toBe(true);
    expect(activity.sources[0].summary).toBeUndefined();
  });

  it("repairs sources that already have generated matching wiki pages", async () => {
    const project = await makeProject();
    const now = new Date().toISOString();
    await writeSources(project, [
      {
        id: "s-ready",
        fileName: "公司章程.txt",
        relativePath: "raw/sources/company.txt",
        kind: "text",
        size: 12,
        sha256: "sha-ready",
        importedAt: now,
        updatedAt: now,
        status: "queued",
        wikiPath: "wiki/sources/company.md"
      }
    ]);
    await writeQueue(project, [
      {
        id: "q-ready",
        sourceId: "s-ready",
        relativePath: "raw/sources/company.txt",
        status: "queued",
        createdAt: now,
        updatedAt: now
      }
    ]);
    await writeProjectFile(
      project,
      "wiki/sources/company.md",
      [
        "---",
        "title: 公司章程",
        "type: source",
        "source_id: s-ready",
        "source_path: raw/sources/company.txt",
        "source_sha256: sha-ready",
        "tags: [source]",
        "---",
        "# 公司章程",
        "",
        "已抽取。"
      ].join("\n")
    );

    await expect(repairProjectActivity(project)).resolves.toEqual({ repaired: 1, reset: 0 });
    expect((await readSources(project))[0].status).toBe("ready");
    expect((await readQueue(project))[0].status).toBe("done");
  });
});

async function waitForReadySource(project: Project, sourceId: string): Promise<SourceRecord> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const source = (await readSources(project)).find((item) => item.id === sourceId);
    if (source?.status === "ready") return source;
    if (source?.status === "failed") throw new Error(source.error || "source failed");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for source ${sourceId}`);
}
