export type ViewKey = "wiki" | "files" | "sources" | "search" | "graph" | "lint" | "settings";

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  root: string;
}

export interface WikiFile {
  path: string;
  title: string;
  type: string;
  tags: string[];
  sources: string[];
  links: string[];
  size: number;
  mtime: string;
}

export interface SourceRecord {
  id: string;
  fileName: string;
  relativePath: string;
  kind: string;
  size: number;
  sha256: string;
  title?: string;
  summary?: string;
  wikiPath?: string;
  convertedPath?: string;
  importedAt: string;
  updatedAt: string;
  status: "queued" | "ingesting" | "ready" | "skipped" | "failed";
  error?: string;
}

export interface QueueItem {
  id: string;
  sourceId: string;
  relativePath: string;
  status: "queued" | "running" | "done" | "failed";
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface QueueStats {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
}

export interface SourceStats {
  total: number;
  queued: number;
  ingesting: number;
  ready: number;
  skipped: number;
  failed: number;
}

export interface IngestProgressItem {
  id: string;
  sourceId: string;
  relativePath: string;
  fileName: string;
  title?: string;
  kind?: string;
  size?: number;
  status: QueueItem["status"];
  updatedAt: string;
  error?: string;
}

export interface IngestProgress {
  total: number;
  processed: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  percent: number;
  currentIndex: number;
  active?: IngestProgressItem;
  next?: IngestProgressItem;
  updatedAt?: string;
}

export interface ArchiveImportProgress {
  id: string;
  fileName: string;
  status: "extracting" | "registering" | "done" | "failed";
  totalEntries: number;
  processedEntries: number;
  extractedFiles: number;
  queued: number;
  skipped: number;
  directory?: string;
  currentEntry?: string;
  detail?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

export interface ActivitySnapshot {
  queue: QueueItem[];
  sources: SourceRecord[];
  queueTotal?: number;
  sourceTotal?: number;
  sourceBytesTotal?: number;
  queueStats?: QueueStats;
  sourceStats?: SourceStats;
  ingestProgress?: IngestProgress;
  archiveProgress?: ArchiveImportProgress[];
}

export interface SearchHit {
  path: string;
  title: string;
  type: string;
  score: number;
  excerpt: string;
  citations: string[];
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "text" | "file";
  text?: string;
  dataUrl?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  citations?: string[];
  attachments?: ChatAttachment[];
  researchTask?: ResearchTask;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ResearchTaskStep {
  id: string;
  label: string;
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
  updatedAt?: string;
}

export interface ResearchTask {
  id: string;
  topic: string;
  queries: string[];
  modelId?: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  steps: ResearchTaskStep[];
  createdAt: string;
  updatedAt: string;
  result?: {
    path: string;
    markdown: string;
    queries: string[];
  };
  error?: string;
}

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  path: string;
  community: number;
  weight: number;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  reasons: string[];
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  insights: Array<{ kind: string; title: string; detail: string; paths: string[] }>;
}

export interface LintIssue {
  id: string;
  severity: "error" | "warning" | "info";
  path: string;
  title: string;
  detail: string;
  fix?: string;
}

export interface ProjectSettings {
  language: string;
  provider: ProviderKind;
  model: string;
  baseUrl: string;
  apiKey?: string;
  activeModelId?: string;
  modelProfiles: ModelProfile[];
  systemPrompt: string;
  webSearchProvider: "none" | "typesense" | "searxng" | "tavily" | "serpapi";
  webSearchUrl?: string;
  webSearchApiKey?: string;
  webSearchCollection?: string;
  webSearchQueryBy?: string;
  localSearchProvider?: "builtin" | "typesense";
  typesenseUrl?: string;
  typesenseApiKey?: string;
  typesenseCollection?: string;
  skills: SkillDefinition[];
  mcpServers: McpServerConfig[];
}

export type ProviderKind =
  | "offline"
  | "openai"
  | "volcengine"
  | "volcengine-coding-plan"
  | "ollama"
  | "anthropic"
  | "gemini"
  | "custom";

export interface ModelProfile {
  id: string;
  name: string;
  provider: ProviderKind;
  model: string;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  tags?: string[];
  enabled: boolean;
}

export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  apiKey?: string;
  tools?: string[];
  resources?: string[];
  enabled: boolean;
}
