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

export interface ActivitySnapshot {
  queue: QueueItem[];
  sources: SourceRecord[];
  queueTotal?: number;
  sourceTotal?: number;
  sourceBytesTotal?: number;
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
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
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
  provider:
    | "offline"
    | "openai"
    | "volcengine"
    | "volcengine-coding-plan"
    | "ollama"
    | "anthropic"
    | "gemini"
    | "custom";
  model: string;
  baseUrl: string;
  apiKey?: string;
  systemPrompt: string;
  webSearchProvider: "none" | "searxng" | "tavily" | "serpapi";
  webSearchUrl?: string;
  webSearchApiKey?: string;
}
