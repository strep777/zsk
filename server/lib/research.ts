import { Project } from "../types.js";
import { chatCompletion, hasLiveModel } from "./llm.js";
import { serializeMarkdown } from "./markdown.js";
import { slugify } from "./slug.js";
import { nowIso } from "./time.js";
import { readSettings, safeJoin, writeText } from "./storage.js";
import { updateIndex } from "./wiki.js";

export interface ResearchRequest {
  topic: string;
  queries?: string[];
}

export interface ResearchResult {
  path: string;
  markdown: string;
  queries: string[];
}

export async function runResearch(project: Project, request: ResearchRequest): Promise<ResearchResult> {
  const settings = await readSettings(project);
  const queries = request.queries?.filter(Boolean).length ? request.queries!.filter(Boolean) : defaultQueries(request.topic);
  const externalResults = await runExternalSearch(settings, queries);
  const context = externalResults.length
    ? externalResults.map((item, index) => `[${index + 1}] ${item.title}\n${item.url}\n${item.snippet}`).join("\n\n")
    : "未配置可用外部检索服务。";
  const generated = hasLiveModel(settings)
    ? await chatCompletion(settings, [
        { role: "system", content: settings.systemPrompt },
        {
          role: "user",
          content: [
            "请基于检索结果生成深度研究笔记。",
            "结构：结论、证据、争议/空白、下一步。",
            `主题：${request.topic}`,
            "",
            context
          ].join("\n")
        }
      ])
    : null;

  const body = [
    `# ${request.topic}`,
    "",
    `创建时间：${nowIso()}`,
    "",
    "## 检索问题",
    "",
    ...queries.map((query) => `- ${query}`),
    "",
    "## 初步结论",
    "",
    generated || "当前处于离线模式，已创建研究任务骨架。配置模型和 Web 检索服务后可生成综合结论。",
    "",
    "## 外部结果",
    "",
    ...(externalResults.length
      ? externalResults.map((item) => `- [${item.title}](${item.url}) - ${item.snippet}`)
      : ["_没有外部检索结果。_"]),
    "",
    "## 下一步",
    "",
    "- 把可信网页、论文或文档作为来源上传。",
    "- 运行摄入后查看图谱中的跨主题连接。",
    "- 将稳定结论整理到 `wiki/synthesis/`。"
  ].join("\n");
  const pathValue = `wiki/research/${slugify(request.topic)}-${Date.now().toString(36)}.md`;
  const markdown = serializeMarkdown(
    {
      title: request.topic,
      type: "research",
      tags: ["research"],
      sources: externalResults.map((item) => item.url),
      created: nowIso()
    },
    body
  );
  await writeText(safeJoin(project.root, pathValue), markdown);
  await updateIndex(project);
  return { path: pathValue, markdown, queries };
}

function defaultQueries(topic: string): string[] {
  return [`${topic} 核心概念`, `${topic} 最新实践`, `${topic} 争议 风险`, `${topic} 案例`];
}

async function runExternalSearch(
  settings: Awaited<ReturnType<typeof readSettings>>,
  queries: string[]
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  if (settings.webSearchProvider === "none") return [];
  if (settings.webSearchProvider === "searxng" && settings.webSearchUrl) {
    const base = settings.webSearchUrl.replace(/\/$/, "");
    const results = [];
    for (const query of queries.slice(0, 4)) {
      const response = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`);
      if (!response.ok) continue;
      const json = (await response.json()) as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
      };
      results.push(
        ...(json.results ?? []).slice(0, 3).map((item) => ({
          title: item.title || query,
          url: item.url || "",
          snippet: item.content || ""
        }))
      );
    }
    return results.filter((item) => item.url);
  }
  return [];
}
