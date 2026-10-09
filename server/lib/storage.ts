import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  McpServerConfig,
  ModelProfile,
  Project,
  ProjectSettings,
  QueueItem,
  SkillDefinition,
  SourceRecord
} from "../types.js";
import { envApiKeyFor, envBaseUrlFor, envModelFor, isProviderKind, providerDefaults } from "./providerSettings.js";
import { idFrom, slugify } from "./slug.js";
import { readableTextOrFallback } from "./text.js";
import { nowIso } from "./time.js";
import { serializeMarkdown } from "./markdown.js";
import { invalidateSearch } from "./searchRevision.js";
import { textInput, validateSettingsInput } from "./validation.js";
import { withResourceLock } from "./locks.js";
import { DEFAULT_SYSTEM_PROMPT } from "./defaultPrompt.js";

export const DATA_ROOT = path.resolve(process.env.LLM_WIKI_DATA_DIR ?? "data");
const PROJECTS_INDEX = path.join(DATA_ROOT, "projects.json");
let dataRootInitialization: Promise<void> | null = null;
let projectsIndexLock: Promise<void> = Promise.resolve();

export const DEFAULT_SETTINGS: ProjectSettings = {
  language: "zh-CN",
  provider: "offline",
  model: "",
  baseUrl: "",
  apiKey: undefined,
  activeModelId: undefined,
  modelProfiles: [],
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  webSearchProvider: "typesense",
  localSearchProvider: "builtin",
  skills: [],
  mcpServers: []
};

const WEB_SEARCH_PROVIDERS = new Set<ProjectSettings["webSearchProvider"]>(["none", "typesense", "searxng", "tavily", "serpapi"]);
const MCP_TRANSPORTS = new Set<McpServerConfig["transport"]>(["stdio", "http", "sse"]);
const maxSettingsModelProfiles = readPositiveInteger("LLM_WIKI_MAX_MODEL_PROFILES", 24);
const maxSettingsSkills = readPositiveInteger("LLM_WIKI_MAX_SKILLS", 24);
const maxSettingsMcpServers = readPositiveInteger("LLM_WIKI_MAX_MCP_SERVERS", 16);

export async function ensureDataRoot(): Promise<void> {
  dataRootInitialization ??= initializeDataRoot().catch((error) => {
    dataRootInitialization = null;
    throw error;
  });
  await dataRootInitialization;
}

async function initializeDataRoot(): Promise<void> {
  await fs.mkdir(DATA_ROOT, { recursive: true });
  await fs.writeFile(PROJECTS_INDEX, "[]\n", { encoding: "utf8", flag: "wx" }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
}

export async function listProjects(): Promise<Project[]> {
  await ensureDataRoot();
  const projects = await readJson<Project[]>(PROJECTS_INDEX, []);
  return projects.map((project) => ({ ...project, root: projectRoot(project.id) }));
}

export async function createProject(input: { name: string; description?: string }): Promise<Project> {
  textInput(input.name, "知识库名称", { required: true, max: 200, singleLine: true });
  textInput(input.description, "知识库用途", { max: 4000 });
  await ensureDataRoot();
  return withProjectsIndexLock(async () => {
    const projects = await readJson<Project[]>(PROJECTS_INDEX, []);
    const id = uniqueProjectId(input.name || "wiki", projects);
    const timestamp = nowIso();
    const name = readableTextOrFallback(input.name.trim(), "未命名知识库");
    const project: Project = {
      id,
      name,
      description: readableTextOrFallback(input.description?.trim() || "", ""),
      createdAt: timestamp,
      updatedAt: timestamp,
      root: newProjectRoot(id)
    };

    projects.push(project);
    await fs.mkdir(project.root, { recursive: true });
    await initializeProject(project);
    await writeJson(PROJECTS_INDEX, projects.map(({ root: _root, ...rest }) => rest as Project));
    return project;
  });
}

export async function getProject(id: string): Promise<Project> {
  const projects = await listProjects();
  const project = projects.find((item) => item.id === id);
  if (!project) {
    throw Object.assign(new Error(`Project not found: ${id}`), { status: 404 });
  }
  return project;
}

export async function touchProject(project: Project): Promise<void> {
  await withProjectsIndexLock(async () => {
    const projects = await listProjects();
    const next = projects.map((item) => (item.id === project.id ? { ...item, updatedAt: nowIso() } : item));
    await writeJson(PROJECTS_INDEX, next.map(({ root: _root, ...rest }) => rest as Project));
  });
}

export function projectRoot(id: string): string {
  const directoryName = safeProjectDirectoryName(id);
  const current = path.join(DATA_ROOT, "projects", directoryName);
  const legacy = path.join(DATA_ROOT, "projects", slugify(id));
  if (directoryName !== slugify(id) && existsSync(legacy) && !existsSync(current)) {
    return legacy;
  }
  return current;
}

export function projectMetaDir(project: Project): string {
  return path.join(project.root, ".llm-wiki");
}

export function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function safeJoin(root: string, relativePath: string): string {
  const normalized = toPosix(relativePath);
  const target = path.resolve(root, normalized);
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw Object.assign(new Error(`Unsafe path: ${relativePath}`), { status: 400 });
  }
  return target;
}

