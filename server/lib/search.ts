import fs from "node:fs/promises";
import { invokeMcpQueryTool } from "./mcpClient.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ChatAttachment, ChatSession, McpServerConfig, Project, ProjectSettings, SearchHit, SourceRecord } from "../types.js";
import { chatCompletionWithDiagnostics, hasLiveModel, LlmContentPart, LlmMessage, resolveModelSettings } from "./llm.js";
import { escapeMarkdownText, extractTitle, markdownPlainText, parseMarkdown } from "./markdown.js";
import {
  UNKNOWN_GLYPH_PLACEHOLDER,
  cleanUnknownGlyphRuns,
  isUnknownGlyphText,
  isLowInformationTopicLabel,
  readableTextOrFallback,
  excerptAround,
  tokenize
} from "./text.js";
import { idFrom, slugify } from "./slug.js";
import { nowIso } from "./time.js";
import { listFiles, readJson, readSettings, readSources, readText, safeJoin, writeJson } from "./storage.js";
import { runExternalSearch } from "./webSearch.js";
import type { ExternalSearchResult } from "./webSearch.js";
import { saveQueryAnswer } from "./wiki.js";
import { identifierInput, invalidInput, listInput, objectInput, textInput } from "./validation.js";
import { hasConfiguredWebSearch } from "./providerSettings.js";

const RAW_SEARCH_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".html",
  ".htm",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml",
  ".log"
]);
const maxRawSearchBytes = readPositiveInteger("LLM_WIKI_MAX_RAW_SEARCH_BYTES", 4 * 1024 * 1024);
const maxChatAttachments = readPositiveInteger("LLM_WIKI_MAX_CHAT_ATTACHMENTS", 6);
const maxChatAttachmentTextBytes = readPositiveInteger("LLM_WIKI_MAX_CHAT_ATTACHMENT_TEXT_BYTES", 24000);
const maxChatAttachmentDataUrlBytes = readPositiveInteger("LLM_WIKI_MAX_CHAT_ATTACHMENT_DATA_URL_BYTES", 6 * 1024 * 1024);
const weakLocalEvidenceScoreThreshold = readPositiveInteger("LLM_WIKI_WEAK_LOCAL_EVIDENCE_SCORE", 18);
const mcpToolTimeoutMs = readPositiveInteger("LLM_WIKI_MCP_TOOL_TIMEOUT_MS", 3500);
const maxMcpToolCalls = readPositiveInteger("LLM_WIKI_MAX_MCP_TOOL_CALLS", 4);
const QUERY_STOP_WORDS = new Set([
  "什么",
  "哪些",
  "如何",
  "怎么",
  "怎样",
  "为何",
  "为什么",
  "是否",
  "需要",
  "应该",
  "可以",
  "有关",
  "关于",
  "注意事项",
  "事项",
  "注意",
  "要求",
  "规定",
  "办法",
  "条例",
  "问题",
  "内容",
  "知识库"
]);
const QUERY_SPLIT_WORDS = /什么|哪些|如何|怎么|怎样|为何|为什么|是否|需要|应该|可以|有关|关于|事项|问题|内容|知识库|[的吗呢吧了和与或及在是有要]/g;
const NON_EVIDENCE_WIKI_PREFIXES = ["wiki/queries/", "wiki/research/"];
const NON_EVIDENCE_WIKI_FILES = new Set(["wiki/index.md", "wiki/log.md", "wiki/overview.md"]);
const UNREADABLE_EVIDENCE_RE = /(?:原文包含无法识别字符|问题内容包含无法识别字符|字符无法识别|无法识别的问题)/u;
const chatLocks = new Map<string, Promise<void>>();
const activeChatTurns = new Map<string, { count: number; usesHistory: boolean }>();

