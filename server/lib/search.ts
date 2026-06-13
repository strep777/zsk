import fs from "node:fs/promises";
import path from "node:path";
import { ChatAttachment, ChatSession, Project, SearchHit, SourceRecord } from "../types.js";
import { chatCompletion, hasLiveModel, LlmContentPart } from "./llm.js";
import { extractTitle, parseMarkdown } from "./markdown.js";
import { cleanUnknownGlyphRuns, isUnknownGlyphText, readableTextOrFallback, excerptAround, tokenize } from "./text.js";
import { idFrom, slugify } from "./slug.js";
import { nowIso } from "./time.js";
import { listFiles, readJson, readSettings, readSources, readText, safeJoin, writeJson } from "./storage.js";
import { saveQueryAnswer } from "./wiki.js";

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
const maxSearchFiles = readPositiveInteger("LLM_WIKI_MAX_SEARCH_FILES", 4000);
const maxChatAttachments = readPositiveInteger("LLM_WIKI_MAX_CHAT_ATTACHMENTS", 6);
const maxChatAttachmentTextBytes = readPositiveInteger("LLM_WIKI_MAX_CHAT_ATTACHMENT_TEXT_BYTES", 24000);
const maxChatAttachmentDataUrlBytes = readPositiveInteger("LLM_WIKI_MAX_CHAT_ATTACHMENT_DATA_URL_BYTES", 6 * 1024 * 1024);
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

