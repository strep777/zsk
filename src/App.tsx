import { DragEvent, FormEvent, RefObject, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SettingsView } from "./components/SettingsView";
import {
  ArrowLeft,
  Bold,
  BookOpen,
  CheckCircle2,
  CircleAlert,
  Code2,
  Database,
  Eye,
  FileText,
  FolderPlus,
  GitBranch,
  Globe2,
  Heading1,
  Heading2,
  Italic,
  Link,
  List,
  Loader2,
  LocateFixed,
  MessageSquare,
  Microscope,
  Network,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  SplitSquareHorizontal,
  Table2,
  Upload,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import { api, ApiError } from "./api";
import { hasConfiguredWebSearch } from "../server/lib/providerSettings";
import {
  ActivitySnapshot,
  ArchiveImportProgress,
  ChatSession,
  ChatAttachment,
  IngestProgress,
  KnowledgeGraph,
  LintIssue,
  ModelProfile,
  Project,
  ProjectSettings,
  QueueItem,
  QueueStats,
  ResearchTask,
  SearchHit,
  SourceRecord,
  SourceStats,
  ViewKey,
  WikiFile
} from "./types";

const MarkdownView = lazy(() =>
  import("./components/MarkdownView").then((module) => ({ default: module.MarkdownView }))
);

type EditorMode = "split" | "edit" | "preview";
type UploadTaskStatus = "uploading" | "paused" | "cancelling" | "cancelled" | "done" | "error";

interface NavigationSnapshot {
  view: ViewKey;
  selectedPath: string;
}

interface UploadTaskState {
  id: string;
  status: UploadTaskStatus;
  fileName: string;
  detail: string;
  totalFiles: number;
  uploadedFiles: number;
  totalBytes: number;
  uploadedBytes: number;
  queued: number;
  skipped: number;
  startedAt: string;
  error?: string;
}

const EMPTY_QUEUE_STATS: QueueStats = { total: 0, queued: 0, running: 0, done: 0, failed: 0 };
const EMPTY_SOURCE_STATS: SourceStats = { total: 0, queued: 0, ingesting: 0, ready: 0, skipped: 0, failed: 0 };
const EMPTY_INGEST_PROGRESS: IngestProgress = {
  total: 0,
  processed: 0,
  queued: 0,
  running: 0,
  done: 0,
  failed: 0,
  percent: 0,
  currentIndex: 0
};

const VIEWS: Array<{ key: ViewKey; label: string; icon: typeof BookOpen }> = [
  { key: "wiki", label: "Wiki", icon: BookOpen },
  { key: "files", label: "文件", icon: FileText },
  { key: "sources", label: "来源", icon: Link },
  { key: "search", label: "查询", icon: Search },
  { key: "graph", label: "图谱", icon: Network },
  { key: "lint", label: "体检", icon: ShieldCheck },
  { key: "settings", label: "设置", icon: Settings }
];


const FORMAT_HINT = "支持 doc、docx、ppt、pptx、xls、xlsx、pdf、zip、md、txt、html、csv、json 和常见图片。浏览器上传统一走分片，25000+ 文件建议压成一个 ZIP。";
const TREE_SECTION_LIMIT = 300;
const WIKI_TREE_LIMIT = 900;
const SOURCE_LIST_LIMIT = 500;
const FILE_PAGE_SIZE = 100;
const GRAPH_NODE_LIMIT = 600;
const PREVIEW_RENDER_CHAR_LIMIT = 160000;
const CHAT_ATTACHMENT_LIMIT = 6;
const CHAT_ATTACHMENT_TEXT_LIMIT = 12000;
const CHAT_ATTACHMENT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const SUMMARY_MODEL_ID = "summary";
const RAW_TEXT_DISPLAY_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".log",
  ".html",
  ".htm",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".xml"
]);
const LINT_SEVERITY_LABELS: Record<LintIssue["severity"], string> = {
  error: "必须处理",
  warning: "建议修复",
  info: "提示"
};
const LINT_SEVERITY_RANK: Record<LintIssue["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2
};
const LINT_CHECKS = [
  "断开的 [[链接]]",
  "缺少标题或元数据",
  "来源记录丢失",
  "孤立页面",
  "重复标题",
  "摄入失败"
];

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [token, setToken] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const projectsRequestRef = useRef(0);
  const onProjectCreated = useCallback((created: Project) => {
    projectsRequestRef.current += 1;
    setProjects((current) => [...current.filter((item) => item.id !== created.id), created]);
    setProjectId(created.id);
  }, []);
  const refreshProjects = useCallback(async () => {
    const requestId = ++projectsRequestRef.current;
    try {
      const payload = await api.projects();
      if (requestId !== projectsRequestRef.current) return;
      setProjects(payload.projects);
      setProjectId((current) => payload.projects.some((item) => item.id === current) ? current : payload.projects[0]?.id || "");
      setError("");
      setNeedsLogin(false);
      setLoaded(true);
    } catch (error) {
      if (requestId !== projectsRequestRef.current) return;
      setNeedsLogin(error instanceof ApiError && error.status === 401);
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, []);
  useEffect(() => { void refreshProjects().catch(() => undefined); }, [refreshProjects]);
  useEffect(() => {
    const requireLogin = () => { setNeedsLogin(true); setError("登录已过期，请重新填写 API Token。"); };
    window.addEventListener("llmwiki-auth-required", requireLogin);
    return () => window.removeEventListener("llmwiki-auth-required", requireLogin);
  }, []);
  async function login(event: FormEvent) {
    event.preventDefault();
    if (!token.trim() || loggingIn) return;
    setLoggingIn(true);
    try { await api.authenticate(token.trim()); await refreshProjects(); setToken(""); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setLoggingIn(false); }
  }
  if (!loaded) return <main className="empty-state"><div className="create-panel" role="status">
    <h1>LLM Wiki Web</h1>
    <p>{error ? `无法加载知识库：${error}` : "正在加载知识库..."}</p>
    {needsLogin ? <form onSubmit={login}>
      <label>API Token<input type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} /></label>
      <button type="submit" disabled={loggingIn || !token.trim()}>{loggingIn ? "正在登录..." : "登录"}</button>
    </form> : error && <button onClick={() => void refreshProjects().catch(() => undefined)}>重试</button>}
  </div></main>;
  return <>
    <ProjectWorkspace key={projectId} projects={projects} projectId={projectId} setProjectId={setProjectId} refreshProjects={refreshProjects} onProjectCreated={onProjectCreated} />
    {needsLogin && <div className="login-overlay" role="dialog" aria-modal="true" aria-label="重新登录"><div className="create-panel">
      <p role="alert">{error}</p>
      <form onSubmit={login}><label>API Token<input autoFocus type="password" autoComplete="current-password" value={token} onChange={(event) => setToken(event.target.value)} /></label>
        <button type="submit" disabled={loggingIn || !token.trim()}>{loggingIn ? "正在登录..." : "登录"}</button></form>
    </div></div>}
  </>;
}