export async function readText(filePath: string, fallback = ""): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await writeAtomicText(filePath, content);
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (!content.trim()) return fallback;
    return JSON.parse(content.replace(/^\uFEFF/, "")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson<T>(filePath: string, content: T): Promise<void> {
  await writeAtomicText(filePath, `${JSON.stringify(content, null, 2)}\n`);
}

async function writeAtomicText(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tempPath, content, "utf8");
    for (let attempt = 0; ; attempt += 1) {
      try { await fs.rename(tempPath, filePath); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 6 || !["EPERM", "EACCES", "EBUSY"].includes(code || "")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
      }
    }
  } finally { await fs.rm(tempPath, { force: true }).catch(() => undefined); }
}

export async function listFiles(root: string, options: { extensions?: string[]; limit?: number } = {}): Promise<string[]> {
  const files: string[] = [];
  const extensions = options.extensions?.map((ext) => ext.toLowerCase());
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : undefined;

  async function walk(current: string): Promise<void> {
    if (limit && files.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }

    // Keep root navigation files available before a limited scan enters large subdirectories.
    entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name, "zh-CN"));
    for (const entry of entries) {
      if (limit && files.length >= limit) return;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        const relative = toPosix(path.relative(root, fullPath));
        if (!extensions || extensions.includes(path.extname(relative).toLowerCase())) {
          files.push(relative);
          if (limit && files.length >= limit) return;
        }
      }
    }
  }

  await walk(root);
  return files.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export function sourcesPath(project: Project): string {
  return path.join(projectMetaDir(project), "sources.json");
}

export function queuePath(project: Project): string {
  return path.join(projectMetaDir(project), "queue.json");
}

export function settingsPath(project: Project): string {
  return path.join(projectMetaDir(project), "settings.json");
}

export async function readSources(project: Project): Promise<SourceRecord[]> {
  return readJson<SourceRecord[]>(sourcesPath(project), []);
}

export async function writeSources(project: Project, sources: SourceRecord[]): Promise<void> {
  await writeJson(sourcesPath(project), sources);
  invalidateSearch(project.root);
}

export async function readQueue(project: Project): Promise<QueueItem[]> {
  return readJson<QueueItem[]>(queuePath(project), []);
}

export async function writeQueue(project: Project, queue: QueueItem[]): Promise<void> {
  await writeJson(queuePath(project), queue);
}

