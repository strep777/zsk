import {
  ChatSession,
  ActivitySnapshot,
  ChatAttachment,
  KnowledgeGraph,
  LintIssue,
  Project,
  ProjectSettings,
  QueueItem,
  ResearchTask,
  SearchHit,
  SourceRecord,
  WikiFile
} from "./types";

const API_BASE = "/api/v1";
const DEFAULT_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

function projectPath(projectId: string, suffix = ""): string {
  return `/projects/${encodeURIComponent(projectId)}${suffix}`;
}

export interface UploadSourcesResult {
  async?: boolean;
  message?: string;
  sources: SourceRecord[];
  total: number;
  queued: number;
  skipped: number;
  archives?: Array<{ fileName: string; extracted: number; directory: string }>;
  activity: ActivitySnapshot;
}

export interface UploadProgress {
  batchIndex: number;
  batchCount: number;
  uploadedFiles: number;
  totalFiles: number;
  queued: number;
  skipped: number;
  fileName?: string;
  currentChunk?: number;
  totalChunks?: number;
  uploadedBytes?: number;
  totalBytes?: number;
  detail?: string;
}

export interface UploadOptions {
  chunkBytes?: number;
  signal?: AbortSignal;
  isCancelled?: () => boolean;
  waitWhilePaused?: () => Promise<void>;
  onProgress?: (progress: UploadProgress) => void;
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return request<T>(path, { method: "GET", signal });
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) });
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) });
}

export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    notifyAuthenticationRequired(response.status);
    throw await responseError(response);
  }
  return (await response.json()) as T;
}

async function responseError(response: Response): Promise<ApiError> {
  const payload: unknown = await response.json().catch(() => undefined);
  const detail = typeof payload === "string" ? payload : payload && typeof payload === "object" && "error" in payload ? payload.error : undefined;
  const message = typeof detail === "string" ? detail.trim() : "";
  const statusText = response.statusText.trim();
  return new ApiError(response.status, message || `请求失败（HTTP ${response.status}${statusText ? ` ${statusText}` : ""}）。`);
}

