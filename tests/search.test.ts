import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { answerQuestion, listChats, saveLatestChatAnswer, searchProject } from "../server/lib/search.js";
import { safeJoin, writeSources } from "../server/lib/storage.js";
import { writeWikiFile } from "../server/lib/wiki.js";
import { makeProject } from "./helpers.js";

describe("search and chat", () => {
  it("searches wiki pages and source registry summaries", async () => {
    const project = await makeProject();
    await writeWikiFile(
      project,
      "wiki/concepts/company-charter.md",
      "---\ntitle: 公司章程\ntype: concept\ntags: [concept]\nsources: []\n---\n# 公司章程\n\n公司章程是公司治理的基础文件。"
    );
    await writeSources(project, [
      {
        id: "source-1",
        fileName: "公司法.txt",
        relativePath: "raw/sources/company-law.txt",
        kind: "text",
        size: 10,
        sha256: "sha",
        title: "公司法",
        summary: "公司法规定公司章程必须载明的事项。",
        importedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "ready",
        wikiPath: "wiki/sources/company-law.md"
      }
    ]);

    const hits = await searchProject(project, "公司章程", { includeRaw: true });
    expect(hits.map((hit) => hit.title)).toContain("公司章程");
    expect(hits.map((hit) => hit.title)).toContain("公司法");
  });

  it("creates multi-turn chats and can save the latest answer", async () => {
    const project = await makeProject();
    await writeWikiFile(
      project,
      "wiki/sources/company-law.md",
      "---\ntitle: 中华人民共和国公司法\ntype: source\ntags: [source]\nsources: [raw/sources/company-law.txt]\n---\n# 中华人民共和国公司法\n\n公司章程不得只写一句话，应载明法律要求的必要事项。"
    );

    const first = await answerQuestion(project, { query: "公司章程可以不写吗" });
    expect(first.chat.messages).toHaveLength(2);
    expect(first.answer).toContain("公司章程");

    const second = await answerQuestion(project, {
      query: "那最简单的模板呢",
      chatId: first.chat.id,
      useHistory: true
    });
    expect(second.chat.messages).toHaveLength(4);

    const savedPath = await saveLatestChatAnswer(project, second.chat.id);
    expect(savedPath).toMatch(/^wiki\/queries\/.+\.md$/);
    const saved = await fs.readFile(safeJoin(project.root, savedPath), "utf8");
    expect(saved).toContain("那最简单的模板呢");

    const chats = await listChats(project);
    expect(chats[0].messages).toHaveLength(4);
  });

  it("handles unreadable question text without polluting chat titles", async () => {
    const project = await makeProject();
    const result = await answerQuestion(project, { query: "??????" });
    expect(result.hits).toEqual([]);
    expect(result.answer).toContain("无法识别");
    expect(result.chat.title).toBe("无法识别的问题");
    expect(await fs.readdir(path.join(project.root, "chats"))).toHaveLength(1);
  });

  it("stores text and image chat attachments safely", async () => {
    const project = await makeProject();
    const result = await answerQuestion(project, {
      query: "根据附件总结",
      attachments: [
        {
          id: "a",
          name: "note.txt",
          mimeType: "text/plain",
          size: 12,
          kind: "text",
          text: "公司章程附件内容"
        },
        {
          id: "b",
          name: "tiny.png",
          mimeType: "image/png",
          size: 4,
          kind: "image",
          dataUrl: "data:image/png;base64,iVBORw0KGgo="
        }
      ]
    });
    expect(result.chat.messages[0].attachments?.map((item) => item.name)).toEqual(["note.txt", "tiny.png"]);
  });
});