export async function readSettings(project: Project): Promise<ProjectSettings> {
  const stored = await readJson<Partial<ProjectSettings>>(settingsPath(project), {});
  const provider = isProviderKind(stored.provider) ? stored.provider : DEFAULT_SETTINGS.provider;
  const webSearchProvider = isWebSearchProvider(stored.webSearchProvider)
    ? stored.webSearchProvider
    : DEFAULT_SETTINGS.webSearchProvider;
  const defaults = providerDefaults(provider);
  const legacyModel = stored.model || envModelFor(provider) || defaults.model;
  const legacyBaseUrl = stored.baseUrl || envBaseUrlFor(provider) || defaults.baseUrl;
  const legacyApiKey = stored.apiKey || envApiKeyFor(provider);
  const modelProfiles = normalizeModelProfiles(
    stored.modelProfiles,
    legacyModelProfile({ provider, model: legacyModel, baseUrl: legacyBaseUrl, apiKey: legacyApiKey })
  );
  const activeModelId = resolveActiveModelId(stored.activeModelId, modelProfiles);
  const activeModel = activeModelId ? modelProfiles.find((profile) => profile.id === activeModelId) : undefined;
  return {
    ...DEFAULT_SETTINGS,
    ...defaults,
    ...stored,
    provider: activeModel?.provider ?? (Array.isArray(stored.modelProfiles) ? "offline" : provider),
    webSearchProvider,
    systemPrompt: typeof stored.systemPrompt === "string" && stored.systemPrompt.trim() ? stored.systemPrompt : DEFAULT_SYSTEM_PROMPT,
    localSearchProvider: "builtin",
    ...(stored.localSearchProvider === "typesense" ? {
      webSearchProvider: "typesense" as const,
      webSearchUrl: stored.webSearchUrl || stored.typesenseUrl,
      webSearchApiKey: stored.webSearchApiKey || stored.typesenseApiKey,
      webSearchCollection: stored.webSearchCollection || stored.typesenseCollection
    } : {}),
    activeModelId,
    modelProfiles,
    skills: normalizeSkills(stored.skills),
    mcpServers: normalizeMcpServers(stored.mcpServers),
    apiKey: activeModel?.apiKey ?? legacyApiKey,
    model: activeModel?.model ?? legacyModel,
    baseUrl: activeModel?.baseUrl ?? legacyBaseUrl
  };
}

export async function writeSettings(project: Project, settings: Partial<ProjectSettings>): Promise<ProjectSettings> {
  validateSettingsInput(settings);
  return withResourceLock(`${project.root}:settings`, () => writeSettingsLocked(project, settings));
}

