import { AnalysisResult, ProjectSettings } from "../types.js";
import {
  extractHeadings,
  extractNamedCandidates,
  firstParagraph,
  isUnknownGlyphText,
  readableTextOrFallback,
  splitSentences,
  stripLowSignalText,
  topKeywords
} from "./text.js";

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | LlmContentPart[];
}

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export function hasLiveModel(settings: ProjectSettings): boolean {
  if (settings.provider === "offline") return false;
  if (settings.provider === "ollama") return Boolean(settings.baseUrl && settings.model);
  return Boolean(settings.apiKey && settings.baseUrl && settings.model);
}

export async function analyzeWithModel(
  settings: ProjectSettings,
  title: string,
  text: string
): Promise<AnalysisResult | null> {
  if (!hasLiveModel(settings)) return null;

  const prompt = [
    "请把下面材料编译为知识库摄入摘要，必须只返回 JSON。",
    "JSON 字段：title, summary, keyPoints[], concepts[], entities[], questions[], confidence。",
    "concepts 与 entities 不要超过 10 个，summary 用中文。",
    "questions 是后续核对用的待确认事项，必须具体、可操作，例如确认适用范围、有效时间、关键结论、是否需要补充材料；不要生成“与当前知识库中的哪些主题相关”这类泛泛问题。",
    "",
    `材料标题：${title}`,
    "",
    text.slice(0, 16000)
  ].join("\n");

  const content = await chatCompletion(settings, [
    { role: "system", content: settings.systemPrompt },
    { role: "user", content: prompt }
  ]);
  if (!content) return null;

  try {
    const jsonText = content.replace(/^```json\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(jsonText) as Partial<AnalysisResult>;
    if (!parsed.summary) return null;
    return normalizeAnalysis({
      title: parsed.title || title,
      summary: parsed.summary,
      keyPoints: parsed.keyPoints ?? [],
      concepts: parsed.concepts ?? [],
      entities: parsed.entities ?? [],
      questions: parsed.questions ?? [],
      confidence: Number(parsed.confidence ?? 0.72)
    });
  } catch {
    return null;
  }
}

export function analyzeOffline(title: string, text: string): AnalysisResult {
  const safeTitle = readableTextOrFallback(title, "未命名来源");
  const semanticText = stripLowSignalText(text);
  const sentences = splitSentences(semanticText);
  const headings = extractHeadings(semanticText);
  const keywords = topKeywords(semanticText, 12).filter((keyword) => !isUnknownGlyphText(keyword));
  const conceptSet = new Set(keywords.map((item) => item.toLowerCase()));
  const genericEntities = new Set(["url", "wiki", "markdown", "schema", "sources", "pages"]);
  const entities = extractNamedCandidates(semanticText, 16)
    .filter((item) => !conceptSet.has(item.toLowerCase()))
    .filter((item) => !genericEntities.has(item.toLowerCase()))
    .slice(0, 10);
  const summary =
    readableTextOrFallback(firstParagraph(text, 420), "") ||
    (isUnknownGlyphText(text) ? "原文包含无法识别字符，请重新上传原始文件或检查编码。" : `来源 ${safeTitle} 已加入知识库。`);
  const keyPoints = [...headings.slice(0, 5), ...sentences.slice(0, 5)]
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
  const followupKeywords = keywords.filter(isUsefulFollowupKeyword).slice(0, 3);
  const questions = [
    `请确认《${safeTitle}》的适用范围、有效时间和关键结论是否完整。`,
    ...followupKeywords.map((keyword) => `请确认“${keyword}”是否需要作为独立主题，并补充它与已有页面的关系。`)
  ].slice(0, 4);

  return normalizeAnalysis({
    title: safeTitle,
    summary,
    keyPoints,
    concepts: keywords,
    entities,
    questions,
    confidence: 0.62
  });
}

function isUsefulFollowupKeyword(keyword: string): boolean {
  const value = keyword.trim();
  if (value.length < 2) return false;
  if (/^\d+[a-z]*$/i.test(value)) return false;
  return /[\p{Script=Han}A-Za-z]/u.test(value);
}

export async function chatCompletion(settings: ProjectSettings, messages: LlmMessage[]): Promise<string | null> {
  try {
    if (settings.provider === "ollama") {
      return await ollamaChat(settings, messages);
    }
    if (settings.provider === "anthropic") {
      return await anthropicChat(settings, messages);
    }
    if (settings.provider === "gemini") {
      return await geminiChat(settings, messages);
    }
    return await openAiCompatibleChat(settings, messages);
  } catch (error) {
    console.warn("[llm] completion failed", error);
    return null;
  }
}

async function openAiCompatibleChat(settings: ProjectSettings, messages: LlmMessage[]): Promise<string | null> {
  if (!settings.apiKey) return null;
  const base = settings.baseUrl.replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      temperature: 0.2
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI compatible API error: ${response.status} ${detail.slice(0, 300)}`.trim());
  }
  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? null;
}