export async function searchProject(
  project: Project,
  query: string,
  options: { limit?: number; includeRaw?: boolean } = {}
): Promise<SearchHit[]> {
  const limit = options.limit ?? 12;
  const tokens = searchTokens(query);
  const wikiHits = await scoreFiles(project, "wiki", tokens, query, limit);
  const rawHits = options.includeRaw ? await scoreSourceRegistry(project, tokens, query) : [];
  return dedupeSearchHits([...wikiHits, ...rawHits])
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

interface QuestionInput {
    query: string;
    chatId?: string;
    save?: boolean;
    attachments?: unknown;
    useHistory?: boolean;
    webSearch?: boolean;
    modelId?: string;
}
type QuestionResult = { answer: string; hits: SearchHit[]; chat: ChatSession; savedPath?: string };

export async function answerQuestion(project: Project, input: QuestionInput): Promise<QuestionResult> {
  if (!input.chatId) return executeQuestion(project, input);
  const key = chatFilePath(project, input.chatId);
  const usesHistory = input.useHistory !== false;
  const active = activeChatTurns.get(key);
  if (active && (usesHistory || active.usesHistory)) throw Object.assign(new Error("当前会话正在回答，请等待完成后再发送下一条问题。"), { status: 409 });
  const turn = active || { count: 0, usesHistory };
  turn.count += 1;
  activeChatTurns.set(key, turn);
  try { return await executeQuestion(project, input); }
  finally { turn.count -= 1; if (!turn.count) activeChatTurns.delete(key); }
}

async function executeQuestion(project: Project, input: QuestionInput): Promise<QuestionResult> {
  if (!input.query.trim()) throw Object.assign(new Error("问题不能为空。"), { status: 400 });
  const query = readableTextOrFallback(input.query, "无法识别的问题");
  const queryIsUnreadable = isUnknownGlyphText(input.query);
  const useHistory = input.useHistory !== false;
  const existingChat = input.chatId ? await readChat(project, input.chatId) : null;
  if (input.chatId && !existingChat) throw Object.assign(new Error("会话不存在或已被删除，请新建会话后重试。"), { status: 404 });
  const historyMessages = useHistory && existingChat ? recentConversation(existingChat) : [];
  const retrievalQuery = useHistory ? `${historyMessages.filter((message) => message.role === "user").map((message) => message.content).join(" ")} ${query}`.trim() : query;
  const attachments = normalizeChatAttachments(input.attachments);
  const settings = await readSettings(project);
  const modelSettings = resolveModelSettings(settings, input.modelId);
  const contextQuery = historyMessages.filter((message) => message.role === "user").at(-1)?.content;
  const evidenceQuery = contextQuery && (
    /^(?:那|那么|它|其|这(?:个|些|种)|上(?:述|面)|继续|再|详细|展开|补充)/u.test(query) ||
    /^(?:解释|说明|呢)[。？！!?]*$/u.test(query)
  )
    ? contextQuery
    : query;
  // Rank local evidence for this turn before limiting candidates: old topics can
  // otherwise fill every slot and hide a relevant page for the current question.
  const rawLocalHits = queryIsUnreadable ? [] : await searchProject(project, evidenceQuery, { includeRaw: true, limit: 12 });
  const localHits = strongLocalEvidenceHits(rawLocalHits, evidenceQuery).slice(0, 8);
  const forceWebSearch = input.webSearch === true && hasConfiguredWebSearch(settings);
  const webSearchAttempted = !queryIsUnreadable && (forceWebSearch || hasConfiguredWebSearch(settings));
  const webHits = webSearchAttempted
    ? await webSearchHits(settings, retrievalQuery || query)
    : [];
  const hits = mergeEvidenceHits(localHits, webHits);
  const evidenceScope = evidenceScopeLabel(localHits, webHits);
  const context = formatEvidenceContext(localHits, webHits);
  const attachmentContext = attachmentsToTextContext(attachments);
  const capabilityContext = buildAssistantCapabilityContext(settings);
  const mcpToolContext = queryIsUnreadable ? emptyMcpToolContext() : await callMcpTools(settings, query);
  const hasProvidedEvidence =
    hits.length > 0 ||
    mcpToolContext.hasResult ||
    [...attachments, ...historyMessages.flatMap((message) => message.attachments || [])].some((attachment) => Boolean(attachment.text || attachment.dataUrl));
  const modeInstruction = answerModeInstruction(localHits, webHits, webSearchAttempted, hasProvidedEvidence);
  const userPrompt = [
    modeInstruction,
    "硬性要求：用中文；知识库命中时优先依据知识库；联网搜索结果只能作为补充或在知识库无相关内容时作为外部依据；不要把文件路径、来源编号或材料标题当成事实本身。",
    !localHits.length ? "如果当前知识库没有相关内容，必须先明确说明“知识库没有相关内容”。" : "",
    webHits.length ? "如果使用联网搜索结果，必须清楚标注这些内容来自联网搜索，不要说成知识库原有结论。" : "",
    "回答结构建议：先给结论，再列依据；不要把文件路径、来源编号或材料标题当成事实本身。",
    useHistory ? "用户开启了连续对话，请结合下方历史消息理解代词、省略和追问。" : "用户关闭了连续对话，请只回答本轮问题。",
    capabilityContext ? "本轮对话已载入下方 Skill 和 MCP 能力目录；Skill 是回答规则，MCP 是可用能力说明。只有“扩展能力调用结果”里的内容才是真实工具返回。" : "",
    "",
    `问题：${query}`,
    attachmentContext ? `\n用户附件：\n${attachmentContext}` : "",
    capabilityContext ? `\n扩展能力：\n${capabilityContext}` : "",
    mcpToolContext.text ? `\n扩展能力调用结果：\n${mcpToolContext.text}` : "",
    "",
    `${evidenceScope}：\n${context}`
  ].join("\n");
  const completion = !queryIsUnreadable && hasLiveModel(modelSettings)
    ? await chatCompletionWithDiagnostics(modelSettings, [
        {
          role: "system",
          content: [
            settings.systemPrompt,
            systemAnswerModeInstruction(localHits, webHits, hasProvidedEvidence),
            capabilityContext
          ].filter(Boolean).join("\n\n")
        },
        ...historyMessages.map(historyModelMessage),
        { role: "user", content: buildUserContent(userPrompt, attachments) }
      ])
    : { content: null };

  const answer =
    (queryIsUnreadable
      ? "问题内容包含无法识别字符。请重新输入中文问题，或重新上传没有编码损坏的原文件。"
      : null) ||
    (completion.content ? [completion.content, ...(completion.truncated ? [`模型回答未完成：${completion.error || "输出已中断，请重试。"}`] : [])].join("\n\n") : null) ||
    [
      offlineFallbackIntro(localHits, webHits, webSearchAttempted, hasLiveModel(modelSettings)),
      ...(completion.error ? [`模型回答失败：${completion.error}`] : []),
      ...offlineHitLines(localHits, webHits, query),
      ...offlineAttachmentLines(attachments),
      ...offlineCapabilityLines(settings, mcpToolContext.text),
    ].join("\n");

  const citations = uniqueStrings(hits.flatMap((hit) => (hit.citations.length ? hit.citations : [hit.path])));
  const chat = await appendChat(project, input.chatId, query, answer, citations, attachments);
  const savedPath = input.save ? await saveQueryAnswer(project, query, answer, citations) : undefined;
  return { answer, hits, chat, savedPath };
}

export function buildAssistantCapabilityContext(settings: ProjectSettings): string {
  const skillLines = settings.skills
    .filter((skill) => skill.enabled && skill.prompt.trim())
    .slice(0, 12)
    .map((skill, index) => {
      const tags = skill.tags?.length ? ` 标签：${skill.tags.join("、")}` : "";
      const description = skill.description ? `\n说明：${skill.description}` : "";
      return `Skill ${index + 1}：${skill.name}${tags}${description}\n指令：${skill.prompt}`;
    });
  const mcpLines = settings.mcpServers
    .filter((server) => server.enabled)
    .slice(0, 12)
    .map((server, index) => {
      const location = server.transport === "stdio"
        ? `${server.command || ""}${server.args?.length ? ` ${server.args.join(" ")}` : ""}`.trim()
        : server.url || "";
      const tools = server.tools?.length ? `\n工具：${server.tools.join("、")}` : "";
      const resources = server.resources?.length ? `\n资源：${server.resources.join("、")}` : "";
      const description = server.description ? `\n说明：${server.description}` : "";
      return `MCP ${index + 1}：${server.name}（${server.transport}${location ? `：${location}` : ""}）${description}${tools}${resources}`;
    });
  return [
    skillLines.length ? ["已启用 Skill：", ...skillLines].join("\n") : "",
    mcpLines.length ? ["已登记 MCP 能力目录：", ...mcpLines].join("\n") : ""
  ].filter(Boolean).join("\n\n");
}

interface McpToolContext {
  text: string;
  hasResult: boolean;
}

function emptyMcpToolContext(): McpToolContext {
  return { text: "", hasResult: false };
}

async function callMcpTools(settings: ProjectSettings, query: string): Promise<McpToolContext> {
  const calls = settings.mcpServers
    .filter((server) => server.enabled && (server.transport === "stdio" ? server.command : server.url))
    .flatMap((server) => (server.tools || []).slice(0, maxMcpToolCalls).map((tool) => ({ server, tool })))
    .slice(0, maxMcpToolCalls);
  if (!calls.length) return emptyMcpToolContext();

  const results = await Promise.all(
    calls.map(async ({ server, tool }) => {
      try {
        const text = await callMcpTool(server, tool, query);
        return { text: text ? `- MCP：${server.name} / ${tool}\n${text}` : "", ok: Boolean(text) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[mcp] tool call failed: ${server.name}/${tool}`, error);
        return { text: `- MCP：${server.name} / ${tool}\n调用失败：${message}`, ok: false };
      }
    })
  );
  return {
    text: results.map((result) => result.text).join("\n\n"),
    hasResult: results.some((result) => result.ok)
  };
}

async function callMcpTool(server: McpServerConfig, tool: string, query: string): Promise<string> {
  const result = await invokeMcpQueryTool(server, tool, query, mcpToolTimeoutMs);
  return result ? truncateUtf8(extractMcpResponseText(result), 5000) : "";
}

function extractMcpResponseText(payload: unknown): string {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (record.error) {
    throw new Error(formatUnknownValue(record.error).slice(0, 300));
  }
  const result = (record.result ?? payload) as unknown;
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const resultRecord = result as Record<string, unknown>;
    const content = resultRecord.content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => {
          if (typeof item === "string") return item;
          if (!item || typeof item !== "object") return "";
          const itemRecord = item as Record<string, unknown>;
          if (typeof itemRecord.text === "string") return itemRecord.text;
          return formatUnknownValue(itemRecord);
        })
        .filter(Boolean)
        .join("\n");
      if (text.trim()) return text;
    }
    if (resultRecord.structuredContent) return formatUnknownValue(resultRecord.structuredContent);
  }
  return formatUnknownValue(result);
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function listChats(project: Project): Promise<ChatSession[]> {
  const chatRoot = safeJoin(project.root, "chats");
  const files = await listFiles(chatRoot, { extensions: [".json"] });
  const chats = await Promise.all(files.map((file) => readJson<ChatSession | null>(path.join(chatRoot, file), null)));
  return chats.filter((chat): chat is ChatSession => Boolean(chat)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteChat(project: Project, chatId: string): Promise<boolean> {
  const filePath = chatFilePath(project, chatId);
  return withChatLock(filePath, async () => {
  try {
    await fs.rm(filePath);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: string }).code
      : undefined;
    if (code === "ENOENT") return false;
    throw error;
  }
  });
}

async function readChat(project: Project, chatId: string): Promise<ChatSession | null> {
  const filePath = chatFilePath(project, chatId);
  return readJson<ChatSession | null>(filePath, null);
}

export async function saveLatestChatAnswer(project: Project, chatId: string): Promise<string> {
  const filePath = chatFilePath(project, chatId);
  const chat = await readJson<ChatSession | null>(filePath, null);
  if (!chat) throw Object.assign(new Error(`Chat not found: ${chatId}`), { status: 404 });

  for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
    const assistant = chat.messages[index];
    if (assistant.role !== "assistant") continue;
    const user = [...chat.messages.slice(0, index)].reverse().find((message) => message.role === "user");
    if (!user) break;
    return saveQueryAnswer(project, user.content, assistant.content, assistant.citations || []);
  }

  throw Object.assign(new Error("No assistant answer to save."), { status: 400 });
}

async function appendChat(
  project: Project,
  chatId: string | undefined,
  query: string,
  answer: string,
  citations: string[],
  attachments: ChatAttachment[] = []
): Promise<ChatSession> {
  const safeQuery = readableTextOrFallback(query, "无法识别的问题");
  const id = chatId || `chat-${randomUUID()}`;
  const filePath = chatFilePath(project, id);
  return withChatLock(filePath, async () => {
  const timestamp = nowIso();
  const existing = await readJson<ChatSession | null>(filePath, null);
  if (chatId && !existing) throw Object.assign(new Error("会话已被删除，本轮回答未写入。请新建会话后重试。"), { status: 404 });
  const chat: ChatSession = existing ?? {
    id,
    title: safeQuery.slice(0, 80),
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: []
  };
  chat.updatedAt = timestamp;
  chat.messages.push({
    role: "user",
    content: safeQuery,
    createdAt: timestamp,
    ...(attachments.length ? { attachments: compactStoredAttachments(attachments) } : {})
  });
  chat.messages.push({ role: "assistant", content: answer, citations, createdAt: timestamp });
  await writeJson(filePath, chat);
  return chat;
  });
}

async function withChatLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = chatLocks.get(filePath) || Promise.resolve();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => pending);
  chatLocks.set(filePath, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (chatLocks.get(filePath) === tail) chatLocks.delete(filePath);
  }
}

function chatFilePath(project: Project, chatId: string): string {
  identifierInput(chatId, "会话 ID");
  if (slugify(chatId) !== chatId) invalidInput("会话 ID 格式不正确，请使用列表返回的完整 ID。");
  return safeJoin(project.root, `chats/${chatId}.json`);
}

function recentConversation(chat: ChatSession): Array<ChatSession["messages"][number] & { role: "user" | "assistant" }> {
  return chat.messages
    .filter((message): message is ChatSession["messages"][number] & { role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant"
    )
    .slice(-8)
    .map((message) => ({ ...message, content: Array.from(cleanUnknownGlyphRuns(message.content)).slice(0, 2200).join("") }));
}

function historyModelMessage(message: ChatSession["messages"][number] & { role: "user" | "assistant" }): LlmMessage {
  const text = Array.from(cleanUnknownGlyphRuns(message.content)).slice(0, 2200).join("");
  if (message.role === "assistant") return { role: "assistant", content: text };
  const attachments = message.attachments || [];
  const context = attachmentsToTextContext(attachments);
  return { role: "user", content: buildUserContent(context ? `${text}\n\n用户附件：\n${context}` : text, attachments) };
}

async function scoreFiles(
  project: Project,
  relativeRoot: string,
  tokens: string[],
  query: string,
  maxHits: number
): Promise<SearchHit[]> {
  const root = safeJoin(project.root, relativeRoot);
  const files = (await listFiles(root, { extensions: relativeRoot === "wiki" ? [".md"] : undefined }))
    .filter((file) => isSearchableFile(relativeRoot, file) && !(relativeRoot === "wiki" && isNonEvidenceWikiPath(`${relativeRoot}/${file}`)));
  const hits: SearchHit[] = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const itemPath = `${relativeRoot}/${file}`.replace(/\\/g, "/");
      if (relativeRoot === "wiki" && isNonEvidenceWikiPath(itemPath)) continue;
      const fullPath = path.join(root, file);
      if (relativeRoot === "raw/sources" && !(await isSmallEnoughForRawSearch(fullPath))) continue;
      const content = await readText(fullPath);
      const parsed = parseMarkdown(content);
      const searchable = `${extractTitle(content, file)} ${parsed.body || content}`.toLowerCase();
      const title = extractTitle(content, path.basename(file, path.extname(file)));
      if (isLowQualityEvidence(title, parsed.body || content)) continue;
      const normalizedQuery = query.trim().toLowerCase();
      const score = scoreSearchableText(searchable, title, tokens, normalizedQuery);
      if (score > 0) {
        const excerptText = markdownPlainText(parsed.body || content);
        hits.push({
          path: itemPath,
          title,
          type: typeof parsed.frontmatter.type === "string" ? parsed.frontmatter.type : relativeRoot,
          score,
          excerpt: excerptAround(excerptText, excerptNeedle(query, tokens, excerptText.toLowerCase())),
          citations: [itemPath]
        });
        hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, "zh-CN"));
        if (hits.length > maxHits) hits.length = maxHits;
      }
    }
  };
  // Bound simultaneous reads, rather than silently excluding later documents.
  await Promise.all(Array.from({ length: Math.min(16, files.length) }, worker));
  return hits;
}

async function scoreSourceRegistry(project: Project, tokens: string[], query: string): Promise<SearchHit[]> {
  const sources = await readSources(project);
  const hits: SearchHit[] = [];
  const normalizedQuery = query.trim().toLowerCase();

  for (const source of sources) {
    if (source.status !== "ready") continue;
    if (isLowQualitySource(source)) continue;
    const title = source.title || source.fileName;
    const summary = source.summary || "";
    const searchable = `${title} ${source.fileName} ${source.relativePath} ${summary}`.toLowerCase();
    let score = scoreSearchableText(searchable, title, tokens, normalizedQuery);
    if (score <= 0) continue;
    if (source.wikiPath || source.convertedPath) score += 2;

    const itemPath = source.wikiPath || source.convertedPath || source.relativePath;
    hits.push({
      path: itemPath,
      title,
      type: source.kind,
      score,
      excerpt: sourceExcerpt(source, query, tokens),
      citations: [itemPath]
    });
  }

  return hits;
}

async function webSearchHits(
  settings: ProjectSettings,
  query: string
): Promise<SearchHit[]> {
  try {
    const results = await runExternalSearch(settings, [query], {
      limitPerQuery: 5
    });
    return results.map((result, index) => externalResultToHit(result, index));
  } catch (error) {
    console.warn("[search] web search failed", error);
    return [];
  }
}

function externalResultToHit(result: ExternalSearchResult, index: number): SearchHit {
  return {
    path: result.url,
    title: result.title,
    type: "web",
    score: 100 - index,
    excerpt: result.snippet || result.url,
    citations: [result.url]
  };
}

function strongLocalEvidenceHits(hits: SearchHit[], query = ""): SearchHit[] {
  if (!hits.length) return [];
  const anchors = currentQueryAnchors(query);
  const candidates = anchors.length ? hits.filter((hit) => hitContainsAnchor(hit, anchors)) : hits;
  if (!candidates.length) return [];
  const topScore = candidates[0].score;
  if (topScore < weakLocalEvidenceScoreThreshold) return [];
  const scoreFloor = Math.max(weakLocalEvidenceScoreThreshold, Math.floor(topScore * 0.3));
  return candidates.filter((hit) => hit.score >= scoreFloor);
}

function currentQueryAnchors(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const tokens = uniqueStrings([
    normalized.length >= 2 && normalized.length <= 24 && !isMostlyGenericFollowup(normalized) ? normalized : "",
    ...searchTokens(query)
  ])
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2 && !QUERY_STOP_WORDS.has(token))
    .filter((token) => /[\p{Script=Han}A-Za-z0-9]/u.test(token))
    .sort((a, b) => b.length - a.length)
    .slice(0, 10);
  if (!tokens.length) return [];
  const meaningful = tokens.filter((token) => !isWeakQuestionAnchor(token));
  return meaningful.length ? meaningful : [];
}

function isWeakQuestionAnchor(token: string): boolean {
  return (
    QUERY_STOP_WORDS.has(token) ||
    /^(这个|那个|这些|那些|上述|上面|前面|情况|问题|材料|内容|回答|继续|解释|说明|怎么|如何)$/.test(token)
  );
}

function isMostlyGenericFollowup(query: string): boolean {
  return /^(这个|那个|这些|那些|上述|上面|前面|这种|这样|那样|它|其|继续|再说|详细|展开|补充|怎么办|怎么做|如何处理|可以吗|呢|吗|吧|一下|一下子)+$/u.test(query);
}

function hitContainsAnchor(hit: SearchHit, anchors: string[]): boolean {
  const haystack = `${hit.title}\n${hit.excerpt}\n${hit.path}`.toLowerCase();
  return anchors.some((anchor) => haystack.includes(anchor));
}

function mergeEvidenceHits(localHits: SearchHit[], webHits: SearchHit[]): SearchHit[] {
  const byPath = new Map(dedupeSearchHits([...localHits, ...webHits]).map((hit) => [hit.path, hit]));
  const seen = new Set<string>();
  const ordered: SearchHit[] = [];
  for (const hit of [...localHits, ...webHits]) {
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    ordered.push(byPath.get(hit.path) || hit);
  }
  return ordered.slice(0, 12);
}

function evidenceScopeLabel(localHits: SearchHit[], webHits: SearchHit[]): string {
  if (localHits.length && webHits.length) return "当前知识库和联网搜索结果";
  if (localHits.length) return "当前知识库";
  if (webHits.length) return "联网搜索结果";
  return "普通回答上下文";
}

function formatEvidenceContext(localHits: SearchHit[], webHits: SearchHit[]): string {
  const sections = [
    localHits.length
      ? `当前知识库：\n${formatHitsForPrompt(localHits, 1)}`
      : "当前知识库：没有检索到相关内容。",
    webHits.length
      ? `联网搜索结果：\n${formatHitsForPrompt(webHits, localHits.length + 1)}`
      : "联网搜索结果：没有获取到可用结果，可能未联网或未配置外部搜索服务。"
  ];
  return sections.join("\n\n");
}

function formatHitsForPrompt(hits: SearchHit[], startIndex: number): string {
  return hits
    .map((hit, index) => `[${startIndex + index}] ${hit.title} (${hit.path})\n${hit.excerpt}`)
    .join("\n\n");
}

function answerModeInstruction(
  localHits: SearchHit[],
  webHits: SearchHit[],
  webSearchAttempted: boolean,
  hasProvidedEvidence: boolean
): string {
  if (localHits.length && webHits.length) {
    return "请结合当前知识库和联网搜索结果回答问题；知识库是主要依据，联网搜索用于补充、核对或说明最新信息。";
  }
  if (localHits.length) {
    return "请基于当前知识库和用户附件回答问题；如果材料不足，请明确说明当前知识库证据不足。";
  }
  if (webHits.length) {
    return "当前知识库没有相关内容；请基于联网搜索结果和用户附件回答问题，并明确说明外部来源。";
  }
  if (hasProvidedEvidence) {
    return "当前知识库没有相关内容；请基于用户附件回答问题，附件以外无法确认的内容要说明不确定。";
  }
  return webSearchAttempted
    ? "当前知识库没有相关内容，也没有获取到可用联网搜索结果；请在明确说明这一点后，基于模型通用知识正常回答。"
    : "当前知识库没有相关内容；请在明确说明这一点后，基于模型通用知识正常回答。";
}

function systemAnswerModeInstruction(
  localHits: SearchHit[],
  webHits: SearchHit[],
  hasProvidedEvidence: boolean
): string {
  if (localHits.length && webHits.length) {
    return "优先使用当前知识库；联网搜索只能作为补充和交叉验证。回答中需要区分知识库依据和联网补充。";
  }
  if (localHits.length) {
    return "你必须严格基于当前知识库和用户附件回答。材料没有说到的内容，要说明当前知识库证据不足，不要编造。";
  }
  if (webHits.length) {
    return "当前知识库没有相关内容。可以基于联网搜索结果回答，但必须说明这些结论来自联网搜索，不是知识库依据。";
  }
  if (hasProvidedEvidence) {
    return "当前知识库没有相关内容。可以基于用户附件回答；附件没有提供的内容要说明不确定。";
  }
  return "当前知识库没有相关内容，也没有可用联网搜索结果。你可以基于通用知识正常回答，但必须明确说明该部分不是知识库依据；不确定的信息要标注不确定。";
}

function offlineFallbackIntro(
  localHits: SearchHit[],
  webHits: SearchHit[],
  webSearchAttempted: boolean,
  modelConfigured: boolean
): string {
  if (localHits.length && webHits.length) {
    return "结合当前知识库和联网搜索结果，最相关的材料如下：";
  }
  if (localHits.length) {
    return "基于当前知识库，最相关的材料如下：";
  }
  if (webHits.length) {
    return "知识库没有相关内容；已使用联网搜索结果，最相关的外部材料如下：";
  }
  if (modelConfigured) {
    return webSearchAttempted
      ? "知识库没有相关内容，也没有获取到可用的联网搜索结果。"
      : "当前知识库中未找到足够的信息。";
  }
  return webSearchAttempted
    ? "知识库没有相关内容，也没有获取到可用的联网搜索结果；当前未配置可用模型，无法生成普通回答。"
    : "知识库没有相关内容；当前未配置可用模型，无法生成普通回答。";
}

function offlineHitLines(localHits: SearchHit[], webHits: SearchHit[], query: string): string[] {
  const lines: string[] = [];
  if (localHits.length) {
    lines.push("", `当前知识库中和「${query}」相关的摘录：`);
    lines.push(...localHits.slice(0, 5).map((hit, index) => `${index + 1}. **${escapeMarkdownText(hit.title)}**：${escapeMarkdownText(hit.excerpt)}`));
  }
  if (webHits.length) {
    lines.push("", `联网搜索中和「${query}」相关的摘录：`);
    lines.push(...webHits.slice(0, 5).map((hit, index) => `${index + 1}. **${escapeMarkdownText(hit.title)}**：${escapeMarkdownText(hit.excerpt)}`));
  }
  if (localHits.length || webHits.length) {
    lines.push("", "以上为检索材料摘录。需要综合回答时，请选择通过可用性测试的模型。");
  }
  return lines;
}

function dedupeSearchHits(hits: SearchHit[]): SearchHit[] {
  const byPath = new Map<string, SearchHit>();
  for (const hit of hits) {
    const existing = byPath.get(hit.path);
    if (!existing || hit.score > existing.score) {
      byPath.set(hit.path, {
        ...hit,
        citations: uniqueStrings([...(existing?.citations || []), ...(hit.citations.length ? hit.citations : [hit.path])])
      });
    } else {
      existing.citations = uniqueStrings([...existing.citations, ...(hit.citations.length ? hit.citations : [hit.path])]);
    }
  }
  return [...byPath.values()];
}

function isNonEvidenceWikiPath(path: string): boolean {
  return NON_EVIDENCE_WIKI_FILES.has(path) || NON_EVIDENCE_WIKI_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function isLowQualitySource(source: SourceRecord): boolean {
  const title = source.title || source.fileName;
  const summary = source.summary || "";
  if (source.error && UNREADABLE_EVIDENCE_RE.test(cleanUnknownGlyphRuns(source.error))) return true;
  if (isLowQualityEvidence(title, summary)) return true;
  if (isLowInformationTopicLabel(title) && !readableTextOrFallback(summary, "")) return true;
  return false;
}

function isLowQualityEvidence(title: string, content: string): boolean {
  const combined = cleanUnknownGlyphRuns(`${title}\n${content}`).trim();
  if (!combined) return true;
  if (isUnknownGlyphText(title) || isUnknownGlyphText(content)) return true;
  if (UNREADABLE_EVIDENCE_RE.test(combined)) return true;
  const unknownCount = countOccurrences(combined, UNKNOWN_GLYPH_PLACEHOLDER);
  if (unknownCount >= 2) return true;
  const readable = combined
    .replaceAll(UNKNOWN_GLYPH_PLACEHOLDER, " ")
    .replace(UNREADABLE_EVIDENCE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return !readableTextOrFallback(readable, "");
}

function scoreSearchableText(searchable: string, title: string, tokens: string[], normalizedQuery: string): number {
  let score = 0;
  if (normalizedQuery && searchable.includes(normalizedQuery)) {
    score += Math.max(12, normalizedQuery.length * 2);
  }
  for (const token of tokens) {
    const occurrences = countOccurrences(searchable, token);
    const lengthBoost = Math.min(6, Math.max(2, token.length));
    score += occurrences * lengthBoost * (title.toLowerCase().includes(token) ? 4 : 1);
  }
  if (!tokens.length && normalizedQuery) {
    score = searchable.includes(normalizedQuery) ? 1 : 0;
  }
  return score;
}

function sourceExcerpt(source: SourceRecord, query: string, tokens: string[]): string {
  const text = source.summary || `${source.fileName}\n${source.relativePath}`;
  return excerptAround(text, excerptNeedle(query, tokens, text.toLowerCase()));
}

function normalizeChatAttachments(value: unknown): ChatAttachment[] {
  if (value === undefined) return [];
  return listInput(value, "附件", maxChatAttachments).flatMap((item, index) => {
    const record = objectInput(item, "附件") as Partial<ChatAttachment>;
    const name = textInput(record.name, "附件名称", { required: true, max: 180, singleLine: true });
    const mimeType = textInput(record.mimeType, "附件类型", { max: 120, singleLine: true }) || "application/octet-stream";
    if (record.kind !== undefined && !["image", "text", "file"].includes(record.kind)) invalidInput("附件类型不受支持。");
    if (record.size !== undefined && (typeof record.size !== "number" || !Number.isSafeInteger(record.size) || record.size < 0)) invalidInput("附件大小必须是非负整数。");
    const size = record.size ?? 0;
    const kind: ChatAttachment["kind"] =
      record.kind === "image" || mimeType.startsWith("image/")
        ? "image"
        : record.kind === "text" || isTextMimeType(mimeType)
          ? "text"
          : "file";
    const text = record.text === undefined ? undefined : textInput(record.text, "附件正文", { max: maxChatAttachmentTextBytes }).trim();
    if (text && Buffer.byteLength(text, "utf8") > maxChatAttachmentTextBytes) invalidInput(`附件正文过长，最多 ${maxChatAttachmentTextBytes} 字节；请在文件页上传完整材料。`);
    if (kind === "image" && (typeof record.dataUrl !== "string" || !isSafeImageDataUrl(record.dataUrl))) invalidInput("图片附件内容无效或超过大小限制，请重新选择 PNG、JPEG、WebP 或 GIF 图片。");
    if (kind === "text" && !text) invalidInput("附件没有可读取正文，请重新上传原文件。");
    const dataUrl =
      kind === "image" && typeof record.dataUrl === "string" && isSafeImageDataUrl(record.dataUrl)
        ? truncateUtf8(record.dataUrl, maxChatAttachmentDataUrlBytes)
        : undefined;
    return [
      {
        id: String(record.id || idFrom(`${name}-${index}`)).slice(0, 120),
        name,
        mimeType,
        size,
        kind,
        ...(text ? { text } : {}),
        ...(dataUrl ? { dataUrl } : {})
      }
    ];
  });
}

function buildUserContent(prompt: string, attachments: ChatAttachment[]): string | LlmContentPart[] {
  const images = attachments.filter((attachment) => attachment.kind === "image" && attachment.dataUrl);
  if (!images.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((attachment) => ({
      type: "image_url" as const,
      image_url: { url: attachment.dataUrl! }
    }))
  ];
}

function attachmentsToTextContext(attachments: ChatAttachment[]): string {
  return attachments
    .map((attachment, index) => {
      const header = `[附件 ${index + 1}] ${attachment.name} (${attachment.mimeType || attachment.kind}, ${attachment.size} bytes)`;
      if (attachment.text) return `${header}\n${cleanUnknownGlyphRuns(attachment.text)}`;
      if (attachment.kind === "image" && attachment.dataUrl) return `${header}\n图片已随问题发送给支持多模态的模型。`;
      return `${header}\n未提供可直接读取的文本内容。`;
    })
    .join("\n\n");
}

function offlineAttachmentLines(attachments: ChatAttachment[]): string[] {
  if (!attachments.length) return [];
  return [
    "",
    "用户附件：",
    ...attachments.map((attachment, index) =>
      `${index + 1}. ${attachment.name}${attachment.text ? `：${cleanUnknownGlyphRuns(attachment.text).slice(0, 180)}` : ""}`
    )
  ];
}

function offlineCapabilityLines(settings: ProjectSettings, mcpToolContext = ""): string[] {
  const skills = settings.skills.filter((skill) => skill.enabled);
  const servers = settings.mcpServers.filter((server) => server.enabled);
  if (!skills.length && !servers.length && !mcpToolContext) return [];
  const lines = [
    "",
    "已启用扩展能力：",
    ...skills.slice(0, 6).map((skill, index) => `${index + 1}. Skill：${skill.name}`),
    ...servers.slice(0, 6).map((server, index) => `${skills.length + index + 1}. MCP：${server.name}（${server.transport}）`)
  ];
  if (mcpToolContext) {
    lines.push("", "MCP 工具调用结果：", mcpToolContext);
  }
  return lines;
}

function compactStoredAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments.map((attachment) => ({
    ...attachment,
    text: attachment.text,
    dataUrl: attachment.dataUrl
  }));
}

function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
      "application/javascript"
    ].includes(mimeType)
  );
}

function isSafeImageDataUrl(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > maxChatAttachmentDataUrlBytes) return false;
  const match = /^data:image\/(?:png|jpe?g|webp|gif);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(value);
  if (!match) return false;
  const base64 = match[1].replace(/[\r\n]/g, "");
  return base64.length % 4 === 0 && /^[a-zA-Z0-9+/]+={0,2}$/.test(base64) && Buffer.from(base64, "base64").toString("base64") === base64;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let output = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    output += char;
    bytes += charBytes;
  }
  return output;
}

function isSearchableFile(relativeRoot: string, file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  if (relativeRoot === "wiki") return ext === ".md";
  if (relativeRoot === "raw/sources") return RAW_SEARCH_EXTENSIONS.has(ext);
  return true;
}

function searchTokens(query: string): string[] {
  const tokens = new Set(tokenize(query));
  for (const segment of query.match(/\p{Script=Han}+/gu) ?? []) {
    for (const part of segment.split(QUERY_SPLIT_WORDS)) {
      if (part.length >= 2 && !QUERY_STOP_WORDS.has(part)) tokens.add(part);
    }
    for (let size = Math.min(4, segment.length); size >= 2; size -= 1) {
      for (let index = 0; index <= segment.length - size; index += 1) {
        const token = segment.slice(index, index + size);
        if (isUsefulChineseQueryToken(token)) tokens.add(token);
      }
    }
  }
  return [...tokens]
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 2 && !QUERY_STOP_WORDS.has(token))
    .slice(0, 40);
}

function isUsefulChineseQueryToken(token: string): boolean {
  if (QUERY_STOP_WORDS.has(token)) return false;
  if (/^[的吗呢吧了和与或及在是有要]+$/u.test(token)) return false;
  if (/什么|哪些|如何|怎么|怎样|为何|为什么|是否|有关|关于|事项|问题|内容|知识库/u.test(token)) return false;
  return /[\p{Script=Han}]/u.test(token);
}

function countOccurrences(input: string, token: string): number {
  if (!token) return 0;
  let count = 0;
  let index = input.indexOf(token);
  while (index !== -1) {
    count += 1;
    index = input.indexOf(token, index + token.length);
  }
  return count;
}

function excerptNeedle(query: string, tokens: string[], searchable: string): string {
  const exact = query.trim();
  if (exact && searchable.includes(exact.toLowerCase())) return exact;
  return tokens.find((token) => searchable.includes(token)) || exact;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function isSmallEnoughForRawSearch(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath);
  return stat.size <= maxRawSearchBytes;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