export async function searchProject(
  project: Project,
  query: string,
  options: { limit?: number; includeRaw?: boolean } = {}
): Promise<SearchHit[]> {
  const limit = options.limit ?? 12;
  const tokens = searchTokens(query);
  const wikiHits = await scoreFiles(project, "wiki", tokens, query, maxSearchFiles);
  const rawHits = options.includeRaw ? await scoreSourceRegistry(project, tokens, query) : [];
  return [...wikiHits, ...rawHits]
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function answerQuestion(
  project: Project,
  input: { query: string; chatId?: string; save?: boolean; attachments?: unknown; useHistory?: boolean }
): Promise<{ answer: string; hits: SearchHit[]; chat: ChatSession; savedPath?: string }> {
  const query = readableTextOrFallback(input.query, "无法识别的问题");
  const queryIsUnreadable = isUnknownGlyphText(input.query);
  const useHistory = input.useHistory !== false;
  const existingChat = input.chatId ? await readChat(project, input.chatId) : null;
  const historyMessages = useHistory && existingChat ? recentConversation(existingChat) : [];
  const retrievalQuery = useHistory ? `${historyMessages.filter((message) => message.role === "user").map((message) => message.content).join(" ")} ${query}`.trim() : query;
  const attachments = normalizeChatAttachments(input.attachments);
  const hits = queryIsUnreadable ? [] : await searchProject(project, retrievalQuery || query, { includeRaw: true, limit: 8 });
  const settings = await readSettings(project);
  const context = hits.map((hit, index) => `[${index + 1}] ${hit.title} (${hit.path})\n${hit.excerpt}`).join("\n\n");
  const attachmentContext = attachmentsToTextContext(attachments);
  const userPrompt = [
    "请基于给定知识库上下文和用户附件回答问题。",
    "要求：用中文、列出依据、不要编造；若上下文不足，请明确说明。",
    useHistory ? "用户开启了连续对话，请结合下方历史消息理解代词、省略和追问。" : "用户关闭了连续对话，请只回答本轮问题。",
    "",
    `问题：${query}`,
    attachmentContext ? `\n用户附件：\n${attachmentContext}` : "",
    "",
    `知识库上下文：\n${context}`
  ].join("\n");
  const liveAnswer = !queryIsUnreadable && hasLiveModel(settings)
    ? await chatCompletion(settings, [
        { role: "system", content: settings.systemPrompt },
        ...historyMessages,
        { role: "user", content: buildUserContent(userPrompt, attachments) }
      ])
    : null;

  const answer =
    (queryIsUnreadable
      ? "问题内容包含无法识别字符。请重新输入中文问题，或重新上传没有编码损坏的原文件。"
      : null) ||
    liveAnswer ||
    [
      `基于当前知识库，和「${query}」最相关的材料如下：`,
      "",
      ...hits.slice(0, 5).map((hit, index) => `${index + 1}. ${hit.title}: ${hit.excerpt}`),
      ...offlineAttachmentLines(attachments),
      "",
      hits.length
        ? "这是离线抽取式回答；在设置里配置模型后，可以生成更完整的综合推理。"
        : "当前知识库没有找到足够证据。"
    ].join("\n");

  const citations = hits.map((hit) => hit.path);
  const chat = await appendChat(project, input.chatId, query, answer, citations, attachments);
  const savedPath = input.save ? await saveQueryAnswer(project, query, answer, citations) : undefined;
  return { answer, hits, chat, savedPath };
}

export async function listChats(project: Project): Promise<ChatSession[]> {
  const chatRoot = safeJoin(project.root, "chats");
  const files = await listFiles(chatRoot, { extensions: [".json"] });
  const chats = await Promise.all(files.map((file) => readJson<ChatSession | null>(path.join(chatRoot, file), null)));
  return chats.filter((chat): chat is ChatSession => Boolean(chat)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readChat(project: Project, chatId: string): Promise<ChatSession | null> {
  const filePath = safeJoin(project.root, `chats/${slugify(chatId)}.json`);
  return readJson<ChatSession | null>(filePath, null);
}

export async function saveLatestChatAnswer(project: Project, chatId: string): Promise<string> {
  const filePath = safeJoin(project.root, `chats/${slugify(chatId)}.json`);
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
  const id = chatId || idFrom(safeQuery);
  const filePath = safeJoin(project.root, `chats/${slugify(id)}.json`);
  const existing = await readJson<ChatSession | null>(filePath, null);
  const timestamp = nowIso();
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
}

function recentConversation(chat: ChatSession): Array<{ role: "user" | "assistant"; content: string }> {
  return chat.messages
    .filter((message): message is ChatSession["messages"][number] & { role: "user" | "assistant" } =>
      message.role === "user" || message.role === "assistant"
    )
    .slice(-8)
    .map((message) => ({
      role: message.role,
      content: cleanUnknownGlyphRuns(message.content).slice(0, 2200)
    }));
}

async function scoreFiles(
  project: Project,
  relativeRoot: string,
  tokens: string[],
  query: string,
  maxFiles: number
): Promise<SearchHit[]> {
  const root = safeJoin(project.root, relativeRoot);
  const files = await listFiles(root, { limit: maxFiles });
  const hits: SearchHit[] = [];
  for (const file of files) {
    if (!isSearchableFile(relativeRoot, file)) continue;
    const fullPath = path.join(root, file);
    if (relativeRoot === "raw/sources" && !(await isSmallEnoughForRawSearch(fullPath))) continue;
    const content = await readText(fullPath);
    const parsed = parseMarkdown(content);
    const searchable = `${extractTitle(content, file)} ${parsed.body || content}`.toLowerCase();
    const title = extractTitle(content, path.basename(file, path.extname(file)));
    const normalizedQuery = query.trim().toLowerCase();
    const score = scoreSearchableText(searchable, title, tokens, normalizedQuery);
    if (score > 0) {
      const itemPath = `${relativeRoot}/${file}`.replace(/\\/g, "/");
      hits.push({
        path: itemPath,
        title,
        type: typeof parsed.frontmatter.type === "string" ? parsed.frontmatter.type : relativeRoot,
        score,
        excerpt: excerptAround(parsed.body || content, excerptNeedle(query, tokens, searchable)),
        citations: [itemPath]
      });
    }
  }
  return hits;
}

async function scoreSourceRegistry(project: Project, tokens: string[], query: string): Promise<SearchHit[]> {
  const sources = await readSources(project);
  const hits: SearchHit[] = [];
  const normalizedQuery = query.trim().toLowerCase();

  for (const source of sources) {
    const title = source.title || source.fileName;
    const summary = source.summary || "";
    const searchable = `${title} ${source.fileName} ${source.relativePath} ${summary}`.toLowerCase();
    let score = scoreSearchableText(searchable, title, tokens, normalizedQuery);
    if (source.status === "ready") score += 2;
    if (source.wikiPath || source.convertedPath) score += 2;
    if (score <= 0) continue;

    const itemPath = source.wikiPath || source.convertedPath || source.relativePath;
    hits.push({
      path: itemPath,
      title,
      type: source.kind,
      score,
      excerpt: sourceExcerpt(source, excerptNeedle(query, tokens, searchable)),
      citations: [source.relativePath]
    });
  }

  return hits;
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

function sourceExcerpt(source: SourceRecord, needle: string): string {
  const text = source.summary || `${source.fileName}\n${source.relativePath}`;
  return excerptAround(text, needle);
}

function normalizeChatAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxChatAttachments).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Partial<ChatAttachment>;
    const name = String(record.name || `attachment-${index + 1}`).slice(0, 180);
    const mimeType = String(record.mimeType || "application/octet-stream").slice(0, 120);
    const size = Number.isFinite(Number(record.size)) ? Math.max(0, Math.floor(Number(record.size))) : 0;
    const kind: ChatAttachment["kind"] =
      record.kind === "image" || mimeType.startsWith("image/")
        ? "image"
        : record.kind === "text" || isTextMimeType(mimeType)
          ? "text"
          : "file";
    const text =
      typeof record.text === "string" ? truncateUtf8(record.text, maxChatAttachmentTextBytes).trim() : undefined;
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
      if (attachment.text) return `${header}\n${cleanUnknownGlyphRuns(attachment.text).slice(0, 4000)}`;
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

function compactStoredAttachments(attachments: ChatAttachment[]): ChatAttachment[] {
  return attachments.map((attachment) => ({
    ...attachment,
    text: attachment.text ? truncateUtf8(attachment.text, 4000) : undefined,
    dataUrl: attachment.dataUrl ? truncateUtf8(attachment.dataUrl, 200000) : undefined
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
  return (
    Buffer.byteLength(value, "utf8") <= maxChatAttachmentDataUrlBytes &&
    /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-zA-Z0-9+/=\r\n]+$/.test(value)
  );
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

async function isSmallEnoughForRawSearch(filePath: string): Promise<boolean> {
  const stat = await fs.stat(filePath);
  return stat.size <= maxRawSearchBytes;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