export const api = {
  extractAttachment: (projectId: string, file: File) => request<{ text: string; warnings: string[] }>(
    `${projectPath(projectId, "/attachments/extract")}?fileName=${encodeURIComponent(file.name)}`,
    { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } }
  ),
  authenticate: (token: string) => request<{ ok: true }>("/session", { method: "POST", headers: { "x-api-token": token } }),
  projects: () => apiGet<{ projects: Project[] }>("/projects"),
  createProject: (body: { name: string; description?: string }) =>
    apiPost<{ project: Project }>("/projects", body),
  wikiFiles: (
    projectId: string,
    options: { limit?: number; offset?: number; query?: string; includeTotal?: boolean; signal?: AbortSignal } = {}
  ) => {
    const params = new URLSearchParams({ scope: "wiki" });
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    if (options.query) params.set("query", options.query);
    if (options.includeTotal) params.set("includeTotal", "1");
    return apiGet<{ files: WikiFile[]; total?: number; offset?: number; limit?: number; limited?: boolean }>(
      `${projectPath(projectId, "/files")}?${params}`, options.signal
    );
  },
  rawFiles: (
    projectId: string,
    options: { limit?: number; offset?: number; query?: string; compact?: boolean; signal?: AbortSignal } = {}
  ) => {
    const params = new URLSearchParams({ scope: "raw" });
    params.set("limit", String(options.limit ?? 500));
    if (options.offset) params.set("offset", String(options.offset));
    if (options.query) params.set("query", options.query);
    if (options.compact ?? true) params.set("compact", "1");
    return apiGet<{ files: SourceRecord[]; total?: number; offset?: number; limit?: number }>(
      `${projectPath(projectId, "/files")}?${params}`, options.signal
    );
  },
  fileContent: (projectId: string, filePath: string, signal?: AbortSignal) =>
    apiGet<{ path: string; content: string }>(
      `${projectPath(projectId, "/files/content")}?path=${encodeURIComponent(filePath)}`, signal
    ),
  saveFile: (projectId: string, path: string, content: string) =>
    apiPut<{ ok: true }>(projectPath(projectId, "/files/content"), { path, content }),
  uploadSources: async (projectId: string, files: FileList | File[], options: UploadOptions = {}) => {
    const selected = Array.from(files);
    const chunkBytes = normalizeUploadChunkBytes(options.chunkBytes);
    const taskCount = selected.length;
    const totalBytes = selected.reduce((sum, file) => sum + file.size, 0);
    let uploadedFiles = 0;
    let uploadedBytes = 0;
    let result: UploadSourcesResult | null = null;

    for (const file of selected) {
      await waitForUploadSlot(options);
      const currentTask = uploadedFiles + 1;
      const totalChunks = Math.max(1, Math.ceil(file.size / chunkBytes));
      const chunkResult = await uploadFileInChunks(projectId, file, chunkBytes, options, (fileUploadedBytes, detail, chunk) => {
        options.onProgress?.({
          batchIndex: currentTask,
          batchCount: taskCount,
          uploadedFiles,
          totalFiles: selected.length,
          queued: result?.queued ?? 0,
          skipped: result?.skipped ?? 0,
          fileName: file.name,
          currentChunk: chunk?.current,
          totalChunks: chunk?.total,
          uploadedBytes: uploadedBytes + fileUploadedBytes,
          totalBytes,
          detail
        });
      });
      uploadedFiles += 1;
      uploadedBytes += file.size;
      result = mergeUploadResults(result, chunkResult);
      options.onProgress?.({
        batchIndex: uploadedFiles,
        batchCount: taskCount,
        uploadedFiles,
        totalFiles: selected.length,
        queued: result.queued,
        skipped: result.skipped,
        fileName: file.name,
        currentChunk: totalChunks,
        totalChunks,
        uploadedBytes,
        totalBytes,
        detail: `${file.name} 上传完成`
      });
    }

    return (
      result ?? {
        sources: [],
        total: 0,
        queued: 0,
        skipped: 0,
        archives: [],
        activity: {
          queue: [],
          sources: [],
          queueTotal: 0,
          sourceTotal: 0,
          sourceBytesTotal: 0,
          queueStats: { total: 0, queued: 0, running: 0, done: 0, failed: 0 },
          sourceStats: { total: 0, queued: 0, ingesting: 0, ready: 0, skipped: 0, failed: 0 }
        }
      }
    );
  },
  clip: (projectId: string, body: { title: string; url?: string; content: string }) =>
    apiPost<{ source: SourceRecord }>(projectPath(projectId, "/sources/clip"), body),
  rescan: (projectId: string) => apiPost<{ queued: number; total: number }>(projectPath(projectId, "/sources/rescan")),
  resumeQueue: (projectId: string) => apiPost<{ ok: true }>(projectPath(projectId, "/queue/resume")),
  deleteSource: (projectId: string, sourceId: string) =>
    apiDelete<{ sources: SourceRecord[]; total: number; queueTotal?: number; deleted: boolean }>(
      projectPath(projectId, `/sources/${encodeURIComponent(sourceId)}`)
    ),
  activity: (projectId: string, options: { sourceLimit?: number; queueLimit?: number; compact?: boolean; signal?: AbortSignal } = {}) => {
    const params = new URLSearchParams();
    if (options.sourceLimit) params.set("sourceLimit", String(options.sourceLimit));
    if (options.queueLimit) params.set("queueLimit", String(options.queueLimit));
    if (options.compact ?? true) params.set("compact", "1");
    const suffix = params.size ? `?${params}` : "";
    return apiGet<ActivitySnapshot>(projectPath(projectId, `/activity${suffix}`), options.signal);
  },
  search: (projectId: string, query: string) =>
    apiPost<{ hits: SearchHit[] }>(projectPath(projectId, "/search"), { query }),
  chat: (
    projectId: string,
    body: {
      query: string;
      chatId?: string;
      save?: boolean;
      attachments?: ChatAttachment[];
      useHistory?: boolean;
      webSearch?: boolean;
      modelId?: string;
    }
  ) =>
    apiPost<{ answer: string; hits: SearchHit[]; chat: ChatSession; savedPath?: string }>(
      projectPath(projectId, "/chat"),
      body
    ),
  saveChatAnswer: (projectId: string, chatId: string) =>
    apiPost<{ savedPath: string }>(projectPath(projectId, `/chats/${encodeURIComponent(chatId)}/save`)),
  deleteChat: (projectId: string, chatId: string) =>
    apiDelete<{ deleted: boolean }>(projectPath(projectId, `/chats/${encodeURIComponent(chatId)}`)),
  graph: (projectId: string) => apiGet<KnowledgeGraph>(projectPath(projectId, "/graph")),
  lint: (projectId: string, options: { limit?: number } = {}) => {
    const suffix = options.limit ? `?limit=${encodeURIComponent(String(options.limit))}` : "";
    return apiPost<{ issues: LintIssue[] }>(projectPath(projectId, `/lint${suffix}`), options);
  },
  research: (projectId: string, body: { topic: string; queries?: string[]; modelId?: string }) =>
    apiPost<{ task: ResearchTask }>(projectPath(projectId, "/research"), body),
  researchTasks: (projectId: string) =>
    apiGet<{ tasks: ResearchTask[] }>(projectPath(projectId, "/research")),
  researchTask: (projectId: string, taskId: string) =>
    apiGet<{ task: ResearchTask }>(projectPath(projectId, `/research/${encodeURIComponent(taskId)}`)),
  deleteResearchTask: (projectId: string, taskId: string) =>
    apiDelete<{ deleted: boolean }>(projectPath(projectId, `/research/${encodeURIComponent(taskId)}`)),
  settings: (projectId: string) => apiGet<{ settings: ProjectSettings }>(projectPath(projectId, "/settings")),
  saveSettings: (projectId: string, body: Partial<ProjectSettings>) =>
    apiPut<{ settings: ProjectSettings }>(projectPath(projectId, "/settings"), body),
  diagnoseSettings: (projectId: string, action: string, body: unknown) =>
    apiPost<{ message: string; name?: string; latencyMs?: number; response?: string; models?: string[]; collections?: string[]; collection?: string; queryBy?: string; tools?: string[]; resources?: string[]; indexed?: number; updated?: number; deleted?: number }>(projectPath(projectId, `/settings/diagnostics/${encodeURIComponent(action)}`), body),
  chats: (projectId: string) => apiGet<{ chats: ChatSession[] }>(projectPath(projectId, "/chats"))
};