async function writeSettingsLocked(project: Project, settings: Partial<ProjectSettings>): Promise<ProjectSettings> {
  const current = await readSettings(project);
  if (settings.provider !== undefined && !isProviderKind(settings.provider)) {
    throw Object.assign(new Error(`Invalid provider: ${String(settings.provider)}`), { status: 400 });
  }
  if (settings.webSearchProvider !== undefined && !isWebSearchProvider(settings.webSearchProvider)) {
    throw Object.assign(new Error(`Invalid webSearchProvider: ${String(settings.webSearchProvider)}`), { status: 400 });
  }
  if (settings.localSearchProvider !== undefined && !["builtin", "typesense"].includes(settings.localSearchProvider)) {
    throw Object.assign(new Error("请选择有效的本地搜索引擎。"), { status: 400 });
  }
  if (settings.skills !== undefined && !Array.isArray(settings.skills)) throw Object.assign(new Error("Skill 配置需要是列表。"), { status: 400 });
  for (const skill of settings.skills || []) {
    if (skill.enabled !== false && !skill.prompt?.trim()) throw Object.assign(new Error("已启用的 Skill 指令不能为空，请填写指令或移除空卡片。"), { status: 400 });
  }
  if (settings.mcpServers !== undefined && !Array.isArray(settings.mcpServers)) throw Object.assign(new Error("MCP 配置需要是列表。"), { status: 400 });
  for (const server of settings.mcpServers || []) {
    if (!server || !isMcpTransport(server.transport)) throw Object.assign(new Error("请选择有效的 MCP 传输方式。"), { status: 400 });
    if (server.transport === "stdio" && !server.command?.trim()) throw Object.assign(new Error("stdio MCP 需要填写启动命令。"), { status: 400 });
    if (server.transport !== "stdio" && !normalizeMcpUrl(server.url)) throw Object.assign(new Error("MCP 需要填写有效的 HTTP 或 HTTPS 地址。"), { status: 400 });
  }

  const provider = settings.provider || current.provider;
  const defaults = providerDefaults(provider);
  const providerChanged = Boolean(settings.provider && settings.provider !== current.provider);
  const merged: ProjectSettings = {
    ...current,
    ...settings,
    ...(settings.localSearchProvider === "typesense" ? {
      webSearchProvider: "typesense" as const,
      webSearchUrl: settings.webSearchUrl || settings.typesenseUrl || current.webSearchUrl,
      webSearchApiKey: settings.webSearchApiKey || settings.typesenseApiKey || current.webSearchApiKey,
      webSearchCollection: settings.webSearchCollection || settings.typesenseCollection || current.webSearchCollection
    } : {}),
    provider,
    ...(settings.localSearchProvider !== "typesense" ? { webSearchProvider: settings.webSearchProvider || current.webSearchProvider } : {}),
    localSearchProvider: "builtin",
    skills: normalizeSkills(settings.skills ?? current.skills),
    mcpServers: normalizeMcpServers(settings.mcpServers ?? current.mcpServers),
    modelProfiles:
      settings.modelProfiles !== undefined
        ? normalizeModelProfiles(settings.modelProfiles, undefined)
        : current.modelProfiles
  };

  if (providerChanged) {
    if (!settings.baseUrl || settings.baseUrl === current.baseUrl) {
      merged.baseUrl = envBaseUrlFor(provider) || defaults.baseUrl;
    }
    if (!settings.model || settings.model === current.model) {
      merged.model = envModelFor(provider) || defaults.model;
    }
    if (!settings.apiKey || settings.apiKey === current.apiKey) {
      merged.apiKey = envApiKeyFor(provider);
    }
  }

  if (settings.modelProfiles === undefined && legacyModelFieldsChanged(settings)) {
    merged.modelProfiles = upsertLegacyModelProfile(merged.modelProfiles, {
      id: merged.activeModelId,
      provider: merged.provider,
      model: merged.model,
      baseUrl: merged.baseUrl,
      apiKey: merged.apiKey
    });
  }

  merged.activeModelId = resolveActiveModelId(settings.activeModelId ?? merged.activeModelId, merged.modelProfiles);
  const activeModel = merged.activeModelId
    ? merged.modelProfiles.find((profile) => profile.id === merged.activeModelId)
    : undefined;
  if (activeModel) {
    merged.provider = activeModel.provider;
    merged.model = activeModel.model;
    merged.baseUrl = activeModel.baseUrl;
    merged.apiKey = activeModel.apiKey;
  } else if (settings.modelProfiles !== undefined) {
    merged.provider = "offline";
    merged.model = "";
    merged.baseUrl = "";
    merged.apiKey = undefined;
  }

  if (!merged.systemPrompt.trim()) merged.systemPrompt = DEFAULT_SYSTEM_PROMPT;
  await writeJson(settingsPath(project), merged);
  return merged;
}

function isWebSearchProvider(value: unknown): value is ProjectSettings["webSearchProvider"] {
  return typeof value === "string" && WEB_SEARCH_PROVIDERS.has(value as ProjectSettings["webSearchProvider"]);
}

function normalizeModelProfiles(value: unknown, legacy: ModelProfile | undefined): ModelProfile[] {
  if (!Array.isArray(value)) return legacy ? [legacy] : [];
  const seen = new Set<string>();
  return value.slice(0, maxSettingsModelProfiles).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Partial<ModelProfile>;
    const provider = isProviderKind(record.provider) ? record.provider : "custom";
    const defaults = providerDefaults(provider);
    const model = record.model === undefined ? defaults.model : cleanSettingText(record.model, 160);
    const baseUrl = record.baseUrl === undefined ? defaults.baseUrl : cleanSettingText(record.baseUrl, 500);
    const apiKey = cleanSettingText(record.apiKey, 2000) || undefined;
    const name = readableTextOrFallback(
      cleanSettingText(record.name, 80),
      `${provider}${model ? ` / ${model}` : ""}`
    );
    const id = uniqueCapabilityId(record.id, name, seen);
    return [
      {
        id,
        name,
        provider,
        model,
        baseUrl,
        apiKey,
        enabled: record.enabled !== false
      }
    ];
  });
}

