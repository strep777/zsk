import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Project, ProjectSettings, QueueItem, SourceRecord } from "../types.js";
import { envApiKeyFor, envBaseUrlFor, envModelFor, isProviderKind, providerDefaults } from "./providerSettings.js";
import { idFrom, slugify } from "./slug.js";
import { readableTextOrFallback } from "./text.js";
import { nowIso } from "./time.js";

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
  systemPrompt: "你是一个知识库编译器。把输入材料归纳成带来源、可互链、可审查的 Markdown Wiki。",
  webSearchProvider: "none"
};

const WEB_SEARCH_PROVIDERS = new Set<ProjectSettings["webSearchProvider"]>(["none", "searxng", "tavily", "serpapi"]);

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
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (!content.trim()) return fallback;
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson<T>(filePath: string, content: T): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
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
  return {
    ...DEFAULT_SETTINGS,
    ...defaults,
    ...stored,
    provider,
    webSearchProvider,
    apiKey: stored.apiKey || envApiKeyFor(provider),
    model: stored.model || envModelFor(provider) || defaults.model,
    baseUrl: stored.baseUrl || envBaseUrlFor(provider) || defaults.baseUrl
  };
}

export async function writeSettings(project: Project, settings: Partial<ProjectSettings>): Promise<ProjectSettings> {
  const current = await readSettings(project);
  if (settings.provider !== undefined && !isProviderKind(settings.provider)) {
    throw Object.assign(new Error(`Invalid provider: ${String(settings.provider)}`), { status: 400 });
  }
  if (settings.webSearchProvider !== undefined && !isWebSearchProvider(settings.webSearchProvider)) {
    throw Object.assign(new Error(`Invalid webSearchProvider: ${String(settings.webSearchProvider)}`), { status: 400 });
  }

  const provider = settings.provider || current.provider;
  const defaults = providerDefaults(provider);
  const providerChanged = Boolean(settings.provider && settings.provider !== current.provider);
  const merged: ProjectSettings = {
    ...current,
    ...settings,
    provider,
    webSearchProvider: settings.webSearchProvider || current.webSearchProvider
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

  await writeJson(settingsPath(project), merged);
  return merged;
}

function isWebSearchProvider(value: unknown): value is ProjectSettings["webSearchProvider"] {
  return typeof value === "string" && WEB_SEARCH_PROVIDERS.has(value as ProjectSettings["webSearchProvider"]);
}

export async function initializeProject(project: Project): Promise<void> {
  const directories = [
    ".llm-wiki",
    ".obsidian",
    "raw/assets",
    "raw/converted",
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

  await Promise.all(directories.map((dir) => fs.mkdir(path.join(project.root, dir), { recursive: true })));
  await writeJson(settingsPath(project), DEFAULT_SETTINGS);
  await writeJson(sourcesPath(project), []);
  await writeJson(queuePath(project), []);

  await writeText(
    path.join(project.root, "purpose.md"),
    `# ${project.name}\n\n${project.description || "描述这个知识库的用途、边界和目标读者。"}\n`
  );
  await writeText(
    path.join(project.root, "schema.md"),
    [
      "---",
      "title: Wiki Schema",
      "type: schema",
      "tags: [llm-wiki, schema]",
      "---",
      "# Wiki Schema",
      "",
      "- `wiki/sources/`: 每个原始材料对应一个可引用来源页。",
      "- `wiki/sources/converted/`: Word、PDF、表格、演示文稿等转换后的 Markdown 全文。",
      "- `wiki/concepts/`: 可复用概念页，聚合多个来源的定义与证据。",
      "- `wiki/entities/`: 人、组织、产品、论文、项目等实体页。",
      "- `wiki/queries/`: 被保存的问答与推理路径。",
      "- `wiki/research/`: 深度研究任务与检索结果。",
      "- `wiki/synthesis/`: 跨来源综合结论。",
      "- `wiki/comparisons/`: 对比、取舍、争议点。"
    ].join("\n")
  );
  await writeText(
    path.join(project.root, "wiki/index.md"),
    [
      "---",
      `title: ${project.name}`,
      "type: index",
      "tags: [index]",
      "sources: []",
      "---",
      `# ${project.name}`,
      "",
      "## 快速入口",
      "",
      "- [[overview|知识库总览]]",
      "- [[log|摄入日志]]",
      "",
      "## 最近概念",
      "",
      "_摄入材料后会自动更新。_"
    ].join("\n")
  );
  await writeText(
    path.join(project.root, "wiki/overview.md"),
    [
      "---",
      "title: 知识库总览",
      "type: synthesis",
      "tags: [overview]",
      "sources: []",
      "---",
      "# 知识库总览",
      "",
      "这里会汇总已摄入来源的主题、概念和后续核对事项。"
    ].join("\n")
  );
  await writeText(
    path.join(project.root, "wiki/log.md"),
    [
      "---",
      "title: 摄入日志",
      "type: log",
      "tags: [log]",
      "sources: []",
      "---",
      "# 摄入日志",
      ""
    ].join("\n")
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