async function uploadFileInChunks(
  projectId: string,
  file: File,
  chunkBytes: number,
  options: UploadOptions,
  onProgress?: (uploadedBytes: number, detail: string, chunk?: { current: number; total: number }) => void
): Promise<UploadSourcesResult> {
  const uploadId = createUploadId();
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkBytes));
  let latestResponse: Partial<UploadSourcesResult> & {
    activity?: ActivitySnapshot;
    message?: string;
  } | null = null;

  try {
    for (let index = 0; index < totalChunks; index += 1) {
      await waitForUploadSlot(options);
      const start = index * chunkBytes;
      const end = Math.min(file.size, start + chunkBytes);
      const chunk = file.slice(start, end);
      const params = new URLSearchParams({
        uploadId,
        fileName: file.name,
        index: String(index),
        totalChunks: String(totalChunks),
        offset: String(start),
        fileSize: String(file.size),
        chunkSize: String(chunk.size)
      });
      params.set("deferRefresh", "1");
      const response = await fetch(`${API_BASE}${projectPath(projectId, "/sources/upload-chunk")}?${params}`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream"
        },
        body: chunk,
        signal: options.signal
      });
      if (!response.ok) {
        notifyAuthenticationRequired(response.status);
        throw await responseError(response);
      }
      let payload: unknown;
      try { payload = await response.json(); }
      catch { throw new ApiError(502, "上传服务返回的内容不是有效的 JSON，请检查服务器或代理配置。"); }
      assertUploadActive(options);
      if (!payload || typeof payload !== "object" || !("done" in payload) || typeof payload.done !== "boolean") {
        throw new ApiError(502, "服务未返回有效的上传分片确认，请重新上传。");
      }
      if (payload.done !== (index === totalChunks - 1)) {
        throw new ApiError(502, "服务返回的上传分片状态与当前进度不一致，无法确认上传完成，请重新上传。");
      }
      latestResponse = payload as Partial<UploadSourcesResult>;
      onProgress?.(end, `${file.name}：分片 ${index + 1}/${totalChunks}`, {
        current: index + 1,
        total: totalChunks
      });
      assertUploadActive(options);
    }
  } catch (error) {
    await cleanupUploadSession(projectId, uploadId).catch(() => undefined);
    throw error;
  }

  return {
    async: Boolean(latestResponse?.async),
    message: latestResponse?.message || "文件已上传，已自动加入摄入队列。",
    sources: latestResponse?.sources || [],
    total: latestResponse?.total ?? 1,
    queued: latestResponse?.queued ?? 0,
    skipped: latestResponse?.skipped ?? 0,
    archives: latestResponse?.archives || [],
    activity:
      latestResponse?.activity || {
        queue: [],
        sources: [],
        queueTotal: 0,
        sourceTotal: 0,
        sourceBytesTotal: 0,
        queueStats: { total: 0, queued: 0, running: 0, done: 0, failed: 0 },
        sourceStats: { total: 0, queued: 0, ingesting: 0, ready: 0, skipped: 0, failed: 0 }
      }
  };
}

