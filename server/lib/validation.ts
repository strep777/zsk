import { isProviderKind } from "./providerSettings.js";
import { serviceUrl } from "./serviceHttp.js";

export function invalidInput(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

export function objectInput(value: unknown, label = "请求内容"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidInput(`${label}必须是对象。`);
  return value as Record<string, unknown>;
}

export function textInput(value: unknown, label: string, options: { required?: boolean; max?: number; singleLine?: boolean } = {}): string {
  if (value === undefined && !options.required) return "";
  if (typeof value !== "string") invalidInput(`${label}必须是文字。`);
  if (options.required && !value.trim()) invalidInput(`${label}不能为空。`);
  if (value.length > (options.max ?? 4000)) invalidInput(`${label}过长，最多 ${options.max ?? 4000} 个字符。`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/u.test(value) || hasUnpairedSurrogate(value)) invalidInput(`${label}含损坏或不可识别字符，请修正后重试。`);
  if (options.singleLine && /[\r\n]/u.test(value)) invalidInput(`${label}不能包含换行。`);
  return value;
}

export function booleanInput(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") invalidInput(`${label}必须是布尔值。`);
}

export function listInput(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) invalidInput(`${label}必须是列表。`);
  if (value.length > max) invalidInput(`${label}数量超过限制：${max}。`);
  return value;
}

export function identifierInput(value: unknown, label: string): string {
  const id = textInput(value, label, { required: true, max: 160 });
  if (!/^[\p{L}\p{N}_-]+$/u.test(id)) invalidInput(`${label}格式不正确。`);
  return id;
}

export function validateSettingsInput(value: unknown): void {
  const settings = objectInput(value, "设置");
  const limits: Record<string, number> = { language: 40, provider: 40, model: 160, baseUrl: 500, apiKey: 2000, activeModelId: 120, systemPrompt: 32000, webSearchProvider: 40, webSearchUrl: 500, webSearchApiKey: 2000, webSearchCollection: 128, webSearchQueryBy: 1000, localSearchProvider: 40, typesenseUrl: 500, typesenseApiKey: 2000, typesenseCollection: 128 };
  for (const [field, max] of Object.entries(limits)) {
    if (settings[field] !== undefined) textInput(settings[field], field, { max });
  }
  for (const field of ["baseUrl", "webSearchUrl", "typesenseUrl"]) {
    if (settings[field]) serviceUrl(settings[field] as string);
  }
  if (settings.modelProfiles !== undefined) {
    const profiles = listInput(settings.modelProfiles, "模型", configuredLimit("LLM_WIKI_MAX_MODEL_PROFILES", 24));
    for (const item of profiles) {
      const profile = objectInput(item, "模型卡片");
      if (!isProviderKind(profile.provider)) invalidInput("请选择有效的模型提供商。");
      for (const [field, max] of Object.entries({ id: 80, name: 80, model: 160, baseUrl: 500, apiKey: 2000 })) textInput(profile[field], `模型 ${field}`, { max });
      booleanInput(profile.enabled, "模型启用状态");
      if (profile.baseUrl) serviceUrl(profile.baseUrl as string);
    }
  }
  if (settings.skills !== undefined) {
    for (const item of listInput(settings.skills, "Skill", configuredLimit("LLM_WIKI_MAX_SKILLS", 24))) {
      const skill = objectInput(item, "Skill 卡片");
      for (const [field, max] of Object.entries({ id: 80, name: 80, prompt: 12000, description: 300 })) textInput(skill[field], `Skill ${field}`, { max });
      booleanInput(skill.enabled, "Skill 启用状态");
      validateTextList(skill.tags, "Skill 标签", 12, 40);
    }
  }
  if (settings.mcpServers !== undefined) {
    for (const item of listInput(settings.mcpServers, "MCP", configuredLimit("LLM_WIKI_MAX_MCP_SERVERS", 16))) {
      const server = objectInput(item, "MCP 卡片");
      for (const [field, max] of Object.entries({ id: 80, name: 80, transport: 16, command: 300, url: 500, apiKey: 2000, description: 400 })) textInput(server[field], `MCP ${field}`, { max });
      booleanInput(server.enabled, "MCP 启用状态");
      validateTextList(server.args, "MCP 参数", 24, 180);
      validateTextList(server.tools, "MCP 工具", 2000, 128);
      validateTextList(server.resources, "MCP 资源", 2000, 2048);
      if (server.url) serviceUrl(server.url as string);
    }
  }
}

function validateTextList(value: unknown, label: string, max: number, length: number): void {
  if (value === undefined) return;
  for (const item of listInput(value, label, max)) textInput(item, label, { max: length });
}

function hasUnpairedSurrogate(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

function configuredLimit(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
