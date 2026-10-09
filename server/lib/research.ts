import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Project, ResearchTask, ResearchTaskStep, SearchHit } from "../types.js";
import { chatCompletion, hasLiveModel, resolveModelSettings } from "./llm.js";
import { serializeMarkdown } from "./markdown.js";
import { searchProject } from "./search.js";
import { slugify } from "./slug.js";
import { nowIso } from "./time.js";
import { listFiles, readJson, readSettings, safeJoin, writeJson, writeText } from "./storage.js";
import { runExternalSearch } from "./webSearch.js";
import { updateIndex } from "./wiki.js";
import { identifierInput, listInput, textInput } from "./validation.js";
import { withResourceLock } from "./locks.js";

export interface ResearchRequest {
  topic: string;
  queries?: string[];
  modelId?: string;
}

export interface ResearchResult {
  path: string;
  markdown: string;
  queries: string[];
}

interface ResearchStepUpdate {
  id: string;
  status: ResearchTaskStep["status"];
  detail?: string;
  progress?: number;
}

interface ResearchRunOptions {
  onStep?: (update: ResearchStepUpdate) => void | Promise<void>;
}

const RESEARCH_TASK_STEPS: ResearchTaskStep[] = [
  { id: "local-search", label: "检索本地知识库", status: "pending" },
  { id: "external-search", label: "检索外部结果", status: "pending" },
  { id: "draft", label: "生成研究笔记", status: "pending" },
  { id: "save", label: "保存到 Wiki", status: "pending" }
];
const weakResearchEvidenceScoreThreshold = 18;
const runningTasks = new Map<string, Promise<ResearchTask>>();

export async function createResearchTask(project: Project, request: ResearchRequest): Promise<ResearchTask> {
  return withResourceLock(`${project.root}:research-create`, () => createResearchTaskLocked(project, request));
}