async function waitForUploadSlot(options: UploadOptions): Promise<void> {
  assertUploadActive(options);
  const pause = options.waitWhilePaused?.();
  const signal = options.signal;
  if (pause && signal) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(uploadCancelledError()); };
      signal.addEventListener("abort", abort, { once: true });
      pause.then(
        () => { signal.removeEventListener("abort", abort); resolve(); },
        (error) => { signal.removeEventListener("abort", abort); reject(error); }
      );
      if (signal.aborted) abort();
    });
  } else {
    await pause;
  }
  assertUploadActive(options);
}

function assertUploadActive(options: UploadOptions): void {
  if (options.signal?.aborted || options.isCancelled?.()) throw uploadCancelledError();
}

function notifyAuthenticationRequired(status: number) {
  if (status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("llmwiki-auth-required"));
}

function uploadCancelledError(): Error {
  const error = new Error("上传已取消");
  error.name = "AbortError";
  return error;
}

function normalizeUploadChunkBytes(value: number | undefined): number {
  return Number.isFinite(value) && value && value >= 1 ? Math.floor(value) : DEFAULT_UPLOAD_CHUNK_BYTES;
}

async function cleanupUploadSession(projectId: string, uploadId: string): Promise<void> {
  const params = new URLSearchParams({ uploadId });
  const controller = new AbortController();
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("清理上传会话超时。")); }, 15000);
  });
  try {
    await Promise.race([
      fetch(`${API_BASE}${projectPath(projectId, "/sources/upload-session")}?${params}`, { method: "DELETE", signal: controller.signal }),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function mergeUploadResults(current: UploadSourcesResult | null, next: UploadSourcesResult): UploadSourcesResult {
  if (!current) return next;
  return {
    async: Boolean(current.async || next.async),
    message: next.message || current.message,
    sources: [...current.sources, ...next.sources],
    total: current.total + next.total,
    queued: current.queued + next.queued,
    skipped: current.skipped + next.skipped,
    archives: [...(current.archives || []), ...(next.archives || [])],
    activity: next.activity
  };
}

function createUploadId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