function legacyModelProfile(value: {
  provider: ProjectSettings["provider"];
  model: string;
  baseUrl: string;
  apiKey?: string;
}): ModelProfile | undefined {
  if (value.provider === "offline") return undefined;
  if (!value.model && !value.baseUrl && !value.apiKey) return undefined;
  const defaults = providerDefaults(value.provider);
  const model = value.model || defaults.model;
  const baseUrl = value.baseUrl || defaults.baseUrl;
  return {
    id: `model-${value.provider}`,
    name: `默认模型 (${value.provider})`,
    provider: value.provider,
    model,
    baseUrl,
    apiKey: value.apiKey,
    enabled: true
  };
}

function resolveActiveModelId(value: unknown, profiles: ModelProfile[]): string | undefined {
  const requested = cleanSettingText(value, 120);
  const requestedProfile = requested ? profiles.find((profile) => profile.id === requested) : undefined;
  if (requestedProfile && canUseModelProfile(requestedProfile)) return requestedProfile.id;
  return profiles.find(canUseModelProfile)?.id;
}

function canUseModelProfile(profile: ModelProfile): boolean {
  if (!profile.enabled || profile.provider === "offline") return false;
  if (profile.provider === "ollama" || profile.provider === "custom") return Boolean(profile.baseUrl && profile.model);
  return Boolean(profile.apiKey && profile.baseUrl && profile.model);
}

function legacyModelFieldsChanged(settings: Partial<ProjectSettings>): boolean {
  return (
    settings.provider !== undefined ||
    settings.model !== undefined ||
    settings.baseUrl !== undefined ||
    settings.apiKey !== undefined
  );
}

function upsertLegacyModelProfile(
  profiles: ModelProfile[],
  value: {
    id?: string;
    provider: ProjectSettings["provider"];
    model: string;
    baseUrl: string;
    apiKey?: string;
  }
): ModelProfile[] {
  const legacy = legacyModelProfile(value);
  if (!legacy) return profiles;
  const index = value.id ? profiles.findIndex((profile) => profile.id === value.id) : -1;
  if (index >= 0) {
    return profiles.map((profile, profileIndex) =>
      profileIndex === index
        ? { ...profile, ...legacy, id: profile.id, name: profile.name || legacy.name, enabled: profile.enabled !== false }
        : profile
    );
  }
  return normalizeModelProfiles([...profiles, legacy], undefined);
}

function normalizeSkills(value: unknown): SkillDefinition[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, maxSettingsSkills).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Partial<SkillDefinition>;
    const prompt = cleanSettingText(record.prompt, 12000);
    if (!prompt) return [];
    const name = readableTextOrFallback(cleanSettingText(record.name, 80), "未命名 Skill");
    const id = uniqueCapabilityId(record.id, name, seen);
    return [
      {
        id,
        name,
        prompt,
        enabled: record.enabled !== false,
        ...(cleanSettingText(record.description, 300) ? { description: cleanSettingText(record.description, 300) } : {}),
        ...(normalizeStringList(record.tags, 12, 40).length ? { tags: normalizeStringList(record.tags, 12, 40) } : {})
      }
    ];
  });
}

function normalizeMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, maxSettingsMcpServers).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Partial<McpServerConfig>;
    const transport = isMcpTransport(record.transport) ? record.transport : "stdio";
    const command = cleanSettingText(record.command, 300);
    const url = normalizeMcpUrl(record.url);
    if (transport === "stdio" && !command) return [];
    if ((transport === "http" || transport === "sse") && !url) return [];
    const name = readableTextOrFallback(cleanSettingText(record.name, 80), transport === "stdio" ? command : url);
    const id = uniqueCapabilityId(record.id, name, seen);
    const args = Array.isArray(record.args)
      ? record.args.slice(0, 24).filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 180))
      : typeof record.args === "string" ? (record.args as string).split(/\r?\n/).filter(Boolean).slice(0, 24) : [];
    const tools = normalizeStringList(record.tools, 2000, 128);
    const resources = normalizeStringList(record.resources, 2000, 2048);
    return [
      {
        id,
        name,
        transport,
        enabled: record.enabled !== false,
        ...(cleanSettingText(record.description, 400) ? { description: cleanSettingText(record.description, 400) } : {}),
        ...(command ? { command } : {}),
        ...(args.length ? { args } : {}),
        ...(url ? { url } : {}),
        ...(cleanSettingText(record.apiKey, 2000) ? { apiKey: cleanSettingText(record.apiKey, 2000) } : {}),
        ...(tools.length ? { tools } : {}),
        ...(resources.length ? { resources } : {})
      }
    ];
  });
}

function isMcpTransport(value: unknown): value is McpServerConfig["transport"] {
  return typeof value === "string" && MCP_TRANSPORTS.has(value as McpServerConfig["transport"]);
}

function normalizeMcpUrl(value: unknown): string {
  const url = cleanSettingText(value, 500);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function normalizeStringList(value: unknown, limit: number, maxLength: number): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,，]/)
      : [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of raw) {
    const text = cleanSettingText(item, maxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push(text);
    if (items.length >= limit) break;
  }
  return items;
}

function uniqueCapabilityId(rawId: unknown, name: string, seen: Set<string>): string {
  const rawBase = cleanSettingText(rawId, 80) || idFrom(name) || "capability";
  const base = rawBase.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "") || "capability";
  let id = base;
  let index = 2;
  while (seen.has(id)) {
    id = `${base}-${index++}`;
  }
  seen.add(id);
  return id;
}

function cleanSettingText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, maxLength);
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export async function initializeProject(project: Project): Promise<void> {
  const directories = [
    ".llm-wiki",
    "raw/assets",
    "raw/sources",
    "wiki/concepts",
    "wiki/entities",
    "wiki/sources",
    "wiki/sources/converted",
    "wiki/queries",
    "wiki/research",
    "wiki/synthesis",
    "wiki/comparisons",
    "chats"
  ];

  // Shared parent directories must be created in order on Windows.
  for (const dir of directories) await fs.mkdir(path.join(project.root, dir), { recursive: true });
  await writeJson(settingsPath(project), DEFAULT_SETTINGS);
  await writeJson(sourcesPath(project), []);
  await writeJson(queuePath(project), []);

  await writeText(
    path.join(project.root, "wiki/index.md"),
    serializeMarkdown({ title: project.name, type: "index", tags: ["index"], sources: [] }, [
      `# ${project.name}`,
      "",
      project.description ? project.description : "_上传或添加来源后，知识库会自动生成来源页、概念页、总览和摄入日志。_"
    ].join("\n"))
  );
}

export function publicProject(project: Project): Omit<Project, "root"> & { root: string } {
  return {
    ...project,
    name: readableTextOrFallback(project.name, "未命名知识库"),
    description: readableTextOrFallback(project.description, ""),
    root: project.root
  };
}

function uniqueProjectId(name: string, projects: Project[]): string {
  const existingIds = new Set(projects.map((project) => project.id));
  let id = idFrom(name);
  while (existingIds.has(id) || existsSync(newProjectRoot(id))) {
    id = idFrom(`${name}-${randomUUID()}`);
  }
  return id;
}

function newProjectRoot(id: string): string {
  return path.join(DATA_ROOT, "projects", safeProjectDirectoryName(id));
}

function safeProjectDirectoryName(id: string): string {
  const safe = id.replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "");
  return safe || slugify(id);
}

async function withProjectsIndexLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = projectsIndexLock;
  let release!: () => void;
  projectsIndexLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}