async function createResearchTaskLocked(project: Project, request: ResearchRequest): Promise<ResearchTask> {
  const topic = textInput(request.topic, "研究主题", { required: true, max: 200, singleLine: true }).trim();
  const queries = normalizedQueries({ ...request, topic });
  const modelId = cleanResearchModelId(request.modelId);
  resolveModelSettings(await readSettings(project), modelId);
  const pending = (await listResearchTasks(project)).filter((task) => task.status === "queued" || task.status === "running");
  const duplicate = pending.find((task) => task.topic === topic && task.modelId === modelId && JSON.stringify(task.queries) === JSON.stringify(queries));
  if (duplicate) return duplicate;
  const configuredMax = Number(process.env.LLM_WIKI_MAX_ACTIVE_RESEARCH_TASKS || 2);
  const maxActive = Number.isSafeInteger(configuredMax) && configuredMax > 0 ? configuredMax : 2;
  if (pending.length >= maxActive) throw Object.assign(new Error(`已有 ${maxActive} 个研究任务正在运行或排队，请等待完成后再提交。`), { status: 409 });
  const timestamp = nowIso();
  const task: ResearchTask = {
    id: `research-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    topic,
    queries,
    modelId,
    status: "queued",
    progress: 0,
    steps: RESEARCH_TASK_STEPS.map((step) => ({ ...step })),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await writeResearchTask(project, task);
  return task;
}

export async function listResearchTasks(project: Project): Promise<ResearchTask[]> {
  const root = researchTaskRoot(project);
  const files = await listFiles(root, { extensions: [".json"] });
  const tasks = await Promise.all(
    files.map((file) => readJson<ResearchTask | null>(path.join(root, file), null))
  );
  return tasks
    .filter((task): task is ResearchTask => Boolean(task))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readResearchTask(project: Project, taskId: string): Promise<ResearchTask> {
  const safeId = safeResearchTaskId(taskId);
  if (!safeId) throw Object.assign(new Error("研究任务不存在。"), { status: 404 });
  const task = await readJson<ResearchTask | null>(researchTaskPath(project, safeId), null);
  if (!task) throw Object.assign(new Error("研究任务不存在。"), { status: 404 });
  return task;
}

export function runResearchTask(project: Project, taskId: string): Promise<ResearchTask> {
  const key = `${project.root}:${taskId}`;
  const active = runningTasks.get(key);
  if (active) return active;
  const running = executeResearchTask(project, taskId).finally(() => runningTasks.delete(key));
  runningTasks.set(key, running);
  return running;
}

export async function deleteResearchTask(project: Project, taskId: string): Promise<boolean> {
  const task = await readResearchTask(project, taskId);
  if (task.status === "running" || task.status === "queued") throw Object.assign(new Error("研究尚未完成，请完成后再删除会话。"), { status: 409 });
  await fs.rm(researchTaskPath(project, safeResearchTaskId(taskId)), { force: true });
  return true;
}

async function executeResearchTask(project: Project, taskId: string): Promise<ResearchTask> {
  let task = await readResearchTask(project, taskId);
  if (task.status === "done") return task;
  task = {
    ...task,
    status: "running",
    progress: Math.max(task.progress, 1),
    updatedAt: nowIso()
  };
  await writeResearchTask(project, task);

  try {
    const result = await runResearch(project, { topic: task.topic, queries: task.queries, modelId: task.modelId }, {
      onStep: async (update) => {
        const current = await readResearchTask(project, task.id);
        const updatedAt = nowIso();
        const next: ResearchTask = {
          ...current,
          status: "running",
          progress: update.progress ?? current.progress,
          updatedAt,
          steps: current.steps.map((step) =>
            step.id === update.id
              ? {
                  ...step,
                  status: update.status,
                  detail: update.detail,
                  updatedAt
                }
              : step
          )
        };
        await writeResearchTask(project, next);
      }
    });
    task = await readResearchTask(project, task.id);
    task = {
      ...task,
      status: "done",
      progress: 100,
      result,
      updatedAt: nowIso(),
      steps: task.steps.map((step) =>
        step.status === "pending" || step.status === "running"
          ? { ...step, status: "done", updatedAt: nowIso() }
          : step
      )
    };
    await writeResearchTask(project, task);
    return task;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    task = await readResearchTask(project, task.id);
    task = {
      ...task,
      status: "failed",
      error: message,
      updatedAt: nowIso(),
      steps: task.steps.map((step) =>
        step.status === "running"
          ? { ...step, status: "failed", detail: message, updatedAt: nowIso() }
          : step
      )
    };
    await writeResearchTask(project, task);
    throw error;
  }
}

export async function runResearch(
  project: Project,
  request: ResearchRequest,
  options: ResearchRunOptions = {}
): Promise<ResearchResult> {
  textInput(request.topic, "研究主题", { required: true, max: 200, singleLine: true });
  const settings = await readSettings(project);
  const modelSettings = resolveModelSettings(settings, request.modelId);
  const queries = normalizedQueries(request);
  const localHits = await collectResearchLocalHits(project, queries, options.onStep);
  await options.onStep?.({
    id: "local-search",
    status: "done",
    detail: `已按 ${queries.length} 个问题检索，本地命中 ${localHits.length} 条去重材料。`,
    progress: 30
  });
  await options.onStep?.({ id: "external-search", status: "running", detail: "正在检索外部结果。", progress: 35 });
  const externalResults = await runExternalSearch(settings, queries);
  await options.onStep?.({
    id: "external-search",
    status: "done",
    detail: `外部检索得到 ${externalResults.length} 条结果。`,
    progress: 55
  });
  const localContext = localHits.length
    ? localHits.map((item, index) => `[本地 ${index + 1}] ${item.title}\n${item.path}\n${item.excerpt}`).join("\n\n")
    : "本地知识库没有检索到明确证据。";
  const externalContext = externalResults.length
    ? externalResults.map((item, index) => `[外部 ${index + 1}] ${item.title}\n${item.url}\n${item.snippet}`).join("\n\n")
    : "未配置可用外部检索服务，或没有外部检索结果。";
  const context = [`本地知识库证据：\n${localContext}`, `外部检索结果：\n${externalContext}`].join("\n\n");
  await options.onStep?.({ id: "draft", status: "running", detail: "正在整理研究结论。", progress: 65 });
  const generated = hasLiveModel(modelSettings)
    ? await chatCompletion(modelSettings, [
        { role: "system", content: modelSettings.systemPrompt },
        {
          role: "user",
          content: [
            "请基于本地知识库证据和外部检索结果生成深度研究笔记。",
            "要求：用中文，先给结论；证据必须标明来自本地还是外部；上下文不足时要说明缺口，不要编造。",
            "结构：结论、关键证据、争议/空白、下一步。",
            `主题：${request.topic}`,
            "",
            context
          ].join("\n")
        }
      ])
    : null;
  const offlineConclusion = buildOfflineResearchConclusion(request.topic, localHits, externalResults);
  await options.onStep?.({
    id: "draft",
    status: "done",
    detail: generated ? "已由模型生成研究笔记。" : "已生成离线研究笔记。",
    progress: 82
  });

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
    generated || offlineConclusion,
    "",
    "## 本地知识库证据",
    "",
    ...(localHits.length
      ? localHits.map((item, index) => `- 本地 ${index + 1}：[[${item.title}]]（${item.path}）- ${item.excerpt}`)
      : ["_本地知识库没有检索到明确证据。_"]),
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
  const pathValue = `wiki/research/${slugify(request.topic)}-${randomUUID()}.md`;
  await options.onStep?.({ id: "save", status: "running", detail: `正在保存到 ${pathValue}。`, progress: 90 });
  const markdown = serializeMarkdown(
    {
      title: request.topic,
      type: "research",
      tags: ["research"],
      sources: uniqueStrings([
        ...localHits.flatMap((item) => [item.path, ...item.citations]),
        ...externalResults.map((item) => item.url)
      ]),
      created: nowIso()
    },
    body
  );
  await writeText(safeJoin(project.root, pathValue), markdown);
  await updateIndex(project);
  await options.onStep?.({ id: "save", status: "done", detail: `已保存到 ${pathValue}。`, progress: 100 });
  return { path: pathValue, markdown, queries };
}

function normalizedQueries(request: ResearchRequest): string[] {
  if (request.queries !== undefined) {
    for (const query of listInput(request.queries, "研究检索问题", 8)) textInput(query, "研究检索问题", { required: true, max: 4000 });
  }
  const provided = request.queries?.map((query) => query.trim()).filter(Boolean);
  return provided?.length ? provided : defaultQueries(request.topic);
}

async function collectResearchLocalHits(
  project: Project,
  queries: string[],
  onStep?: ResearchRunOptions["onStep"]
): Promise<SearchHit[]> {
  const byPath = new Map<string, SearchHit>();
  const total = Math.max(queries.length, 1);
  for (const [index, query] of queries.entries()) {
    await onStep?.({
      id: "local-search",
      status: "running",
      detail: `正在检索本地知识库：${query}`,
      progress: 10 + Math.floor((index / total) * 18)
    });
    const hits = await searchProject(project, query, { includeRaw: true, limit: 8 });
    for (const hit of hits) {
      const key = hit.path || `${hit.title}-${hit.type}`;
      const current = byPath.get(key);
      if (!current) {
        byPath.set(key, { ...hit });
        continue;
      }
      byPath.set(key, {
        ...current,
        score: Math.max(current.score, hit.score),
        excerpt: current.excerpt.length >= hit.excerpt.length ? current.excerpt : hit.excerpt,
        citations: uniqueStrings([...current.citations, ...hit.citations])
      });
    }
  }
  return strongResearchEvidenceHits([...byPath.values()].sort((a, b) => b.score - a.score)).slice(0, 12);
}

function strongResearchEvidenceHits(hits: SearchHit[]): SearchHit[] {
  if (!hits.length) return [];
  const topScore = hits[0].score;
  if (topScore < weakResearchEvidenceScoreThreshold) return [];
  const floor = Math.max(weakResearchEvidenceScoreThreshold, Math.floor(topScore * 0.3));
  return hits.filter((hit) => hit.score >= floor);
}

function researchTaskRoot(project: Project): string {
  return safeJoin(project.root, ".llm-wiki/research-tasks");
}

function researchTaskPath(project: Project, taskId: string): string {
  return path.join(researchTaskRoot(project), `${safeResearchTaskId(taskId)}.json`);
}

function safeResearchTaskId(value: string): string {
  return identifierInput(value, "研究任务 ID");
}

async function writeResearchTask(project: Project, task: ResearchTask): Promise<void> {
  await writeJson(researchTaskPath(project, task.id), task);
}

function defaultQueries(topic: string): string[] {
  return [`${topic} 核心概念`, `${topic} 最新实践`, `${topic} 争议 风险`, `${topic} 案例`];
}

function cleanResearchModelId(value: unknown): string | undefined {
  return value === undefined || value === "" ? undefined : identifierInput(value, "模型 ID");
}

function buildOfflineResearchConclusion(
  topic: string,
  localHits: SearchHit[],
  externalResults: Array<{ title: string; url: string; snippet: string }>
): string {
  const lines = [
    `围绕「${topic}」，当前研究优先依据本地知识库材料。`,
    localHits.length
      ? `本地知识库命中了 ${localHits.length} 条相关材料，可先从「${localHits[0].title}」核对核心事实。`
      : "本地知识库暂未检索到明确证据，需要补充来源或换一个更具体的问题。",
    externalResults.length
      ? `同时抓取到 ${externalResults.length} 条外部结果，可用于交叉验证。`
      : "当前没有外部检索结果；如果需要联网研究，请在设置中配置 Web 检索服务。"
  ];
  return lines.join("\n\n");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