function ProjectWorkspace({ projects, projectId, setProjectId, refreshProjects, onProjectCreated }: {
  projects: Project[];
  projectId: string;
  setProjectId: (id: string) => void;
  refreshProjects: () => Promise<void>;
  onProjectCreated: (project: Project) => void;
}) {
  const [view, setView] = useState<ViewKey>("wiki");
  const [wikiFiles, setWikiFiles] = useState<WikiFile[]>([]);
  const [wikiTotal, setWikiTotal] = useState(0);
  const [wikiLimited, setWikiLimited] = useState(false);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [sourceTotal, setSourceTotal] = useState(0);
  const [sourceBytesTotal, setSourceBytesTotal] = useState(0);
  const [fileSources, setFileSources] = useState<SourceRecord[]>([]);
  const [fileTotal, setFileTotal] = useState(0);
  const [fileOffset, setFileOffset] = useState(0);
  const [fileQuery, setFileQuery] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueTotal, setQueueTotal] = useState(0);
  const [queueStats, setQueueStats] = useState<QueueStats>(EMPTY_QUEUE_STATS);
  const [sourceStats, setSourceStats] = useState<SourceStats>(EMPTY_SOURCE_STATS);
  const [ingestProgress, setIngestProgress] = useState<IngestProgress>(EMPTY_INGEST_PROGRESS);
  const [archiveProgress, setArchiveProgress] = useState<ArchiveImportProgress[]>([]);
  const [selectedPath, setSelectedPath] = useState("wiki/index.md");
  const [editor, setEditor] = useState("");
  const [preview, setPreview] = useState("");
  const [previewDocumentPath, setPreviewDocumentPath] = useState("wiki/index.md");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [compactPreview, setCompactPreview] = useState(() => window.matchMedia?.("(max-width: 1180px)").matches ?? false);
  const previewModalOpen = previewOpen && compactPreview;
  const [editorMode, setEditorMode] = useState<EditorMode>("edit");
  const [notice, setNotice] = useState("");
  const [busyCount, setBusyCount] = useState(0);
  const busy = busyCount > 0;
  const setBusy = useCallback((value: boolean) => setBusyCount((count) => Math.max(0, count + (value ? 1 : -1))), []);
  const [fileOpening, setFileOpening] = useState(false);
  const [lintChecked, setLintChecked] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [chat, setChat] = useState<ChatSession | null>(null);
  const selectedChatRef = useRef<ChatSession | null>(null);
  selectedChatRef.current = chat;
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(0);
  const [chatPending, setChatPending] = useState(false);
  const [chatDraftActive, setChatDraftActive] = useState(false);
  const [useChatContext, setUseChatContext] = useState(true);
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [selectedChatModelId, setSelectedChatModelId] = useState(SUMMARY_MODEL_ID);
  const chatModelExplicitRef = useRef(false);
  const [navigationStack, setNavigationStack] = useState<NavigationSnapshot[]>([]);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [issues, setIssues] = useState<LintIssue[]>([]);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [savedSettings, setSavedSettings] = useState<ProjectSettings | null>(null);
  const [clip, setClip] = useState({ title: "", url: "", content: "" });
  const [clipPending, setClipPending] = useState(false);
  const clipPendingRef = useRef(false);
  const [newProject, setNewProject] = useState({ name: "", description: "" });
  const [showCreateProjectForm, setShowCreateProjectForm] = useState(false);
  const [uploadTask, setUploadTask] = useState<UploadTaskState | null>(null);
  const [uploadActive, setUploadActive] = useState(false);
  const fileQueryRef = useRef(fileQuery);
  fileQueryRef.current = fileQuery;
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const previewPaneRef = useRef<HTMLElement | null>(null);
  const wasQueueRunningRef = useRef(false);
  const filePageRequestRef = useRef(0);
  const fileContentCacheRef = useRef(new Map<string, string>());
  const fileOpenRequestRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const refreshSignal = () => (refreshAbortRef.current ??= new AbortController()).signal;
  const chatRequestRef = useRef(0);
  const chatListRequestRef = useRef(0);
  const graphRequestRef = useRef(0);
  const graphLoadingRef = useRef(false);
  const mountedRef = useRef(true);
  const draftCacheRef = useRef(new Map<string, string>());
  const settingsBaselineRef = useRef("");
  const settingsRequestRef = useRef(0);
  const settingsDraftRef = useRef(settings);
  const settingsProjectRef = useRef(projectId);
  settingsDraftRef.current = settings;
  settingsProjectRef.current = projectId;
  const unsavedWorkRef = useRef(false);
  unsavedWorkRef.current = Boolean(draftCacheRef.current.size || (settings && JSON.stringify(settings) !== settingsBaselineRef.current) || clip.content.trim() || query.trim() || chatAttachments.length);
  const currentDocumentRef = useRef({ path: selectedPath, content: editor });
  currentDocumentRef.current = { path: selectedPath, content: editor };
  const completedQueueIdsRef = useRef<Set<string>>(new Set());
  const activityNoticeReadyRef = useRef(false);
  const uploadControlRef = useRef<{
    paused: boolean;
    cancelled: boolean;
    waiters: Array<() => void>;
  }>({ paused: false, cancelled: false, waiters: [] });

  const project = useMemo(() => projects.find((item) => item.id === projectId), [projects, projectId]);
  const archiveRunning = archiveProgress.some((item) => item.status === "extracting" || item.status === "registering");
  const running = queueIsRunning(queueStats) || Boolean(ingestProgress.active) || archiveRunning;
  const availableChatModels = useMemo(() => availableModelProfiles(savedSettings), [savedSettings]);
  const externalSearchConfigured = hasConfiguredWebSearch(savedSettings);

  useEffect(() => {
    const ids = new Set(availableChatModels.map((profile) => profile.id));
    setSelectedChatModelId((current) =>
      chatModelExplicitRef.current && (current === SUMMARY_MODEL_ID || ids.has(current))
        ? current
        : savedSettings?.activeModelId && ids.has(savedSettings.activeModelId)
          ? savedSettings.activeModelId
          : availableChatModels[0]?.id || SUMMARY_MODEL_ID
    );
  }, [availableChatModels, savedSettings?.activeModelId]);

  useEffect(() => { setPreviewOpen(false); }, [view]);
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 1180px)");
    if (!media) return;
    const update = () => setCompactPreview(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const pane = previewPaneRef.current;
    if (!previewModalOpen || !pane) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => [...pane.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    (focusable()[0] || pane).focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = focusable(), first = controls[0], last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); pane.focus(); return; }
      if (!pane.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [previewModalOpen]);
  useEffect(() => {
    if (!previewOpen) return;
    const closePreview = (event: KeyboardEvent) => { if (event.key === "Escape") setPreviewOpen(false); };
    window.addEventListener("keydown", closePreview);
    return () => window.removeEventListener("keydown", closePreview);
  }, [previewOpen]);

  const refreshProjectData = useCallback(async () => {
    if (!projectId || uploadAbortRef.current) return;
    const signal = refreshSignal();
    const result = await Promise.all([
      api.wikiFiles(projectId, { limit: WIKI_TREE_LIMIT, includeTotal: true, signal }),
      api.activity(projectId, { sourceLimit: SOURCE_LIST_LIMIT, queueLimit: 500, compact: true, signal })
    ]).catch((error) => { if (signal.aborted) return undefined; throw error; });
    if (!result || signal.aborted || !mountedRef.current || uploadAbortRef.current) return;
    const [wiki, activity] = result;
    fileContentCacheRef.current.clear();
    setWikiFiles(wiki.files);
    setWikiTotal(wiki.total ?? wiki.files.length);
    setWikiLimited(Boolean(wiki.limited));
    setSources(activity.sources);
    setSourceTotal(activity.sourceTotal ?? activity.sources.length);
    setSourceBytesTotal(activity.sourceBytesTotal ?? 0);
    setQueue(activity.queue);
    setQueueTotal(activity.queueTotal ?? activity.queue.length);
    const nextQueueStats = normalizeQueueStats(activity);
    setQueueStats(nextQueueStats);
    setSourceStats(normalizeSourceStats(activity));
    setIngestProgress(normalizeIngestProgress(activity, nextQueueStats));
    setArchiveProgress(activity.archiveProgress || []);
    completedQueueIdsRef.current = finishedQueueIds(activity.queue);
    activityNoticeReadyRef.current = true;
    wasQueueRunningRef.current = queueIsRunning(nextQueueStats);
    const document = { ...currentDocumentRef.current };
    const openRequest = fileOpenRequestRef.current;
    if (document.content && document.path.startsWith("wiki/") && !draftCacheRef.current.has(document.path)) {
      try {
        const latest = await api.fileContent(projectId, document.path, signal);
        if (!signal.aborted && !uploadAbortRef.current && mountedRef.current && openRequest === fileOpenRequestRef.current &&
            currentDocumentRef.current.path === document.path && currentDocumentRef.current.content === document.content &&
            !draftCacheRef.current.has(document.path)) {
          fileContentCacheRef.current.set(document.path, latest.content);
          setEditor(latest.content);
        }
      } catch (error) {
        if (!signal.aborted && mountedRef.current && openRequest === fileOpenRequestRef.current) setNotice(`列表已刷新，但当前文档未更新：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [projectId]);

  const loadFilePage = useCallback(async (offset: number, query: string) => {
    if (!projectId || uploadAbortRef.current) return;
    const signal = refreshSignal();
    const requestId = filePageRequestRef.current + 1;
    filePageRequestRef.current = requestId;
    const safeOffset = Math.max(0, offset);
    setFileLoading(true);
    try {
      const payload = await api.rawFiles(projectId, {
        limit: FILE_PAGE_SIZE,
        offset: safeOffset,
        query: query.trim(),
        compact: true, signal
      }).catch((error) => { if (signal.aborted) return undefined; throw error; });
      if (!payload || signal.aborted || requestId !== filePageRequestRef.current) return;
      if (!payload.files.length && (payload.total ?? 0) > 0 && safeOffset >= (payload.total ?? 0)) {
        const lastOffset = Math.max(0, Math.floor(((payload.total ?? 1) - 1) / FILE_PAGE_SIZE) * FILE_PAGE_SIZE);
        const lastPage = await api.rawFiles(projectId, {
          limit: FILE_PAGE_SIZE,
          offset: lastOffset,
          query: query.trim(),
          compact: true, signal
        }).catch((error) => { if (signal.aborted) return undefined; throw error; });
        if (!lastPage || signal.aborted || requestId !== filePageRequestRef.current) return;
        setFileSources(lastPage.files);
        setFileTotal(lastPage.total ?? lastPage.files.length);
        setFileOffset(lastPage.offset ?? lastOffset);
        return;
      }
      setFileSources(payload.files);
      setFileTotal(payload.total ?? payload.files.length);
      setFileOffset(payload.offset ?? safeOffset);
    } finally {
      if (requestId === filePageRequestRef.current) setFileLoading(false);
    }
  }, [projectId]);

  const loadFileContent = useCallback(async (path: string): Promise<string> => {
    if (!projectId) return "";
    const draft = draftCacheRef.current.get(path);
    if (draft !== undefined) return draft;
    const cached = fileContentCacheRef.current.get(path);
    if (cached !== undefined) return cached;
    const payload = await api.fileContent(projectId, path);
    fileContentCacheRef.current.set(path, payload.content);
    return payload.content;
  }, [projectId]);

  const pushNavigationSnapshot = useCallback(() => {
    const snapshot: NavigationSnapshot = { view, selectedPath };
    setNavigationStack((current) => {
      const last = current[current.length - 1];
      if (last?.view === snapshot.view && last.selectedPath === snapshot.selectedPath) return current;
      return [...current.slice(-24), snapshot];
    });
  }, [selectedPath, view]);

  const refreshChats = useCallback(async () => {
    if (!projectId) return;
    const requestId = ++chatListRequestRef.current;
    const [conversationResult, researchResult] = await Promise.allSettled([api.chats(projectId), api.researchTasks(projectId)]);
    if (!mountedRef.current || requestId !== chatListRequestRef.current) return;
    const conversations = conversationResult.status === "fulfilled" ? conversationResult.value.chats : undefined;
    const researchChats = researchResult.status === "fulfilled"
      ? researchResult.value.tasks.map((task) => researchTaskToChat(task, { role: "user", content: task.topic, createdAt: task.createdAt }, task.createdAt))
      : undefined;
    setChats((current) => [
      ...(researchChats ?? current.filter((item) => item.id.startsWith("research:"))),
      ...(conversations ?? current).filter((item) => !item.id.startsWith("research:"))
    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    if (conversations) setChat((current) => {
      if (!current || current.id.startsWith("research:")) return current;
      return conversations.find((item) => item.id === current.id) || current;
    });
    const failures = [conversationResult, researchResult].filter((result) => result.status === "rejected");
    if (failures.length) throw new Error(failures.map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason)).join("；"));
  }, [projectId]);

  const openFile = useCallback(
    async (path: string, options: { remember?: boolean } = {}) => {
      if (!projectId) return;
      if (/^https?:\/\//i.test(path)) {
        window.open(path, "_blank", "noopener,noreferrer");
        return;
      }
      const requestId = ++fileOpenRequestRef.current;
      setFileOpening(true);
      let content: string;
      try { content = await loadFileContent(path); }
      catch (error) {
        if (!mountedRef.current || requestId !== fileOpenRequestRef.current) return;
        throw error;
      }
      finally { if (requestId === fileOpenRequestRef.current) setFileOpening(false); }
      if (requestId !== fileOpenRequestRef.current) return;
      setPreviewDocumentPath(path);

      if (path.startsWith("raw/sources/")) {
        setPreview(content);
        setPreviewOpen(true);
        return;
      }

      const isWikiDocument = path.startsWith("wiki/");
      if (isWikiDocument && options.remember !== false && (view !== "wiki" || selectedPath !== path)) {
        pushNavigationSnapshot();
      }
      setSelectedPath(path);
      setEditor(content);
      setPreview(content);
      if (isWikiDocument) {
        setPreviewOpen(false);
        setEditorMode("edit");
        setView("wiki");
      }
    },
    [loadFileContent, projectId, pushNavigationSnapshot, selectedPath, view]
  );

  const previewFile = useCallback(async (path: string) => {
    if (!projectId) return;
    const requestId = ++fileOpenRequestRef.current;
    let content: string;
    try { content = await loadFileContent(path); }
    catch (error) {
      if (!mountedRef.current || requestId !== fileOpenRequestRef.current) return;
      throw error;
    }
    if (requestId !== fileOpenRequestRef.current) return;
    setPreviewDocumentPath(path);
    setPreview(content);
    setPreviewOpen(true);
  }, [loadFileContent, projectId]);

  useEffect(() => {
    refreshProjectData().catch((error) => setNotice(error.message));
    refreshChats().catch((error) => setNotice(error.message));
  }, [refreshProjectData, refreshChats]);

  useEffect(() => {
    if (view !== "files" || !projectId || uploadAbortRef.current) return;
    setFileLoading(true);
    const timer = window.setTimeout(() => {
      loadFilePage(0, fileQuery).catch((error) => setNotice(error.message));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [view, projectId, fileQuery, loadFilePage]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), notice.startsWith("上传中") ? 6500 : 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      chatRequestRef.current += 1;
      chatListRequestRef.current += 1;
      graphRequestRef.current += 1;
      fileOpenRequestRef.current += 1;
      settingsRequestRef.current += 1;
      uploadControlRef.current.cancelled = true;
      uploadControlRef.current.paused = false;
      uploadAbortRef.current?.abort();
      refreshAbortRef.current?.abort();
      wakeUploadWaiters();
    };
  }, []);

  useEffect(() => {
    const warnOnLeave = (event: BeforeUnloadEvent) => {
      if (unsavedWorkRef.current || uploadAbortRef.current) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warnOnLeave);
    return () => window.removeEventListener("beforeunload", warnOnLeave);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    filePageRequestRef.current += 1;
    setGraph(null);
    graphRequestRef.current += 1;
    graphLoadingRef.current = false;
    setIssues([]);
    settingsRequestRef.current += 1;
    settingsDraftRef.current = null;
    settingsBaselineRef.current = "";
    setSettings(null);
    setSavedSettings(null);
    setHits([]);
    setChat(null);
    setChats([]);
    setChatAttachments([]);
    setChatPending(false);
    setChatDraftActive(false);
    setNavigationStack([]);
    fileContentCacheRef.current.clear();
    setWikiTotal(0);
    setWikiLimited(false);
    setSources([]);
    setSourceTotal(0);
    setSourceBytesTotal(0);
    setFileSources([]);
    setFileTotal(0);
    setFileOffset(0);
    setFileQuery("");
    setFileLoading(false);
    setQueue([]);
    setQueueTotal(0);
    setQueueStats(EMPTY_QUEUE_STATS);
    setSourceStats(EMPTY_SOURCE_STATS);
    setIngestProgress(EMPTY_INGEST_PROGRESS);
    setArchiveProgress([]);
    setWikiFiles([]);
    setEditor("");
    setPreview("");
    completedQueueIdsRef.current = new Set();
    activityNoticeReadyRef.current = false;
    wasQueueRunningRef.current = false;
    openFile(selectedPath, { remember: false }).catch(() =>
      openFile("wiki/index.md", { remember: false }).catch((error) => setNotice(error.message))
    );
    loadSettings().catch((error) => setNotice(error.message));
  }, [projectId]);

  useEffect(() => {
    if (view !== "search" || chat || chatDraftActive || !chats.length) return;
    const latest = chats[0];
    setChat(latest);
    const lastAnswer = [...latest.messages].reverse().find((message) => message.role === "assistant");
    if (lastAnswer) setPreview(lastAnswer.content);
  }, [chat, chatDraftActive, chats, view]);

  const restoredResearchTask = chat?.messages.find((message) => message.researchTask)?.researchTask;
  useEffect(() => {
    if (uploadActive || view !== "search" || chatPending || !restoredResearchTask || !["queued", "running"].includes(restoredResearchTask.status)) return;
    let disposed = false;
    let checking = false;
    const selectedChatId = chat!.id;
    const timer = window.setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const { task } = await api.researchTask(projectId, restoredResearchTask.id);
        if (disposed) return;
        const nextChat = researchTaskToChat(task, chat!.messages[0], chat!.createdAt);
        setChats((current) => [nextChat, ...current.filter((item) => item.id !== selectedChatId)]);
        setChat((current) => current?.id === selectedChatId ? nextChat : current);
        setPreview(researchTaskPreview(task));
        if (task.status === "done") { setNotice(`研究笔记已保存到 ${task.result?.path || "Wiki"}`); void refreshProjectData().catch((error) => setNotice(error.message)); }
        if (task.status === "failed") setNotice(task.error || "深度研究失败。");
      } catch (error) { if (!disposed) setNotice(error instanceof Error ? error.message : String(error)); }
      finally { checking = false; }
    }, 1200);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [projectId, view, chat?.id, restoredResearchTask?.status, chatPending, refreshProjectData, uploadActive]);

  useEffect(() => {
    if (view !== "search" && chatDraftActive) setChatDraftActive(false);
  }, [chatDraftActive, view]);

  useEffect(() => {
    if (!projectId || uploadActive) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      // Leave network and disk activity to the entire upload batch, including
      // pauses. Resume automatic refresh after uploadFiles releases its controller.
      if (uploadAbortRef.current) return;
      const signal = refreshSignal();
      api.activity(projectId, { sourceLimit: SOURCE_LIST_LIMIT, queueLimit: 500, compact: true, signal })
        .then((activity) => {
          if (disposed || signal.aborted || uploadAbortRef.current) return;
          const nextQueueStats = normalizeQueueStats(activity);
          const isRunning = queueIsRunning(nextQueueStats);
          const previousCompleted = completedQueueIdsRef.current;
          const newlyFinished = activity.queue.filter(
            (item) => isFinishedQueueItem(item) && !previousCompleted.has(item.id)
          );
          const nextCompleted = new Set(previousCompleted);
          for (const item of activity.queue) {
            if (isFinishedQueueItem(item)) nextCompleted.add(item.id);
          }
          setQueue(activity.queue);
          setSources(activity.sources);
          setSourceTotal(activity.sourceTotal ?? activity.sources.length);
          setSourceBytesTotal(activity.sourceBytesTotal ?? 0);
          setQueueTotal(activity.queueTotal ?? activity.queue.length);
          setQueueStats(nextQueueStats);
          setSourceStats(normalizeSourceStats(activity));
          setIngestProgress(normalizeIngestProgress(activity, nextQueueStats));
          setArchiveProgress(activity.archiveProgress || []);
          if (activityNoticeReadyRef.current && newlyFinished.length) {
            const first = newlyFinished[0];
            const suffix = newlyFinished.length > 1 ? ` 等 ${newlyFinished.length} 个文件` : "";
            setNotice(`${first.status === "done" ? "已完成摄入" : "摄入失败"}：${queueItemTitle(first)}${suffix}`);
          }
          activityNoticeReadyRef.current = true;
          completedQueueIdsRef.current = nextCompleted;
          if (view === "files") {
            loadFilePage(fileOffset, fileQuery).catch(() => undefined);
          }
          if (wasQueueRunningRef.current && !isRunning) {
            refreshProjectData().catch(() => undefined);
          }
          wasQueueRunningRef.current = isRunning;
        })
        .catch((error) => {
          if (disposed || signal.aborted || uploadAbortRef.current) return;
          if (isNotFoundError(error)) {
            setNotice("当前知识库不存在或已被移除，已刷新知识库列表。");
            refreshProjects().catch(() => undefined);
          }
        });
    }, running ? 1600 : 30000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [projectId, refreshProjectData, running, view, fileOffset, fileQuery, loadFilePage, uploadActive]);

  useEffect(() => {
    if (view === "graph" && !graph && !graphLoadingRef.current) loadGraph();
    if (view === "settings" && !settings) loadSettings().catch((error) => setNotice(error.message));
  }, [view, projectId, graph, issues.length, settings]);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const name = newProject.name.trim();
    if (!name) {
      setNotice("请填写知识库名称。");
      return;
    }
    if (projectId && (unsavedWorkRef.current || uploadAbortRef.current) && !window.confirm("当前有未保存内容或正在上传的文件，新建并切换知识库将丢弃草稿并取消上传。继续创建？")) return;
    setBusy(true);
    try {
      const payload = await api.createProject({
        name,
        description: newProject.description.trim()
      });
      if (!mountedRef.current) return;
      onProjectCreated(payload.project);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrentFile() {
    if (!projectId || !selectedPath || fileOpening) return;
    const savedPath = selectedPath;
    const savedContent = editor;
    setBusy(true);
    try {
      await api.saveFile(projectId, selectedPath, editor);
      fileContentCacheRef.current.set(savedPath, savedContent);
      if (draftCacheRef.current.get(savedPath) === savedContent) draftCacheRef.current.delete(savedPath);
      if (currentDocumentRef.current.path === savedPath && currentDocumentRef.current.content === savedContent) setPreview(savedContent);
      try { await refreshProjectData(); }
      catch (error) { setNotice(`Markdown 已保存，但刷新列表失败：${error instanceof Error ? error.message : String(error)}`); return; }
      setNotice("Markdown 已保存。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function wakeUploadWaiters() {
    const waiters = uploadControlRef.current.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async function waitWhileUploadPaused() {
    if (!uploadControlRef.current.paused) return;
    await new Promise<void>((resolve) => {
      uploadControlRef.current.waiters.push(resolve);
    });
  }

  function pauseUpload() {
    uploadControlRef.current.paused = true;
    setUploadTask((current) =>
      current && current.status === "uploading"
        ? { ...current, status: "paused", detail: "已暂停，继续后会从下一分片开始上传。" }
        : current
    );
  }

  function resumeUpload() {
    uploadControlRef.current.paused = false;
    wakeUploadWaiters();
    setUploadTask((current) =>
      current && current.status === "paused"
        ? { ...current, status: "uploading", detail: "继续上传中。" }
        : current
    );
  }

  function cancelUpload() {
    uploadControlRef.current.cancelled = true;
    uploadControlRef.current.paused = false;
    wakeUploadWaiters();
    uploadAbortRef.current?.abort();
    setUploadTask((current) =>
      current && ["uploading", "paused"].includes(current.status)
        ? { ...current, status: "cancelling", detail: "正在取消当前上传请求。" }
        : current
    );
  }

  async function uploadFiles(files: FileList | File[] | null) {
    const selectedFiles = Array.from(files ?? []);
    if (!projectId || !selectedFiles.length) return;
    if (uploadAbortRef.current) {
      setNotice("已有上传任务正在进行，请先暂停或取消当前上传。");
      setView("files");
      return;
    }
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = null;
    setUploadActive(true);
    setNotice("");
    // Ignore an older list response and remove its loading strip immediately.
    filePageRequestRef.current += 1;
    setFileLoading(false);
    uploadControlRef.current = { paused: false, cancelled: false, waiters: [] };
    const totalBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    setUploadTask({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      status: "uploading",
      fileName: selectedFiles[0]?.name || "upload",
      detail: "准备上传。",
      totalFiles: selectedFiles.length,
      uploadedFiles: 0,
      totalBytes,
      uploadedBytes: 0,
      queued: 0,
      skipped: 0,
      startedAt: new Date().toISOString()
    });
    setView("files");
    setBusy(true);
    let uploaded = false;
    try {
      if (selectedFiles.length > 200) {
        setNotice(`准备分批上传 ${selectedFiles.length} 个文件，请保持页面打开。`);
      }
      const result = await api.uploadSources(projectId, selectedFiles, {
        signal: controller.signal,
        isCancelled: () => uploadControlRef.current.cancelled,
        waitWhilePaused: waitWhileUploadPaused,
        onProgress: (progress) => {
          setUploadTask((current) =>
            current
              ? {
                  ...current,
                  status: uploadControlRef.current.paused ? "paused" : "uploading",
                  fileName: progress.fileName || current.fileName,
                  detail: progress.detail || current.detail,
                  uploadedFiles: progress.uploadedFiles,
                  totalFiles: progress.totalFiles,
                  uploadedBytes: progress.uploadedBytes ?? current.uploadedBytes,
                  totalBytes: progress.totalBytes ?? current.totalBytes,
                  queued: progress.queued,
                  skipped: progress.skipped
                }
              : current
          );
        }
      });
      await api.resumeQueue(projectId).catch(() => undefined);
      uploaded = true;
      const archiveHint = result.archives?.length
        ? `，ZIP 解包 ${result.archives.reduce((sum, item) => sum + item.extracted, 0)} 个文件`
        : "";
      const batchHint = selectedFiles.length > 200 ? "已分批上传，" : "";
      setUploadTask((current) =>
        current
          ? {
              ...current,
              status: "done",
              detail: result.async
                ? result.message || "文件已上传，后台正在解包并自动摄入。"
                : "文件已自动进入摄入队列。",
              uploadedFiles: selectedFiles.length,
              uploadedBytes: totalBytes,
              queued: result.queued,
              skipped: result.skipped
            }
          : current
      );
      setNotice(
        result.async
          ? `${batchHint}${result.message || "文件已上传，后台正在解包并自动摄入。"}`
          : `${batchHint}文件已自动进入摄入队列：${result.queued} 个入队，${result.skipped} 个跳过${archiveHint}。`
      );
      setView("files");
    } catch (error) {
      const cancelled = uploadControlRef.current.cancelled || (error instanceof Error && error.name === "AbortError");
      const message = cancelled ? "上传已取消。" : error instanceof Error ? error.message : String(error);
      setUploadTask((current) =>
        current
          ? {
              ...current,
              status: cancelled ? "cancelled" : "error",
              detail: message,
              error: cancelled ? undefined : message
            }
          : current
      );
      setNotice(message);
    } finally {
      uploadAbortRef.current = null;
      uploadControlRef.current.paused = false;
      wakeUploadWaiters();
      try {
        if (mountedRef.current) {
          await refreshProjectData();
          await loadFilePage(0, fileQueryRef.current);
        }
      } catch (error) {
        if (mountedRef.current && uploaded) setNotice(`文件已上传，但刷新列表失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setUploadActive(false);
        setBusy(false);
      }
    }
  }

  async function deleteSource(source: SourceRecord) {
    if (!projectId) return;
    const confirmed = window.confirm(`移除文件「${source.fileName}」？`);
    if (!confirmed) return;
    setBusy(true);
    try {
      const nextOffset = fileSources.length <= 1 ? Math.max(0, fileOffset - FILE_PAGE_SIZE) : fileOffset;
      const payload = await api.deleteSource(projectId, source.id);
      await refreshProjectData();
      await loadFilePage(nextOffset, fileQuery);
      setNotice(payload.deleted ? "文件已移除。" : "文件记录不存在或已被移除。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(save = false) {
    const question = query.trim();
    if (!projectId || !question || chatPending) return;
    const attachments = chatAttachments;
    const previousChat = chat;
    const requestId = ++chatRequestRef.current;
    const chatId = chat && !/^(research:|research-pending-|pending-)/.test(chat.id) ? chat.id : undefined;
    const timestamp = new Date().toISOString();
    const optimisticUserMessage = {
      role: "user" as const,
      content: question,
      createdAt: timestamp,
      ...(attachments.length ? { attachments } : {})
    };
    const optimisticChat: ChatSession = chatId && chat
      ? {
          ...chat,
          updatedAt: timestamp,
          messages: [...chat.messages, optimisticUserMessage]
        }
      : {
          id: `pending-${timestamp}`,
          title: question.slice(0, 80),
          createdAt: timestamp,
          updatedAt: timestamp,
          messages: [optimisticUserMessage]
        };

    setChatDraftActive(false);
    setChat(optimisticChat);
    setQuery("");
    setChatAttachments([]);
    setHits([]);
    setChatPending(true);
    setBusy(true);
    try {
      const payload = await api.chat(projectId, {
        query: question,
        chatId,
        save,
        attachments,
        useHistory: useChatContext,
        webSearch: useWebSearch && externalSearchConfigured,
        modelId: selectedChatModelId
      });
      if (requestId !== chatRequestRef.current || !mountedRef.current) return;
      setHits(payload.hits);
      setChat(payload.chat);
      setChats((current) => [payload.chat, ...current.filter((item) => item.id !== payload.chat.id)]);
      setPreview(payload.answer);
      if (payload.savedPath) setNotice(`已保存到 ${payload.savedPath}`);
      try {
        if (payload.savedPath) await refreshProjectData();
        await refreshChats();
      } catch (error) {
        setNotice(`回答已生成，但刷新列表失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      if (requestId !== chatRequestRef.current || !mountedRef.current) return;
      setChat(previousChat);
      setChatDraftActive(!previousChat);
      setQuery((current) => current || question);
      setChatAttachments((current) => [...attachments, ...current.filter((item) => !attachments.some((previous) => previous.id === item.id))]);
      const message = error instanceof Error ? error.message : String(error);
      setNotice(formatChatFailureNotice(message));
    } finally {
      if (requestId === chatRequestRef.current) setChatPending(false);
      setBusy(false);
    }
  }

  async function loadGraph() {
    if (!projectId) return;
    const requestId = ++graphRequestRef.current;
    if (!graphLoadingRef.current) setBusy(true);
    graphLoadingRef.current = true;
    try {
      const result = await api.graph(projectId);
      if (mountedRef.current && requestId === graphRequestRef.current) setGraph(result);
    } catch (error) {
      if (mountedRef.current && requestId === graphRequestRef.current) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === graphRequestRef.current) {
        graphLoadingRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    }
  }

  async function runLint() {
    if (!projectId) return;
    setBusy(true);
    try {
      const payload = await api.lint(projectId);
      setIssues(payload.issues);
      setLintChecked(true);
      setNotice(`知识库体检完成：${payload.issues.length} 个问题。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runResearch() {
    const topic = query.trim();
    if (!projectId || !topic || chatPending || attachmentsLoading) return;
    if (chatAttachments.length) { setNotice("深研检索已摄入的知识库材料；本轮附件请使用提问，或先在文件页上传后深研。"); return; }
    const requestId = ++chatRequestRef.current;
    const previousChat = chat;
    const previousPreview = preview;
    const timestamp = new Date().toISOString();
    const userMessage = {
      role: "user" as const,
      content: `深度研究：${topic}`,
      createdAt: timestamp
    };
    const pendingChat: ChatSession = {
      id: `research-pending-${timestamp}`,
      title: topic,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [userMessage]
    };
    setChatDraftActive(false);
    setChat(pendingChat);
    setQuery("");
    setChatAttachments([]);
    setHits([]);
    setPreview("");
    setView("search");
    setChatPending(true);
    setBusy(true);
    try {
      const created = await api.research(projectId, { topic, modelId: selectedChatModelId });
      if (!mountedRef.current) return;
      const createdChat = researchTaskToChat(created.task, userMessage, timestamp);
      if (requestId === chatRequestRef.current) setChat(createdChat);
      setChats((current) => [createdChat, ...current.filter((item) => item.id !== createdChat.id)]);
      if (requestId === chatRequestRef.current) setPreview(researchTaskPreview(created.task));
      const current = created.task;
      if (current.status === "done" && current.result) {
        setNotice(`研究笔记已保存到 ${current.result.path}`);
      } else if (current.status === "failed") {
        setNotice(current.error || "深度研究失败。");
      }
      if (current.status === "done" || current.status === "failed") {
        try { await refreshProjectData(); await refreshChats(); }
        catch (error) { setNotice(`研究任务已创建，但刷新列表失败：${error instanceof Error ? error.message : String(error)}`); }
      }
    } catch (error) {
      if (!mountedRef.current || requestId !== chatRequestRef.current) return;
      setChat(previousChat);
      setChatDraftActive(!previousChat);
      setQuery((current) => current || topic);
      setPreview(previousPreview);
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === chatRequestRef.current) setChatPending(false);
      setBusy(false);
    }
  }

  async function loadSettings() {
    if (!projectId || !mountedRef.current) return;
    const draft = JSON.stringify(settingsDraftRef.current);
    if (settingsDraftRef.current && draft !== settingsBaselineRef.current && !window.confirm("当前设置尚未保存，重载将丢弃这些修改。继续重载？")) return;
    const requestedProject = projectId;
    const requestId = ++settingsRequestRef.current;
    const isCurrent = () => mountedRef.current && settingsProjectRef.current === requestedProject &&
      settingsRequestRef.current === requestId && JSON.stringify(settingsDraftRef.current) === draft;
    try {
      const payload = await api.settings(requestedProject);
      if (!isCurrent()) return;
      settingsBaselineRef.current = JSON.stringify(payload.settings);
      settingsDraftRef.current = payload.settings;
      setSettings(payload.settings);
      setSavedSettings(payload.settings);
    } catch (error) {
      if (isCurrent()) throw error;
    }
  }

  async function saveSettings() {
    const draft = settingsDraftRef.current;
    if (!projectId || !draft || !mountedRef.current) return;
    const requestedProject = projectId;
    const requestId = ++settingsRequestRef.current;
    const isCurrent = () => mountedRef.current && settingsProjectRef.current === requestedProject && settingsRequestRef.current === requestId;
    setBusy(true);
    const submitted = JSON.stringify(draft);
    try {
      const payload = await api.saveSettings(requestedProject, draft);
      if (!isCurrent()) return;
      settingsBaselineRef.current = JSON.stringify(payload.settings);
      setSavedSettings(payload.settings);
      if (JSON.stringify(settingsDraftRef.current) === submitted) {
        settingsDraftRef.current = payload.settings;
        setSettings(payload.settings);
      }
      setNotice("设置已保存。");
    } catch (error) {
      if (isCurrent()) setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (mountedRef.current && settingsProjectRef.current === requestedProject) setBusy(false);
    }
  }

  async function submitClip(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !clip.content.trim() || clipPendingRef.current) return;
    const submitted = clip;
    clipPendingRef.current = true;
    setClipPending(true);
    setBusy(true);
    try {
      await api.clip(projectId, submitted);
      setClip((current) => JSON.stringify(current) === JSON.stringify(submitted) ? { title: "", url: "", content: "" } : current);
      try { await refreshProjectData(); }
      catch (error) { setNotice(`剪藏已入队，但刷新列表失败：${error instanceof Error ? error.message : String(error)}`); return; }
      setNotice("网页剪藏已进入摄入队列。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      clipPendingRef.current = false;
      setClipPending(false);
      setBusy(false);
    }
  }

  function setEditorContent(value: string) {
    setPreviewDocumentPath(selectedPath);
    draftCacheRef.current.set(selectedPath, value);
    setEditor(value);
    setPreview(value);
  }

  async function addChatFiles(files: FileList | File[] | null) {
    if (attachmentsLoading) { setNotice("正在解析附件，请稍候再添加。"); return; }
    const selected = Array.from(files ?? []);
    if (!selected.length) return;
    const requestId = chatRequestRef.current;
    setAttachmentsLoading((current) => current + 1);
    try {
      const remaining = Math.max(0, CHAT_ATTACHMENT_LIMIT - chatAttachments.length);
      const attachments = await Promise.all(selected.slice(0, remaining).map(async (file) => {
        const result = await fileToChatAttachment(file, projectId);
        if (result.warning && requestId === chatRequestRef.current) setNotice(result.warning);
        return result.attachment;
      }));
      if (!mountedRef.current || requestId !== chatRequestRef.current) return;
      if (new Blob([JSON.stringify([...chatAttachments, ...attachments])]).size > 18 * 1024 * 1024) throw new Error("本轮附件总大小超过请求限制，请减少图片数量或压缩图片后重试。");
      setChatAttachments((current) => [...current, ...attachments].slice(0, CHAT_ATTACHMENT_LIMIT));
      if (selected.length > remaining) setNotice(`一次最多附加 ${CHAT_ATTACHMENT_LIMIT} 个文件。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally { setAttachmentsLoading((current) => Math.max(0, current - 1)); }
  }

  function removeChatAttachment(id: string) {
    setChatAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function selectChat(nextChat: ChatSession) {
    if (chat?.id === nextChat.id) return;
    if ((query.trim() || chatAttachments.length) && !window.confirm("当前问题或附件尚未发送，切换会话将丢弃这些输入。继续切换？")) return;
    chatRequestRef.current += 1;
    setChat(nextChat);
    setChatDraftActive(false);
    setHits([]);
    setQuery("");
    setChatAttachments([]);
    setChatPending(false);
    const lastAnswer = [...nextChat.messages].reverse().find((message) => message.role === "assistant");
    if (lastAnswer) setPreview(lastAnswer.researchTask ? researchTaskPreview(lastAnswer.researchTask) : lastAnswer.content);
    setView("search");
  }

  async function deleteChatSession(nextChat: ChatSession) {
    if (!projectId || nextChat.id.startsWith("pending-")) return;
    const confirmed = window.confirm(`删除会话「${nextChat.title || "未命名会话"}」？`);
    if (!confirmed) return;
    setBusy(true);
    try {
      const payload = nextChat.id.startsWith("research:")
        ? await api.deleteResearchTask(projectId, nextChat.id.slice("research:".length))
        : await api.deleteChat(projectId, nextChat.id);
      setChats((current) => current.filter((item) => item.id !== nextChat.id));
      if (selectedChatRef.current?.id === nextChat.id) {
        chatRequestRef.current += 1;
        setChat(null);
        setChatDraftActive(true);
        setHits([]);
        setQuery("");
        setChatAttachments([]);
        setChatPending(false);
        setPreview("");
      }
      await refreshChats();
      setNotice(payload.deleted ? "会话已删除。" : "会话不存在或已被删除。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function startNewChat() {
    if ((query.trim() || chatAttachments.length) && !window.confirm("当前问题或附件尚未发送，新建会话将丢弃这些输入。继续新建？")) return;
    chatRequestRef.current += 1;
    setChat(null);
    setChatDraftActive(true);
    setHits([]);
    setQuery("");
    setChatAttachments([]);
    setChatPending(false);
    setPreview("");
    setView("search");
  }

  function goBack() {
    const target = navigationStack[navigationStack.length - 1];
    if (!target) return;
    setNavigationStack((current) => current.slice(0, -1));
    setView(target.view);
    if (target.view === "wiki" && target.selectedPath) {
      openFile(target.selectedPath, { remember: false }).catch((error) => handleFileOpenError(error, target.selectedPath));
      return;
    }
    if (target.view === "search") {
      const lastAnswer = chat
        ? [...chat.messages].reverse().find((message) => message.role === "assistant")
        : undefined;
      if (lastAnswer) setPreview(lastAnswer.content);
    }
  }

  function openFileSafely(path: string, options: { remember?: boolean } = {}) {
    void openFile(path, options).catch((error) => handleFileOpenError(error, path));
  }

  function previewFileSafely(path: string) {
    void previewFile(path).catch((error) => handleFileOpenError(error, path));
  }

  function handleFileOpenError(error: unknown, path: string) {
    const message = error instanceof Error ? error.message : String(error);
    fileContentCacheRef.current.delete(path);
    setNotice(message);
    setPreview(["# 无法打开文件", "", message, "", "请刷新列表、重新扫描来源，或确认该文件没有被移动/删除。"].join("\n"));
    refreshProjectData().catch(() => undefined);
    if (view === "files") {
      loadFilePage(fileOffset, fileQuery).catch(() => undefined);
    }
  }

  function insertMarkdown(kind: "h1" | "h2" | "bold" | "italic" | "list" | "link" | "code" | "table") {
    const textarea = editorRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = editor.slice(start, end);
    const replacements: Record<typeof kind, string> = {
      h1: `# ${selected || "标题"}`,
      h2: `## ${selected || "小节"}`,
      bold: `**${selected || "重点"}**`,
      italic: `*${selected || "强调"}*`,
      list: selected ? selected.split("\n").map((line) => `- ${line}`).join("\n") : "- 列表项",
      link: `[${selected || "链接文字"}](https://)`,
      code: selected.includes("\n") ? `\`\`\`\n${selected}\n\`\`\`` : `\`${selected || "code"}\``,
      table: "\n| 列一 | 列二 |\n| --- | --- |\n| 内容 | 说明 |\n"
    };
    const replacement = replacements[kind];
    const next = `${editor.slice(0, start)}${replacement}${editor.slice(end)}`;
    setEditorContent(next);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start, start + replacement.length);
    });
  }

  const workspaceHeading =
    view === "wiki"
      ? selectedPath || "工作台"
      : view === "search"
        ? chat?.title || "新会话"
        : viewTitle(view);
  const previewSourceContent = view === "wiki" ? editor : preview;
  const previewContent = useMemo(() => clampPreviewContent(previewSourceContent), [previewSourceContent]);
  const selectedPathEditable = isEditableWikiPath(selectedPath);

  if (!projectId && projects.length === 0) {
    return (
      <main className="empty-state">
        <form className="create-panel" onSubmit={createProject}>
          <div className="brand-mark">
            <Database size={28} />
          </div>
          <h1>LLM Wiki Web</h1>
          <label>
            名称
            <input value={newProject.name} placeholder="输入知识库名称" onChange={(event) => setNewProject({ ...newProject, name: event.target.value })} />
          </label>
          <label>
            用途
            <textarea
              rows={4}
              value={newProject.description}
              onChange={(event) => setNewProject({ ...newProject, description: event.target.value })}
            />
          </label>
          <button className="primary" type="submit" disabled={busy || !newProject.name.trim()}>
            <FolderPlus size={18} />
            创建知识库
          </button>
          {notice && <p role="alert">{notice}</p>}
        </form>
      </main>
    );
  }

  return (
    <div className={`app-shell${view === "settings" ? " settings-open" : ""}`}>
      <aside className="rail" aria-label="主功能" inert={previewModalOpen}>
        <div className="rail-logo" title="LLM Wiki">
          <GitBranch size={24} />
        </div>
        {VIEWS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              className={view === item.key ? "active" : ""}
              title={item.label}
              onClick={() => setView(item.key)}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </aside>

      <aside className="sidebar" inert={previewModalOpen}>
        <div className="project-bar">
          <select aria-label="当前知识库" value={projectId} onChange={(event) => {
            if ((unsavedWorkRef.current || uploadAbortRef.current) && !window.confirm("当前有未保存的文档、设置、输入或正在上传的文件，切换知识库将丢弃草稿并取消上传。继续切换？")) return;
            setProjectId(event.target.value);
          }}>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button
            className="new-project-button"
            title="新建知识库"
            type="button"
            onClick={() => setShowCreateProjectForm((current) => !current)}
          >
            <Plus size={16} />
            <span>新建</span>
          </button>
          <button title="刷新" disabled={Boolean(uploadAbortRef.current)} onClick={() => refreshProjectData().catch((error) => setNotice(error.message))}>
            <RefreshCw size={18} />
          </button>
        </div>
        <div className="project-meta">
          <strong>{project?.name}</strong>
          <span>{project?.description || "本地 Markdown 知识库"}</span>
          <small className="project-id">ID: {projectId}</small>
        </div>
        {showCreateProjectForm && (
          <form className="sidebar-create-panel" onSubmit={createProject}>
            <label>
              名称
              <input
                autoFocus
                value={newProject.name}
                placeholder="例如：合同知识库"
                onChange={(event) => setNewProject({ ...newProject, name: event.target.value })}
              />
            </label>
            <label>
              用途
              <textarea
                rows={3}
                value={newProject.description}
                placeholder="描述这个知识库的用途"
                onChange={(event) => setNewProject({ ...newProject, description: event.target.value })}
              />
            </label>
            <div className="sidebar-create-actions">
              <button className="primary" type="submit" disabled={busy || !newProject.name.trim()}>
                <FolderPlus size={16} />
                创建
              </button>
              <button type="button" onClick={() => setShowCreateProjectForm(false)}>
                取消
              </button>
            </div>
          </form>
        )}
        <div className="status-strip">
          <span className={running ? "pulse" : ""}>{running ? "摄入中" : "空闲"}</span>
          <span title={`共有 ${sourceTotal} 份来源`}>{sourceTotal.toLocaleString("zh-CN")} 来源</span>
          <span title={wikiLimited ? `已加载 ${wikiTotal} 页，目录超过加载上限` : `共有 ${wikiTotal} 个页面`}>{wikiTotal.toLocaleString("zh-CN")}{wikiLimited ? " 页（部分）" : " 页面"}</span>
        </div>
        <FileTree
          files={wikiFiles}
          selectedPath={selectedPath}
          onOpen={(path) => openFileSafely(path, { remember: false })}
        />
      </aside>

      <main className="workspace" inert={previewModalOpen}>
        <header className="workspace-header">
          <div>
            <p>{viewTitle(view)}</p>
            <h2>{workspaceHeading}</h2>
          </div>
          <div className="actions">
            <button className="compact-preview-button" type="button" title="查看预览" onClick={() => setPreviewOpen(true)}><Eye size={17} /></button>
            {navigationStack.length > 0 && (
              <button className="back-button" type="button" onClick={goBack} title="返回上一页">
                <ArrowLeft size={17} />
                返回
              </button>
            )}
            {view === "wiki" && selectedPathEditable && (
              <button className="primary" onClick={saveCurrentFile} disabled={busy || fileOpening}>
                <Save size={18} />
                保存
              </button>
            )}
            {busy && <Loader2 className="spin" size={18} />}
          </div>
        </header>
        {notice && (
          <div className="notice" role="status" aria-live="polite">
            <span>{notice}</span>
            <button title="关闭" onClick={() => setNotice("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {renderWorkspace()}
      </main>

      <aside ref={previewPaneRef} className={`preview-pane${previewOpen ? " preview-open" : ""}`} role={previewModalOpen ? "dialog" : undefined} aria-modal={previewModalOpen ? true : undefined} aria-label={previewModalOpen ? "文档预览" : "预览和回答"} tabIndex={previewModalOpen ? -1 : undefined}>
        <div className="pane-title">
          <FileText size={17} />
          <span>预览 / 回答</span>
          <button className="compact-preview-button" type="button" title="关闭预览" onClick={() => setPreviewOpen(false)}><X size={17} /></button>
        </div>
        <MarkdownPane content={previewContent} projectId={projectId} documentPath={view === "wiki" ? selectedPath : view === "files" ? previewDocumentPath : undefined} files={wikiFiles} onOpen={openFileSafely} />
      </aside>
    </div>
  );

  function renderWorkspace() {
    switch (view) {
      case "wiki":
        return (
          <MarkdownEditor
            value={editor}
            mode={editorMode}
            textareaRef={editorRef}
            onChange={setEditorContent}
            onModeChange={setEditorMode}
            onFormat={insertMarkdown}
            readOnly={!selectedPathEditable || fileOpening}
            projectId={projectId}
            documentPath={selectedPath}
            files={wikiFiles}
            onOpen={openFileSafely}
          />
        );
      case "files":
        return (
          <FilesView
            sources={fileSources}
            queue={queue}
            sourceTotal={sourceTotal}
            sourceBytesTotal={sourceBytesTotal}
            queueStats={queueStats}
            sourceStats={sourceStats}
            ingestProgress={ingestProgress}
            archiveProgress={archiveProgress}
            fileTotal={fileTotal}
            fileOffset={fileOffset}
            filePageSize={FILE_PAGE_SIZE}
            fileQuery={fileQuery}
            loading={fileLoading}
            queueTotal={queueTotal}
            uploadTask={uploadTask}
            onQueryChange={setFileQuery}
            onPageChange={(offset) => {
              loadFilePage(offset, fileQuery).catch((error) => setNotice(error.message));
            }}
            onUpload={uploadFiles}
            onPauseUpload={pauseUpload}
            onResumeUpload={resumeUpload}
            onCancelUpload={cancelUpload}
            onRescan={async () => {
              if (!projectId) return;
              try {
                const result = await api.rescan(projectId);
                await refreshProjectData();
                await loadFilePage(0, fileQuery);
                setNotice(`扫描完成：${result.total} 个文件，${result.queued} 个入队。`);
              } catch (error) {
                setNotice(error instanceof Error ? error.message : String(error));
              }
            }}
            onRefresh={async () => {
              try {
                await refreshProjectData();
                await loadFilePage(fileOffset, fileQuery);
              } catch (error) {
                setNotice(error instanceof Error ? error.message : String(error));
              }
            }}
            onOpen={(path) => openFileSafely(path)}
            onPreview={previewFileSafely}
            onDelete={deleteSource}
          />
        );
      case "sources":
        return (
          <ClipSourceView
            clip={clip}
            setClip={setClip}
            pending={clipPending}
            onSubmitClip={submitClip}
          />
        );
      case "search":
        return (
          <AskView
            projectId={projectId}
            wikiFiles={wikiFiles}
            query={query}
            setQuery={setQuery}
            hits={hits}
            chat={chat}
            chats={chats}
            attachments={chatAttachments}
            busy={busy || attachmentsLoading > 0}
            pending={chatPending}
            useChatContext={useChatContext}
            useWebSearch={useWebSearch && externalSearchConfigured}
            externalSearchConfigured={externalSearchConfigured}
            modelProfiles={availableChatModels}
            selectedModelId={selectedChatModelId}
            onToggleContext={setUseChatContext}
            onToggleWebSearch={setUseWebSearch}
            onSelectModel={(id) => { chatModelExplicitRef.current = true; setSelectedChatModelId(id); }}
            onAsk={() => runSearch(false)}
            onResearch={runResearch}
            onNewChat={startNewChat}
            onSelectChat={selectChat}
            onDeleteChat={deleteChatSession}
            onAttachFiles={addChatFiles}
            onRemoveAttachment={removeChatAttachment}
            onOpen={(path) => openFileSafely(path)}
          />
        );
      case "graph":
        return <GraphView graph={graph} onReload={() => void loadGraph().catch((error) => setNotice(error.message))} onOpen={(path) => openFileSafely(path)} />;
      case "lint":
        return <LintView issues={issues} checked={lintChecked} busy={busy} onRun={runLint} onOpen={(path) => openFileSafely(path)} />;
      case "settings":
        return <SettingsView key={projectId} projectId={projectId} busy={busy} settings={settings} setSettings={(next) => { settingsDraftRef.current = next; setSettings(next); }} onReload={() => void loadSettings().catch((error) => setNotice(error.message))} onSave={saveSettings} />;
      default:
        return null;
    }
  }
}

function MarkdownPane(props: import("./components/MarkdownView").MarkdownViewProps) {
  return (
    <Suspense fallback={<article className="markdown">正在加载预览...</article>}>
      <MarkdownView {...props} />
    </Suspense>
  );
}

function MarkdownEditor({
  value,
  mode,
  textareaRef,
  onChange,
  onModeChange,
  onFormat,
  readOnly,
  ...previewProps
}: {
  value: string;
  mode: EditorMode;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onModeChange: (mode: EditorMode) => void;
  onFormat: (kind: "h1" | "h2" | "bold" | "italic" | "list" | "link" | "code" | "table") => void;
  readOnly: boolean;
  projectId: string;
  documentPath: string;
  files: WikiFile[];
  onOpen: (path: string) => void;
}) {
  return (
    <section className="editor-workbench">
      <div className="editor-toolbar">
        <div className="tool-group">
          <button title="一级标题" disabled={readOnly} onClick={() => onFormat("h1")}>
            <Heading1 size={17} />
          </button>
          <button title="二级标题" disabled={readOnly} onClick={() => onFormat("h2")}>
            <Heading2 size={17} />
          </button>
          <button title="加粗" disabled={readOnly} onClick={() => onFormat("bold")}>
            <Bold size={17} />
          </button>
          <button title="斜体" disabled={readOnly} onClick={() => onFormat("italic")}>
            <Italic size={17} />
          </button>
          <button title="列表" disabled={readOnly} onClick={() => onFormat("list")}>
            <List size={17} />
          </button>
          <button title="链接" disabled={readOnly} onClick={() => onFormat("link")}>
            <Link size={17} />
          </button>
          <button title="代码" disabled={readOnly} onClick={() => onFormat("code")}>
            <Code2 size={17} />
          </button>
          <button title="表格" disabled={readOnly} onClick={() => onFormat("table")}>
            <Table2 size={17} />
          </button>
        </div>
        <div className="segmented" aria-label="编辑模式">
          <button className={mode === "edit" ? "active" : ""} title="只编辑" onClick={() => onModeChange("edit")}>
            <Pencil size={17} />
          </button>
          <button className={mode === "split" ? "active" : ""} title="左右分栏" onClick={() => onModeChange("split")}>
            <SplitSquareHorizontal size={17} />
          </button>
          <button className={mode === "preview" ? "active" : ""} title="只预览" onClick={() => onModeChange("preview")}>
            <Eye size={17} />
          </button>
        </div>
      </div>
      {readOnly && <div className="read-only-note">只读查看：原始文件不会在这里被修改。</div>}
      <div className={`editor-grid mode-${mode}`}>
        {mode !== "preview" && (
          <textarea
            ref={textareaRef}
            aria-label="Markdown 正文"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            readOnly={readOnly}
            spellCheck={false}
          />
        )}
        {mode !== "edit" && (
          <div className="embedded-preview">
            <MarkdownPane content={clampPreviewContent(value)} {...previewProps} />
          </div>
        )}
      </div>
    </section>
  );
}

function FileTree({
  files,
  selectedPath,
  onOpen
}: {
  files: WikiFile[];
  selectedPath: string;
  onOpen: (path: string) => void;
}) {
  const grouped = files.reduce<Record<string, WikiFile[]>>((acc, file) => {
    const section = file.path.split("/").length > 2 ? file.path.split("/")[1] : "root";
    acc[section] = [...(acc[section] || []), file];
    return acc;
  }, {});

  return (
    <nav className="file-tree">
      {Object.entries(grouped).map(([section, sectionFiles]) => (
        <div key={section} className="tree-section">
          <h3>{fileTreeSectionLabel(section)}</h3>
          {sectionFiles.slice(0, TREE_SECTION_LIMIT).map((file) => (
            <button
              key={file.path}
              className={selectedPath === file.path ? "selected" : ""}
              onClick={() => onOpen(file.path)}
              title={file.path}
            >
              <FileText size={15} />
              <span>{file.title}</span>
            </button>
          ))}
          {sectionFiles.length > TREE_SECTION_LIMIT && (
            <p className="tree-more">已显示前 {TREE_SECTION_LIMIT} 个，共 {sectionFiles.length} 个。</p>
          )}
        </div>
      ))}
    </nav>
  );
}

function FilesView({
  sources,
  queue,
  sourceTotal,
  sourceBytesTotal,
  queueStats,
  sourceStats,
  ingestProgress,
  archiveProgress,
  fileTotal,
  fileOffset,
  filePageSize,
  fileQuery,
  loading,
  queueTotal,
  uploadTask,
  onQueryChange,
  onPageChange,
  onUpload,
  onPauseUpload,
  onResumeUpload,
  onCancelUpload,
  onRescan,
  onRefresh,
  onOpen,
  onPreview,
  onDelete
}: {
  sources: SourceRecord[];
  queue: QueueItem[];
  sourceTotal: number;
  sourceBytesTotal: number;
  queueStats: QueueStats;
  sourceStats: SourceStats;
  ingestProgress: IngestProgress;
  archiveProgress: ArchiveImportProgress[];
  fileTotal: number;
  fileOffset: number;
  filePageSize: number;
  fileQuery: string;
  loading: boolean;
  queueTotal: number;
  uploadTask: UploadTaskState | null;
  onQueryChange: (query: string) => void;
  onPageChange: (offset: number) => void;
  onUpload: (files: FileList | File[] | null) => void;
  onPauseUpload: () => void;
  onResumeUpload: () => void;
  onCancelUpload: () => void;
  onRescan: () => void;
  onRefresh: () => void;
  onOpen: (path: string) => void;
  onPreview: (path: string) => void;
  onDelete: (source: SourceRecord) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploading = Boolean(uploadTask && ["uploading", "paused", "cancelling"].includes(uploadTask.status));
  const activeQueueCount = queueStats.queued + queueStats.running;
  const queueProgress = ingestProgress.total > 0 ? ingestProgress.percent : 0;
  const currentIngestItem = ingestProgress.active;
  const nextIngestItem = ingestProgress.next;
  const visibleSources = sources;
  const visibleIds = visibleSources.map((source) => source.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const pageStart = fileTotal > 0 ? fileOffset + 1 : 0;
  const pageEnd = Math.min(fileOffset + visibleSources.length, fileTotal);
  const currentPage = fileTotal > 0 ? Math.floor(fileOffset / filePageSize) + 1 : 0;
  const pageCount = fileTotal > 0 ? Math.ceil(fileTotal / filePageSize) : 0;
  const canPrev = fileOffset > 0;
  const canNext = fileOffset + visibleSources.length < fileTotal;
  const visibleQueue = queue;

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => visibleIds.includes(id)));
  }, [visibleIds.join("|")]);

  function toggleAllVisible() {
    setSelectedIds((current) =>
      allVisibleSelected
        ? current.filter((id) => !visibleIds.includes(id))
        : [...new Set([...current, ...visibleIds])]
    );
  }

  function toggleOne(id: string) {
    setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  return (
    <section className="file-manager">
      <div className="file-manager-toolbar">
        <div className="file-actions">
          <button className="primary" type="button" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
            <Upload size={17} />
            上传
          </button>
          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            multiple
            accept=".doc,.docx,.ppt,.pptx,.xls,.xlsx,.pdf,.zip,.md,.markdown,.txt,.html,.htm,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.log,image/*"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              onUpload(files);
            }}
          />
          <button type="button" disabled={uploading} onClick={onRescan}>
            <RefreshCw size={17} />
            扫描
          </button>
          <button type="button" disabled={uploading} onClick={onRefresh}>
            <RefreshCw size={17} />
            刷新
          </button>
          {selectedIds.length > 0 && <span className="selected-count">已选 {selectedIds.length}</span>}
        </div>
        <div className="file-search">
          <input
            placeholder="搜索文件名、路径、类型或状态"
            aria-label="搜索知识库文件"
            value={fileQuery}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <Search size={17} />
        </div>
      </div>

      <div className="format-strip file-format-strip">{FORMAT_HINT}</div>

      <UploadProgressPanel
        task={uploadTask}
        onPause={onPauseUpload}
        onResume={onResumeUpload}
        onCancel={onCancelUpload}
      />

      <ArchiveProgressPanel items={archiveProgress} />

      {loading && !uploading && (
        <div className="file-loading-strip" role="status" aria-live="polite">
          <Loader2 size={16} />
          <span>正在刷新文件列表和摄入状态...</span>
          <div className="file-loading-track"><span /></div>
        </div>
      )}

      {(ingestProgress.total > 0 || uploadTask?.status === "done") && (
        <section className={`ingest-live-panel ${currentIngestItem ? "running" : ""}`} aria-live="polite">
          <div className="ingest-live-heading">
            <div>
              <h3>{currentIngestItem ? "正在摄入" : ingestProgress.queued > 0 ? "等待摄入" : "摄入进度"}</h3>
              <p>
                {ingestProgress.total > 0
                  ? `已处理 ${ingestProgress.processed} / ${ingestProgress.total} 个文件`
                  : "压缩包正在后台解包并登记，登记完成后会显示真实摄入进度。"}
              </p>
            </div>
            {ingestProgress.total > 0 && <strong>{queueProgress}%</strong>}
          </div>
          {ingestProgress.total > 0 ? (
            <>
              <div className="ingest-live-track" aria-label="真实摄入进度">
                <span style={{ width: `${queueProgress}%` }} />
              </div>
              <div className="ingest-live-grid">
                <span>完成 {ingestProgress.done}</span>
                <span>失败 {ingestProgress.failed}</span>
                <span>正在摄入 {ingestProgress.running}</span>
                <span>排队 {ingestProgress.queued}</span>
              </div>
              {currentIngestItem ? (
                <div className="ingest-current-file">
                  <Loader2 size={16} />
                  <span>
                    <strong>{currentIngestItem.title || currentIngestItem.fileName}</strong>
                    <small>
                      第 {ingestProgress.currentIndex} / {ingestProgress.total} 个 · {currentIngestItem.relativePath}
                    </small>
                  </span>
                </div>
              ) : nextIngestItem ? (
                <div className="ingest-current-file queued">
                  <Loader2 size={16} />
                  <span>
                    <strong>下一个文件：{nextIngestItem.title || nextIngestItem.fileName}</strong>
                    <small>{nextIngestItem.relativePath}</small>
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="ingest-current-file queued">
              <Loader2 size={16} />
              <span>
                <strong>后台正在准备文件</strong>
                <small>当前阶段没有可靠百分比，文件登记到队列后会自动切换为真实进度条。</small>
              </span>
            </div>
          )}
        </section>
      )}

      <div className="file-manager-stats">
        <div>
          <strong>{sourceTotal}</strong>
          <span>全部来源</span>
        </div>
        <div>
          <strong>{fileTotal}</strong>
          <span>{fileQuery.trim() ? "筛选结果" : "当前列表"}</span>
        </div>
        <div>
          <strong>{activeQueueCount}</strong>
          <span>待处理</span>
        </div>
        <div>
          <strong>{sourceStats.ready}</strong>
          <span>可用文件</span>
        </div>
        <div>
          <strong>{formatBytes(sourceBytesTotal)}</strong>
          <span>已登记大小</span>
        </div>
      </div>

      <div className="file-table-card">
        <table className="file-table">
          <thead>
            <tr>
              <th className="check-column">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} />
              </th>
              <th>名称</th>
              <th>状态</th>
              <th>类型</th>
              <th>大小</th>
              <th>更新时间</th>
              <th>路径</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visibleSources.map((source) => (
              <tr key={source.id}>
                <td className="check-column">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(source.id)}
                    onChange={() => toggleOne(source.id)}
                  />
                </td>
                <td className="file-name-cell">
                  <FileText size={16} />
                  <span>
                    <strong>{source.title || source.fileName}</strong>
                    <small>{sourceNeedsReview(source) ? "内容无法识别，请重新上传或移除" : source.fileName}</small>
                  </span>
                </td>
                <td>
                  <span className={`file-status ${sourceStatusClass(source)}`}>{sourceStatusLabel(source)}</span>
                </td>
                <td>{source.kind}</td>
                <td>{formatBytes(source.size)}</td>
                <td>{formatDateTime(source.updatedAt || source.importedAt)}</td>
                <td className="path-cell" title={source.relativePath}>{source.relativePath}</td>
                <td>
                  <div className="file-row-actions">
                    <button type="button" onClick={() => onPreview(source.relativePath)}>
                      {canDisplaySourceRawText(source) ? "原文" : "说明"}
                    </button>
                    {source.wikiPath && <button type="button" onClick={() => onOpen(source.wikiPath!)}>来源页</button>}
                    {source.convertedPath && <button type="button" onClick={() => onOpen(source.convertedPath!)}>全文</button>}
                    <button type="button" onClick={() => onDelete(source)}>移除</button>
                  </div>
                </td>
              </tr>
            ))}
            {!visibleSources.length && (
              <tr>
                <td colSpan={8}>
                  <div className="file-empty">{loading ? "正在加载文件..." : "暂无文件。"}</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="file-pagination">
        <span>
          {fileTotal > 0
            ? `第 ${currentPage} / ${pageCount} 页，显示 ${pageStart}-${pageEnd} / ${fileTotal}`
            : "暂无可显示文件"}
        </span>
        <div>
          <button type="button" disabled={!canPrev || loading || uploading} onClick={() => onPageChange(Math.max(0, fileOffset - filePageSize))}>
            上一页
          </button>
          <button type="button" disabled={!canNext || loading || uploading} onClick={() => onPageChange(fileOffset + filePageSize)}>
            下一页
          </button>
        </div>
      </div>

      <section className="file-queue-panel">
        <div className="section-toolbar">
          <h3>摄入队列{queueTotal > queue.length ? `（显示 ${queue.length} / ${queueTotal}）` : ""}</h3>
          {queueStats.total > 0 && <span>{queueProgress}%</span>}
        </div>
        {queueStats.total > 0 && (
          <div className="ingest-progress-card">
            <div className="ingest-progress-track">
              <span style={{ width: `${queueProgress}%` }} />
            </div>
            <div className="ingest-progress-meta">
              <span>完成 {queueStats.done}</span>
              <span>失败 {queueStats.failed}</span>
              <span>摄入中 {queueStats.running}</span>
              <span>排队 {queueStats.queued}</span>
            </div>
          </div>
        )}
        {queueStats.failed > 0 && (
          <p className="queue-warning">有 {queueStats.failed} 个文件摄入失败，可搜索“失败”筛选处理。</p>
        )}
        {queueStats.queued > 0 && queueStats.running === 0 && (
          <p className="queue-warning">队列正在等待后端处理；刷新会自动触发恢复，不需要重复上传。</p>
        )}
        <div className="queue-table">
          {visibleQueue.map((item) => (
            <div key={item.id} className="queue-row">
              <span className={`status-dot ${item.status}`} />
              <strong>{queueStatusLabel(item.status)}</strong>
              <span>{item.relativePath}</span>
              <small>{formatDateTime(item.updatedAt)}</small>
              {item.error && <em>{item.error}</em>}
            </div>
          ))}
          {!queue.length && <p className="muted">暂无队列。</p>}
        </div>
      </section>
    </section>
  );
}

function ClipSourceView({
  clip,
  setClip,
  pending,
  onSubmitClip
}: {
  clip: { title: string; url: string; content: string };
  setClip: (clip: { title: string; url: string; content: string }) => void;
  pending: boolean;
  onSubmitClip: (event: FormEvent) => void;
}) {
  return (
    <section className="clip-page">
      <form className="clip-form clip-form-main" onSubmit={onSubmitClip}>
        <h3>网页剪藏</h3>
        <input aria-label="剪藏标题" placeholder="标题" value={clip.title} onChange={(event) => setClip({ ...clip, title: event.target.value })} />
        <input aria-label="来源 URL" placeholder="URL" value={clip.url} onChange={(event) => setClip({ ...clip, url: event.target.value })} />
        <textarea
          rows={12}
          placeholder="粘贴网页正文或 Markdown"
          aria-label="剪藏正文"
          value={clip.content}
          onChange={(event) => setClip({ ...clip, content: event.target.value })}
        />
        <button className="primary" type="submit" disabled={pending || !clip.content.trim()}>
          {pending ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
          {pending ? "正在入队..." : "入队"}
        </button>
      </form>
    </section>
  );
}

function ArchiveProgressPanel({ items }: { items: ArchiveImportProgress[] }) {
  if (!items.length) return null;
  const statusLabel: Record<ArchiveImportProgress["status"], string> = {
    extracting: "解包中",
    registering: "登记中",
    done: "已完成",
    failed: "失败"
  };
  return (
    <section className="archive-progress-panel" aria-live="polite">
      {items.map((item) => {
        const progress = item.totalEntries > 0
          ? Math.min(100, Math.max(0, (item.processedEntries / item.totalEntries) * 100))
          : item.status === "done"
            ? 100
            : 0;
        return (
          <div key={item.id} className={`archive-progress-item ${item.status}`}>
            <div className="archive-progress-heading">
              <div>
                <h3>ZIP 解包进度</h3>
                <p>{item.fileName}</p>
              </div>
              <span>{statusLabel[item.status]}</span>
            </div>
            <div className="archive-progress-track" aria-label={`${item.fileName} 解包进度`}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <div className="archive-progress-meta">
              <span>{item.processedEntries} / {item.totalEntries || "?"} 条目</span>
              <span>{item.extractedFiles} 个可摄入文件</span>
              {(item.queued > 0 || item.skipped > 0) && <span>入队 {item.queued} · 跳过 {item.skipped}</span>}
            </div>
            {item.currentEntry && <p className="archive-progress-current">当前文件：{item.currentEntry}</p>}
            {item.detail && <p className="archive-progress-detail">{item.detail}</p>}
            {item.error && <p className="upload-progress-error">{item.error}</p>}
          </div>
        );
      })}
    </section>
  );
}

function UploadProgressPanel({
  task,
  onPause,
  onResume,
  onCancel
}: {
  task: UploadTaskState | null;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  if (!task) return null;
  const progress = task.totalBytes > 0
    ? Math.min(100, Math.max(0, (task.uploadedBytes / task.totalBytes) * 100))
    : task.totalFiles > 0
      ? Math.min(100, Math.max(0, (task.uploadedFiles / task.totalFiles) * 100))
      : 0;
  const statusLabel: Record<UploadTaskStatus, string> = {
    uploading: "上传中",
    paused: "已暂停",
    cancelling: "取消中",
    cancelled: "已取消",
    done: "已完成",
    error: "上传失败"
  };
  const canPause = task.status === "uploading";
  const canResume = task.status === "paused";
  const canCancel = task.status === "uploading" || task.status === "paused";

  return (
    <section className={`upload-progress-panel ${task.status}`}>
      <div className="upload-progress-heading">
        <div>
          <h3>上传进度</h3>
          <p>{task.fileName}</p>
        </div>
        <span>{statusLabel[task.status]}</span>
      </div>
      <div className="upload-progress-track" aria-label="上传进度">
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="upload-progress-meta">
        <span>{formatBytes(task.uploadedBytes)} / {formatBytes(task.totalBytes)}</span>
        <span>{task.uploadedFiles} / {task.totalFiles} 文件</span>
        <span>{Math.round(progress)}%</span>
      </div>
      <p className="upload-progress-detail">{task.detail}</p>
      {(task.queued > 0 || task.skipped > 0) && (
        <p className="upload-progress-detail">已入队 {task.queued} 个，跳过 {task.skipped} 个。</p>
      )}
      {task.error && <p className="upload-progress-error">{task.error}</p>}
      {(canPause || canResume || canCancel || task.status === "cancelling") && (
        <div className="upload-progress-actions">
          {canPause && (
            <button type="button" onClick={onPause}>
              <Pause size={16} />
              暂停
            </button>
          )}
          {canResume && (
            <button type="button" onClick={onResume}>
              <Play size={16} />
              继续
            </button>
          )}
          <button type="button" onClick={onCancel} disabled={!canCancel}>
            {task.status === "cancelling" ? <Loader2 className="spin" size={16} /> : <X size={16} />}
            取消
          </button>
        </div>
      )}
    </section>
  );
}

function AskView({
  projectId,
  wikiFiles,
  query,
  setQuery,
  hits,
  chat,
  chats,
  attachments,
  busy,
  pending,
  useChatContext,
  useWebSearch,
  externalSearchConfigured,
  modelProfiles,
  selectedModelId,
  onToggleContext,
  onToggleWebSearch,
  onSelectModel,
  onAsk,
  onResearch,
  onNewChat,
  onSelectChat,
  onDeleteChat,
  onAttachFiles,
  onRemoveAttachment,
  onOpen
}: {
  projectId: string;
  wikiFiles: WikiFile[];
  query: string;
  setQuery: (query: string) => void;
  hits: SearchHit[];
  chat: ChatSession | null;
  chats: ChatSession[];
  attachments: ChatAttachment[];
  busy: boolean;
  pending: boolean;
  useChatContext: boolean;
  useWebSearch: boolean;
  externalSearchConfigured: boolean;
  modelProfiles: ModelProfile[];
  selectedModelId: string;
  onToggleContext: (enabled: boolean) => void;
  onToggleWebSearch: (enabled: boolean) => void;
  onSelectModel: (modelId: string) => void;
  onAsk: () => void;
  onResearch: () => void;
  onNewChat: () => void;
  onSelectChat: (chat: ChatSession) => void;
  onDeleteChat: (chat: ChatSession) => void;
  onAttachFiles: (files: FileList | File[] | null) => void;
  onRemoveAttachment: (id: string) => void;
  onOpen: (path: string) => void;
}) {
  const messages = chat?.messages.filter((message) => message.role !== "system").slice(-40) ?? [];
  const sessions = useMemo(() => {
    const items = chat && !chat.id.startsWith("pending-")
      ? [chat, ...chats.filter((item) => item.id !== chat.id)]
      : chats;
    return items.slice(0, 60);
  }, [chat, chats]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const dragDepthRef = useRef(0);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, pending]);

  function dragHasFiles(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer.types || []).includes("Files");
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!dragActive && !dragHasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    const files = Array.from(event.dataTransfer.files || []);
    if (!dragHasFiles(event) && !files.length) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);
    setAttachmentMenuOpen(false);
    if (files.length) onAttachFiles(files);
  }

  return (
    <section
      className={`search-surface ask-surface${dragActive ? " drag-active" : ""}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="ask-layout">
        <aside className="chat-sessions" aria-label="聊天会话">
          <button className="new-chat-button" type="button" onClick={onNewChat}>
            <Plus size={17} />
            新建会话
          </button>
          <div className="chat-session-list">
            {sessions.map((item) => {
              const last = [...item.messages].reverse().find((message) => message.role !== "system");
              return (
                <div
                  key={item.id}
                  className={`chat-session-row${chat?.id === item.id ? " active" : ""}`}
                >
                  <button
                    className="chat-session-main"
                    type="button"
                    onClick={() => onSelectChat(item)}
                    title={item.title}
                  >
                    <MessageSquare size={15} />
                    <span>
                      <strong>{item.title || "未命名会话"}</strong>
                      <small>{last?.content || "暂无消息"}</small>
                    </span>
                  </button>
                  <button
                    className="chat-session-delete"
                    type="button"
                    onClick={() => onDeleteChat(item)}
                    title="删除会话"
                    aria-label={`删除会话：${item.title || "未命名会话"}`}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
            {!sessions.length && <p className="muted">还没有会话。</p>}
          </div>
        </aside>

        <div className="ask-shell">
          <div className="chat-log ask-log" ref={logRef}>
            {messages.length ? (
              messages.map((message, index) => (
                <ChatMessageView
                  projectId={projectId}
                  wikiFiles={wikiFiles}
                  key={`${message.createdAt}-${index}`}
                  message={message}
                  onOpen={onOpen}
                />
              ))
            ) : (
              <div className="chat-empty">
                <MessageSquare size={30} />
                <h3>向知识库提问</h3>
                <p>可以新建多个会话分开主题；底部开关可选择结合当前会话上下文或只回答本轮问题。</p>
              </div>
            )}
            {pending && (
              <article className="chat-message assistant loading">
                <div className="message-avatar">AI</div>
                <div className="message-body">
                  <div className="message-meta">助手</div>
                  <div className="typing-indicator" aria-live="polite">
                    <span />
                    <span />
                    <span />
                    正在思考
                  </div>
                </div>
              </article>
            )}
          </div>

          {hits.length > 0 && (
            <details className="evidence-panel">
              <summary>
                <span>引用来源</span>
                <small>{hits.length} 条相关材料</small>
              </summary>
              <div className="evidence-list">
                {hits.map((hit, index) => (
                  <button key={hit.path} className="evidence-item" type="button" onClick={() => onOpen(hit.path)}>
                    <span className="evidence-index">来源 {index + 1}</span>
                    <strong>{hit.title}</strong>
                    <span className="evidence-excerpt">{hit.excerpt}</span>
                    <small>{hit.path} · score {Math.round(hit.score)}</small>
                  </button>
                ))}
              </div>
            </details>
          )}

          <form
            className="ask-composer"
            onSubmit={(event) => {
              event.preventDefault();
              onAsk();
            }}
          >
            <div className="composer-input">
              {attachments.length > 0 && (
                <AttachmentTray attachments={attachments} onRemove={onRemoveAttachment} />
              )}
              <textarea
                rows={3}
                placeholder="问点难的，让我多想一步"
                aria-label="问题"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="composer-actions">
              <div className="attach-action">
                <button
                  type="button"
                  onClick={() => setAttachmentMenuOpen((value) => !value)}
                  title="添加附件"
                >
                  <Plus size={18} />
                </button>
                {attachmentMenuOpen && (
                  <div className="attach-menu">
                    <button
                      type="button"
                      onClick={() => {
                        setAttachmentMenuOpen(false);
                        fileInputRef.current?.click();
                      }}
                    >
                      <Paperclip size={16} />
                      上传文件或图片
                    </button>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.md,.markdown,.txt,.csv,.tsv,.json,.jsonl,.yaml,.yml,.xml,.html,.htm,.log,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx"
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    event.currentTarget.value = "";
                    onAttachFiles(files);
                  }}
                />
              </div>
              <label className="model-select-action" title="选择本轮回答使用的模型">
                <span>模型</span>
                <select value={selectedModelId} onChange={(event) => onSelectModel(event.target.value)}>
                  <option value={SUMMARY_MODEL_ID}>摘要模式</option>
                  {modelProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name || profile.model || profile.provider}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className={`web-search-action ${useWebSearch ? "active" : ""}`}
                type="button"
                aria-pressed={useWebSearch}
                onClick={() => onToggleWebSearch(!useWebSearch)}
                disabled={!externalSearchConfigured}
                title={!externalSearchConfigured ? "请先在设置中配置并保存外部搜索服务" : useWebSearch ? "已开启本轮联网搜索" : "开启本轮联网搜索"}
              >
                <Globe2 size={18} />
                <span>联网</span>
              </button>
              <button
                className={`context-pill ${useChatContext ? "active" : ""}`}
                type="button"
                onClick={() => onToggleContext(!useChatContext)}
                title={useChatContext ? "本轮会结合当前会话上下文" : "本轮只按当前输入回答"}
              >
                {useChatContext ? "上下文" : "单轮"}
              </button>
              <button
                className="research-action"
                type="button"
                disabled={busy || !query.trim() || attachments.length > 0}
                onClick={onResearch}
                title={attachments.length ? "深研基于知识库材料，本轮附件请使用提问" : "深度研究"}
              >
                <Microscope size={17} />
                <span>深研</span>
              </button>
              <button className="primary" type="submit" disabled={busy || !query.trim()} title="提问">
                {pending ? <Loader2 className="spin" size={18} /> : <MessageSquare size={18} />}
              </button>
            </div>
          </form>
        </div>
      </div>
      {dragActive && (
        <div className="chat-drop-overlay" aria-hidden="true">
          <Upload size={30} />
          <strong>松开鼠标上传到本轮对话</strong>
          <span>支持图片、文本和常见文档；图片会作为多模态附件发送。</span>
        </div>
      )}
    </section>
  );
}

function ChatMessageView({ message, onOpen, projectId, wikiFiles }: { message: ChatSession["messages"][number]; onOpen: (path: string) => void; projectId: string; wikiFiles: WikiFile[] }) {
  const shouldShowMarkdown = !message.researchTask || message.researchTask.status === "done" || message.researchTask.status === "failed";
  return (
    <article className={`chat-message ${message.role}`}>
      <div className="message-avatar">{message.role === "user" ? "你" : "AI"}</div>
      <div className="message-body">
        <div className="message-meta">{message.role === "user" ? "你" : "助手"}</div>
        {message.role === "assistant" ? (
          <div className="message-content">
            {message.researchTask && <ResearchTaskCard task={message.researchTask} />}
            {shouldShowMarkdown && message.content && <MarkdownPane content={message.content} projectId={projectId} files={wikiFiles} onOpen={onOpen} />}
          </div>
        ) : (
          <>
            <p className="user-query">{message.content}</p>
            {Boolean(message.attachments?.length) && (
              <AttachmentTray attachments={message.attachments || []} readonly />
            )}
          </>
        )}
        {message.role === "assistant" && Boolean(message.citations?.length) && (
          <div className="message-citations">
            {message.citations?.slice(0, 6).map((citation, citationIndex) => (
              <button key={`${citation}-${citationIndex}`} type="button" onClick={() => onOpen(citation)}>
                来源 {citationIndex + 1}
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function ResearchTaskCard({ task }: { task: ResearchTask }) {
  const statusLabel: Record<ResearchTask["status"], string> = {
    queued: "排队中",
    running: "研究中",
    done: "已完成",
    failed: "失败"
  };
  const completed = task.steps.filter((step) => step.status === "done").length;
  const activeStep = task.steps.find((step) => step.status === "running") || task.steps.find((step) => step.status === "pending");

  return (
    <section className={`research-task-card ${task.status}`} aria-live="polite">
      <div className="research-task-heading">
        <div>
          <strong>深度研究任务</strong>
          <span>{statusLabel[task.status]} · {Math.round(task.progress)}%</span>
        </div>
        <small>{completed}/{task.steps.length} 项完成</small>
      </div>
      <div className="research-progress-track" aria-label="深度研究进度">
        <span style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} />
      </div>
      {activeStep && task.status !== "done" && task.status !== "failed" && (
        <p className="research-task-current">
          当前：{activeStep.label}{activeStep.detail ? ` · ${activeStep.detail}` : ""}
        </p>
      )}
      <div className="research-step-list">
        {task.steps.map((step) => (
          <details
            key={step.id}
            className={`research-step-row ${step.status}`}
            open={step.status === "running" || step.status === "failed"}
          >
            <summary>
              <span>{researchStepIcon(step.status)}</span>
              <strong>{step.label}</strong>
              <small>{researchStepStatusText(step.status)}</small>
            </summary>
            <p>{step.detail || "等待执行"}</p>
          </details>
        ))}
      </div>
      {task.error && <p className="research-task-error">{task.error}</p>}
    </section>
  );
}

function researchStepIcon(status: ResearchTask["steps"][number]["status"]) {
  if (status === "running") return <Loader2 className="spin" size={15} />;
  if (status === "done") return <CheckCircle2 size={15} />;
  if (status === "failed") return <CircleAlert size={15} />;
  return <Play size={15} />;
}

function AttachmentTray({
  attachments,
  readonly = false,
  onRemove
}: {
  attachments: ChatAttachment[];
  readonly?: boolean;
  onRemove?: (id: string) => void;
}) {
  return (
    <div className={`attachment-tray ${readonly ? "readonly" : ""}`}>
      {attachments.map((attachment) => (
        <div key={attachment.id} className="attachment-chip">
          {attachment.kind === "image" && attachment.dataUrl ? (
            <img src={attachment.dataUrl} alt="" />
          ) : (
            <span className="attachment-icon">
              <Paperclip size={15} />
            </span>
          )}
          <span>
            <strong>{attachment.name}</strong>
            <small>{attachment.kind} · {formatBytes(attachment.size)}</small>
          </span>
          {!readonly && onRemove && (
            <button type="button" title="移除附件" onClick={() => onRemove(attachment.id)}>
              <X size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function GraphView({
  graph,
  onReload,
  onOpen
}: {
  graph: KnowledgeGraph | null;
  onReload: () => void;
  onOpen: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const filteredNodes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return graph?.nodes || [];
    return (graph?.nodes || []).filter((node) =>
      [node.title, node.path, node.type].some((value) => value.toLowerCase().includes(needle))
    );
  }, [graph, query]);
  const visibleNodes = filteredNodes.slice(0, GRAPH_NODE_LIMIT);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const edges = (graph?.edges || []).filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const nodeMap = new Map((graph?.nodes || []).map((node) => [node.id, node]));
  const selected = selectedId ? nodeMap.get(selectedId) : undefined;
  const left = Math.min(0, ...visibleNodes.map((node) => (node.x ?? 340) - 100));
  const top = Math.min(0, ...visibleNodes.map((node) => (node.y ?? 270) - 50));
  const right = Math.max(680, ...visibleNodes.map((node) => (node.x ?? 340) + 100));
  const bottom = Math.max(540, ...visibleNodes.map((node) => (node.y ?? 270) + 60));
  const viewWidth = (right - left) / zoom;
  const viewHeight = (bottom - top) / zoom;
  const viewBox = `${(right + left - viewWidth) / 2} ${(bottom + top - viewHeight) / 2} ${viewWidth} ${viewHeight}`;
  const showNodeLabels = visibleNodes.length <= 160;
  const communityStats = [...visibleNodes.reduce((acc, node) => {
    acc.set(node.community, (acc.get(node.community) || 0) + 1);
    return acc;
  }, new Map<number, number>()).entries()].sort((a, b) => b[1] - a[1]);

  return (
    <section className="graph-work">
      <div className="section-toolbar graph-toolbar">
        <h3>知识图谱</h3>
        <div className="graph-controls">
          <input aria-label="过滤图谱节点" placeholder="过滤节点" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button title="放大" onClick={() => setZoom((value) => Math.min(2.2, value + 0.15))}>
            <ZoomIn size={17} />
          </button>
          <button title="缩小" onClick={() => setZoom((value) => Math.max(0.55, value - 0.15))}>
            <ZoomOut size={17} />
          </button>
          <button title="重置视图" onClick={() => setZoom(1)}>
            <LocateFixed size={17} />
          </button>
          <button onClick={onReload}>
            <RefreshCw size={17} />
            重算
          </button>
        </div>
      </div>
      <div className="graph-layout">
        <svg className="graph-canvas" viewBox={viewBox} role="img">
          {edges.map((edge) => {
            const source = nodeMap.get(edge.source);
            const target = nodeMap.get(edge.target);
            if (!source || !target) return null;
            return (
              <line
                key={edge.id}
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                strokeWidth={Math.max(1, edge.weight / 2)}
              />
            );
          })}
          {visibleNodes.map((node) => (
            <g
              key={node.id}
              className={selectedId === node.id ? "selected-node" : ""}
              onClick={() => setSelectedId(node.id)}
              onDoubleClick={() => onOpen(node.path)}
              tabIndex={0}
              role="button"
              aria-label={`查看节点：${node.title}`}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(node.id); }
              }}
            >
              <title>{node.title}</title>
              <circle cx={node.x} cy={node.y} r={Math.min(24, 9 + node.weight)} className={`node-${node.type}`} />
              {(showNodeLabels || selectedId === node.id) && (
                <text x={node.x} y={(node.y || 0) + 34}>
                  {node.title.slice(0, 16)}
                </text>
              )}
            </g>
          ))}
        </svg>
        <aside className="graph-panel">
          <strong>{visibleNodes.length} / {filteredNodes.length} 节点 · {edges.length} 边</strong>
          {filteredNodes.length > visibleNodes.length && (
            <p className="muted">图谱较大，当前显示前 {visibleNodes.length} 个节点；可输入关键词缩小范围。</p>
          )}
          {selected ? (
            <div className="selected-card">
              <span>{selected.type}</span>
              <h4>{selected.title}</h4>
              <small>{selected.path}</small>
              <button onClick={() => onOpen(selected.path)}>打开页面</button>
            </div>
          ) : (
            <p className="muted">单击节点查看详情，双击打开页面。</p>
          )}
          <div className="community-list">
            {communityStats.slice(0, 8).map(([community, count]) => (
              <span key={community}>社区 {community}: {count}</span>
            ))}
          </div>
        </aside>
      </div>
      <div className="insights">
        {graph?.insights.map((insight) => (
          <div key={insight.title}>
            <strong>{insight.title}</strong>
            <p>{insight.detail}</p>
            <footer>
              {insight.paths.map((path) => (
                <button key={path} onClick={() => onOpen(path)}>{path}</button>
              ))}
            </footer>
          </div>
        ))}
        {!graph && <p className="muted">正在等待图谱数据。</p>}
      </div>
    </section>
  );
}

function LintView({
  issues,
  checked,
  busy,
  onRun,
  onOpen
}: {
  issues: LintIssue[];
  checked: boolean;
  busy: boolean;
  onRun: () => void;
  onOpen: (path: string) => void;
}) {
  const stats = useMemo(
    () => ({
      error: issues.filter((issue) => issue.severity === "error").length,
      warning: issues.filter((issue) => issue.severity === "warning").length,
      info: issues.filter((issue) => issue.severity === "info").length
    }),
    [issues]
  );
  const sortedIssues = useMemo(
    () =>
      [...issues].sort((a, b) => {
        const severityDiff = LINT_SEVERITY_RANK[a.severity] - LINT_SEVERITY_RANK[b.severity];
        if (severityDiff) return severityDiff;
        return a.path.localeCompare(b.path);
      }),
    [issues]
  );

  return (
    <section className="lint-surface">
      <div className="section-toolbar">
        <div>
          <h3>知识库体检</h3>
          <p className="lint-help">检查知识库结构是否健康：链接能不能打开、页面标题和元数据是否完整、来源记录是否还在、是否有重复标题或摄入失败。</p>
        </div>
        <button onClick={onRun} disabled={busy}>
          <ShieldCheck size={17} />
          开始检查
        </button>
      </div>
      <div className="lint-summary">
        <div className="error">
          <strong>{stats.error}</strong>
          <span>必须处理</span>
        </div>
        <div className="warning">
          <strong>{stats.warning}</strong>
          <span>建议修复</span>
        </div>
        <div className="info">
          <strong>{stats.info}</strong>
          <span>提示</span>
        </div>
      </div>
      <div className="lint-checks" aria-label="体检项目">
        {LINT_CHECKS.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      <div className="issue-list">
        {sortedIssues.map((issue) => (
          <button
            key={issue.id}
            className={`issue-card ${issue.severity}`}
            onClick={() => issue.path.startsWith("wiki/") && onOpen(issue.path)}
            title={issue.path.startsWith("wiki/") ? "打开对应页面" : issue.path}
          >
            <span className="issue-icon">
              {issue.severity === "error" ? <CircleAlert size={18} /> : <CheckCircle2 size={18} />}
            </span>
            <span className={`issue-severity ${issue.severity}`}>{LINT_SEVERITY_LABELS[issue.severity]}</span>
            <strong>{issue.title}</strong>
            <span>{issue.detail}</span>
            {issue.fix && <em>{issue.fix}</em>}
            <small>{issue.path}</small>
          </button>
        ))}
        {!issues.length && (
          <div className="lint-empty">
            <ShieldCheck size={28} />
            <strong>{checked ? "体检完成，未发现问题" : "还没有体检结果"}</strong>
            <p>{checked ? "本次检查范围内未发现断链、来源缺失或元数据问题。" : "点击“开始检查”检查断链、元数据、来源和摄入状态。"}</p>
          </div>
        )}
      </div>
    </section>
  );
}


async function fileToChatAttachment(file: File, projectId: string): Promise<{ attachment: ChatAttachment; warning?: string }> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const base: ChatAttachment = {
    id,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    kind: file.type.startsWith("image/") ? "image" : isTextLikeFile(file) ? "text" : "file"
  };

  if (base.kind === "image") {
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(base.mimeType)) throw new Error(`图片 ${file.name} 的格式不支持对话，请使用 PNG、JPEG、WebP 或 GIF。`);
    if (file.size > CHAT_ATTACHMENT_IMAGE_MAX_BYTES) throw new Error(`图片 ${file.name} 超过 4 MB，请压缩后重试。`);
    return { attachment: { ...base, dataUrl: await readFileAsDataUrl(file) } };
  }
  if (file.size > 20 * 1024 * 1024) throw new Error(`附件 ${file.name} 超过 20 MB，请在文件页上传。`);
  const extracted = await api.extractAttachment(projectId, file);
  let text = "";
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const character of extracted.text) {
    const length = encoder.encode(character).length;
    if (bytes + length > 24000 || text.length + character.length > CHAT_ATTACHMENT_TEXT_LIMIT) break;
    text += character; bytes += length;
  }
  if (!text.trim()) throw new Error(`附件 ${file.name} 没有可读取正文，请检查原文件。`);
  const warnings = [...extracted.warnings];
  if (text.length < extracted.text.length) warnings.push("本轮只读取开头部分；请在文件页上传以检索完整材料。");
  return { attachment: { ...base, kind: "text", text }, warning: warnings.length ? `${file.name}：${warnings.join(" ")}` : undefined };
}

function isTextLikeFile(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase();
  return (
    file.type.startsWith("text/") ||
    ["md", "markdown", "txt", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html", "htm", "log"].includes(
      ext || ""
    )
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}


function availableModelProfiles(settings: ProjectSettings | null): ModelProfile[] {
  return (settings?.modelProfiles || []).filter(canUseModelProfile);
}

function canUseModelProfile(profile: ModelProfile): boolean {
  if (!profile.enabled || profile.provider === "offline") return false;
  if (profile.provider === "ollama" || profile.provider === "custom") return Boolean(profile.baseUrl && profile.model);
  return Boolean(profile.apiKey && profile.baseUrl && profile.model);
}




function researchTaskToChat(task: ResearchTask, userMessage: ChatSession["messages"][number], createdAt: string): ChatSession {
  const assistantContent = task.result?.markdown || "";
  return {
    id: `research:${task.id}`,
    title: task.topic,
    createdAt,
    updatedAt: task.updatedAt,
    messages: [
      userMessage,
      {
        role: "assistant",
        content: assistantContent,
        citations: task.result?.path ? [task.result.path] : undefined,
        researchTask: task,
        createdAt: task.updatedAt
      }
    ]
  };
}

function researchTaskPreview(task: ResearchTask): string {
  return task.result?.markdown || researchTaskMarkdown(task);
}

function researchTaskMarkdown(task: ResearchTask): string {
  const statusLabel: Record<ResearchTask["status"], string> = {
    queued: "排队中",
    running: "研究中",
    done: "已完成",
    failed: "失败"
  };
  return [
    `# 深度研究：${task.topic}`,
    "",
    `状态：${statusLabel[task.status]} · ${Math.round(task.progress)}%`,
    "",
    "## 任务列表",
    "",
    ...task.steps.map((step) => {
      const detail = step.detail ? `：${step.detail}` : "";
      return `- ${researchStepStatusText(step.status)} ${step.label}${detail}`;
    }),
    task.error ? "\n## 错误\n" : "",
    task.error || ""
  ].filter(Boolean).join("\n");
}

function researchStepStatusText(status: ResearchTask["steps"][number]["status"]): string {
  return {
    pending: "待处理",
    running: "进行中",
    done: "完成",
    failed: "失败"
  }[status];
}

function formatChatFailureNotice(message: string): string {
  if (/连接已中断|request aborted|abort|aborted|AbortError|取消/i.test(message)) {
    return "问答连接已中断，请重新发送。";
  }
  return `问答请求失败：${message.replace(/上传连接已中断/g, "连接已中断")}`;
}

function viewTitle(view: ViewKey): string {
  return VIEWS.find((item) => item.key === view)?.label || "工作台";
}

function fileTreeSectionLabel(section: string): string {
  return {
    concepts: "概念",
    entities: "实体",
    index: "索引",
    log: "日志",
    overview: "总览",
    queries: "问答",
    research: "研究",
    sources: "来源",
    synthesis: "综合",
    comparisons: "对比",
    root: "根目录"
  }[section] || section;
}

function clampPreviewContent(content: string): string {
  if (content.length <= PREVIEW_RENDER_CHAR_LIMIT) return content;
  const omitted = content.length - PREVIEW_RENDER_CHAR_LIMIT;
  return [
    content.slice(0, PREVIEW_RENDER_CHAR_LIMIT),
    "",
    "---",
    "",
    `右侧预览已截断 ${omitted.toLocaleString("zh-CN")} 个字符，以保持页面切换流畅；左侧编辑区仍保留完整内容。`
  ].join("\n");
}

function normalizeQueueStats(activity: ActivitySnapshot): QueueStats {
  if (activity.queueStats) return activity.queueStats;
  return activity.queue.reduce<QueueStats>(
    (stats, item) => {
      stats.total += 1;
      stats[item.status] += 1;
      return stats;
    },
    { ...EMPTY_QUEUE_STATS }
  );
}

function normalizeSourceStats(activity: ActivitySnapshot): SourceStats {
  if (activity.sourceStats) return activity.sourceStats;
  return activity.sources.reduce<SourceStats>(
    (stats, source) => {
      stats.total += 1;
      stats[source.status] += 1;
      return stats;
    },
    { ...EMPTY_SOURCE_STATS }
  );
}

function normalizeIngestProgress(activity: ActivitySnapshot, stats = normalizeQueueStats(activity)): IngestProgress {
  if (activity.ingestProgress) return activity.ingestProgress;
  const processed = stats.done + stats.failed;
  const active = activity.queue.find((item) => item.status === "running");
  const next = activity.queue.find((item) => item.status === "queued");
  const item = active || next;
  return {
    total: stats.total,
    processed,
    queued: stats.queued,
    running: stats.running,
    done: stats.done,
    failed: stats.failed,
    percent: stats.total > 0 ? Math.floor((processed / stats.total) * 100) : 0,
    currentIndex: item ? Math.min(stats.total, processed + 1) : processed,
    active: active
      ? {
          id: active.id,
          sourceId: active.sourceId,
          relativePath: active.relativePath,
          fileName: queueItemTitle(active),
          status: active.status,
          updatedAt: active.updatedAt,
          error: active.error
        }
      : undefined,
    next: next
      ? {
          id: next.id,
          sourceId: next.sourceId,
          relativePath: next.relativePath,
          fileName: queueItemTitle(next),
          status: next.status,
          updatedAt: next.updatedAt,
          error: next.error
        }
      : undefined
  };
}

function queueIsRunning(stats: QueueStats): boolean {
  return stats.queued + stats.running > 0;
}

function isFinishedQueueItem(item: QueueItem): boolean {
  return item.status === "done" || item.status === "failed";
}

function finishedQueueIds(queue: QueueItem[]): Set<string> {
  return new Set(queue.filter(isFinishedQueueItem).map((item) => item.id));
}

function queueItemTitle(item: QueueItem): string {
  const normalized = item.relativePath.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || normalized || item.sourceId;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "status" in error &&
      Number((error as { status?: unknown }).status) === 404
  );
}

function sourceNeedsReview(source: SourceRecord): boolean {
  const text = [source.title, source.summary, source.error].filter(Boolean).join("\n");
  return /(?:原文包含无法识别字符|问题内容包含无法识别字符|字符无法识别|无法识别的问题)/u.test(text);
}

function sourceStatusClass(source: SourceRecord): SourceRecord["status"] {
  return sourceNeedsReview(source) ? "failed" : source.status;
}

function sourceStatusLabel(source: SourceRecord): string {
  if (sourceNeedsReview(source)) return "需处理";
  return {
    queued: "排队摄入",
    ingesting: "摄入中",
    ready: "可用",
    skipped: "已跳过",
    failed: "失败"
  }[source.status];
}

function queueStatusLabel(status: QueueItem["status"]): string {
  return {
    queued: "排队摄入",
    running: "正在摄入",
    done: "完成",
    failed: "失败"
  }[status];
}

function canDisplaySourceRawText(source: SourceRecord): boolean {
  const lowerPath = source.relativePath.toLowerCase();
  const dotIndex = lowerPath.lastIndexOf(".");
  if (dotIndex < 0) return false;
  return RAW_TEXT_DISPLAY_EXTENSIONS.has(lowerPath.slice(dotIndex));
}

function isEditableWikiPath(path: string): boolean {
  return path.startsWith("wiki/");
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "-";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[unitIndex]}`;
}
