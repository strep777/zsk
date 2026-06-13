import {
  ChatSession,
  ActivitySnapshot,
  ChatAttachment,
  KnowledgeGraph,
  LintIssue,
  Project,
  ProjectSettings,
  QueueItem,
  SearchHit,
  SourceRecord,
  WikiFile
} from "./types";

const API_BASE = "/api/v1";
const DEFAULT_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

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

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
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

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(payload.error || response.statusText);
  }
  return (await response.json()) as T;
}

export const api = {
  projects: () => apiGet<{ projects: Project[] }>("/projects"),
  createProject: (body: { name: string; description?: string }) =>
    apiPost<{ project: Project }>("/projects", body),
  wikiFiles: (projectId: string, options: { limit?: number; offset?: number; query?: string } = {}) => {
    const params = new URLSearchParams({ scope: "wiki" });
    if (options.limit) params.set("limit", String(options.limit));
    if (options.offset) params.set("offset", String(options.offset));
    if (options.query) params.set("query", options.query);
    return apiGet<{ files: WikiFile[]; total?: number; offset?: number; limit?: number }>(
      `/projects/${projectId}/files?${params}`
    );
  },
  rawFiles: (
    projectId: string,
    options: { limit?: number; offset?: number; query?: string; compact?: boolean } = {}
  ) => {
    const params = new URLSearchParams({ scope: "raw" });
    params.set("limit", String(options.limit ?? 500));
    if (options.offset) params.set("offset", String(options.offset));
    if (options.query) params.set("query", options.query);
    if (options.compact ?? true) params.set("compact", "1");
    return apiGet<{ files: SourceRecord[]; total?: number; offset?: number; limit?: number }>(
      `/projects/${projectId}/files?${params}`
    );
  },
  fileContent: (projectId: string, filePath: string) =>
    apiGet<{ path: string; content: string }>(
      `/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`
    ),
  saveFile: (projectId: string, path: string, content: string) =>
    apiPut<{ ok: true }>(`/projects/${projectId}/files/content`, { path, content }),
  uploadSources: async (projectId: string, files: FileList | File[], options: UploadOptions = {}) => {
    const selected = Array.from(files);
    const chunkBytes = options.chunkBytes ?? DEFAULT_UPLOAD_CHUNK_BYTES;
    const taskCount = selected.length;
    const totalBytes = selected.reduce((sum, file) => sum + file.size, 0);
    let uploadedFiles = 0;
    let uploadedBytes = 0;
    let result: UploadSourcesResult | null = null;

    for (const file of selected) {
      await waitForUploadSlot(options);
      const currentTask = uploadedFiles + 1;
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
        activity: { queue: [], sources: [], queueTotal: 0, sourceTotal: 0, sourceBytesTotal: 0 }
      }
    );
  },
  clip: (projectId: string, body: { title: string; url?: string; content: string }) =>
    apiPost<{ source: SourceRecord }>(`/projects/${projectId}/sources/clip`, body),
  rescan: (projectId: string) => apiPost<{ queued: number; total: number }>(`/projects/${projectId}/sources/rescan`),
  deleteSource: (projectId: string, sourceId: string) =>
    apiDelete<{ sources: SourceRecord[]; total: number; queueTotal?: number; deleted: boolean }>(
      `/projects/${projectId}/sources/${encodeURIComponent(sourceId)}`
    ),
  activity: (projectId: string, options: { sourceLimit?: number; queueLimit?: number; compact?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (options.sourceLimit) params.set("sourceLimit", String(options.sourceLimit));
    if (options.queueLimit) params.set("queueLimit", String(options.queueLimit));
    if (options.compact ?? true) params.set("compact", "1");
    const suffix = params.size ? `?${params}` : "";
    return apiGet<ActivitySnapshot>(`/projects/${projectId}/activity${suffix}`);
  },
  search: (projectId: string, query: string) =>
    apiPost<{ hits: SearchHit[] }>(`/projects/${projectId}/search`, { query }),
  chat: (
    projectId: string,
    body: { query: string; chatId?: string; save?: boolean; attachments?: ChatAttachment[]; useHistory?: boolean }
  ) =>
    apiPost<{ answer: string; hits: SearchHit[]; chat: ChatSession; savedPath?: string }>(
      `/projects/${projectId}/chat`,
      body
    ),
  saveChatAnswer: (projectId: string, chatId: string) =>
    apiPost<{ savedPath: string }>(`/projects/${projectId}/chats/${encodeURIComponent(chatId)}/save`),
  graph: (projectId: string) => apiGet<KnowledgeGraph>(`/projects/${projectId}/graph`),
  lint: (projectId: string, options: { limit?: number } = {}) => {
    const suffix = options.limit ? `?limit=${encodeURIComponent(String(options.limit))}` : "";
    return apiPost<{ issues: LintIssue[] }>(`/projects/${projectId}/lint${suffix}`, options);
  },
  research: (projectId: string, body: { topic: string; queries?: string[] }) =>
    apiPost<{ path: string; markdown: string; queries: string[] }>(`/projects/${projectId}/research`, body),
  settings: (projectId: string) => apiGet<{ settings: ProjectSettings }>(`/projects/${projectId}/settings`),
  saveSettings: (projectId: string, body: Partial<ProjectSettings>) =>
    apiPut<{ settings: ProjectSettings }>(`/projects/${projectId}/settings`, body),
  chats: (projectId: string) => apiGet<{ chats: ChatSession[] }>(`/projects/${projectId}/chats`)
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
  let latestResponse: {
    activity?: { queue: QueueItem[]; sources: SourceRecord[] };
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
      const response = await fetch(`${API_BASE}/projects/${projectId}/sources/upload-chunk?${params}`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream"
        },
        body: chunk,
        signal: options.signal
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(payload.error || response.statusText || "Upload failed");
      }
      latestResponse = await response.json();
      onProgress?.(end, `${file.name}：分片 ${index + 1}/${totalChunks}`, {
        current: index + 1,
        total: totalChunks
      });
    }
  } catch (error) {
    if (isAbortLike(error) || options.isCancelled?.()) {
      await cleanupUploadSession(projectId, uploadId).catch(() => undefined);
    }
    throw error;
  }

  return {
    async: true,
    message: latestResponse?.message || "文件已上传，后台正在解包并登记到摄入队列。",
    sources: [],
    total: 1,
    queued: 0,
    skipped: 0,
    archives: [],
    activity: latestResponse?.activity || { queue: [], sources: [], queueTotal: 0, sourceTotal: 0, sourceBytesTotal: 0 }
  };
}

async function waitForUploadSlot(options: UploadOptions): Promise<void> {
  if (options.signal?.aborted || options.isCancelled?.()) throw uploadCancelledError();
  await options.waitWhilePaused?.();
  if (options.signal?.aborted || options.isCancelled?.()) throw uploadCancelledError();
}

function uploadCancelledError(): Error {
  const error = new Error("上传已取消");
  error.name = "AbortError";
  return error;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|abort|取消/.test(error.message));
}

async function cleanupUploadSession(projectId: string, uploadId: string): Promise<void> {
  const params = new URLSearchParams({ uploadId });
  await fetch(`${API_BASE}/projects/${projectId}/sources/upload-session?${params}`, { method: "DELETE" });
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