async function ollamaChat(settings: ProjectSettings, messages: LlmMessage[]): Promise<string | null> {
  const base = (settings.baseUrl || "http://localhost:11434").replace(/\/$/, "");
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      messages: messages.map(toOllamaMessage),
      stream: false
    })
  });
  if (!response.ok) throw new Error(`Ollama API error: ${response.status}`);
  const json = (await response.json()) as { message?: { content?: string } };
  return json.message?.content ?? null;
}

async function anthropicChat(settings: ProjectSettings, messages: LlmMessage[]): Promise<string | null> {
  if (!settings.apiKey) return null;
  const system = messages.find((message) => message.role === "system")?.content;
  const userMessages = messages.filter((message) => message.role !== "system");
  const base = (settings.baseUrl || "https://api.anthropic.com").replace(/\/$/, "");
  const endpoint = base.endsWith("/v1") ? `${base}/messages` : `${base}/v1/messages`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: settings.model,
      system,
      max_tokens: 2048,
      temperature: 0.2,
      messages: userMessages.map(toAnthropicMessage)
    })
  });
  if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`);
  const json = (await response.json()) as { content?: Array<{ text?: string }> };
  return json.content?.map((part) => part.text ?? "").join("\n").trim() || null;
}

async function geminiChat(settings: ProjectSettings, messages: LlmMessage[]): Promise<string | null> {
  if (!settings.apiKey) return null;
  const base = (settings.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  const apiBase = /\/v1(?:beta)?$/.test(base) ? base : `${base}/v1beta`;
  const response = await fetch(
    `${apiBase}/models/${settings.model}:generateContent?key=${settings.apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: geminiParts(messages)
          }
        ],
        generationConfig: { temperature: 0.2 }
      })
    }
  );
  if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);
  const json = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? null;
}

function toTextContent(content: LlmMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
}

function imageDataUrls(content: LlmMessage["content"]): string[] {
  if (typeof content === "string") return [];
  return content.filter((part) => part.type === "image_url").map((part) => part.image_url.url);
}

function toOllamaMessage(message: LlmMessage): { role: LlmMessage["role"]; content: string; images?: string[] } {
  const images = imageDataUrls(message.content).map(dataFromDataUrl).filter(Boolean) as string[];
  return {
    role: message.role,
    content: toTextContent(message.content),
    ...(images.length ? { images } : {})
  };
}

function toAnthropicMessage(message: LlmMessage): {
  role: "user" | "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  >;
} {
  const role = message.role === "assistant" ? "assistant" : "user";
  if (typeof message.content === "string") {
    return { role, content: [{ type: "text", text: message.content }] };
  }
  return {
    role,
    content: message.content
      .map((part) => {
        if (part.type === "text") return { type: "text" as const, text: part.text };
        const parsed = parseDataUrl(part.image_url.url);
        if (!parsed) return null;
        return {
          type: "image" as const,
          source: { type: "base64" as const, media_type: parsed.mimeType, data: parsed.data }
        };
      })
      .filter((part): part is NonNullable<typeof part> => Boolean(part))
  };
}

function geminiParts(messages: LlmMessage[]): Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> {
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  for (const message of messages) {
    const text = toTextContent(message.content);
    if (text) parts.push({ text: `${message.role}: ${text}` });
    for (const image of imageDataUrls(message.content)) {
      const parsed = parseDataUrl(image);
      if (parsed) parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
    }
  }
  return parts.length ? parts : [{ text: "" }];
}

function parseDataUrl(value: string): { mimeType: string; data: string } | null {
  const match = value.match(/^data:([^;,]+);base64,([a-zA-Z0-9+/=\r\n]+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2].replace(/\s+/g, "") };
}

function dataFromDataUrl(value: string): string | null {
  return parseDataUrl(value)?.data ?? null;
}

function normalizeAnalysis(value: AnalysisResult): AnalysisResult {
  return {
    title: value.title.trim(),
    summary: value.summary.trim(),
    keyPoints: cleanList(value.keyPoints, 8),
    concepts: cleanList(value.concepts, 10),
    entities: cleanList(value.entities, 10),
    questions: cleanList(value.questions, 6),
    confidence: Math.max(0, Math.min(1, value.confidence || 0.6))
  };
}

function cleanList(items: string[], limit: number): string[] {
  return [
    ...new Set(
      items
        .map((item) => readableTextOrFallback(item.replace(/\s+/g, " ").trim(), ""))
        .filter((item) => item.length > 1 && !isUnknownGlyphText(item))
    )
  ].slice(0, limit);
}
