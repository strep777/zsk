import { FormEvent, RefObject, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
import { api } from "./api";
import {
  ChatSession,
  ChatAttachment,
  KnowledgeGraph,
  LintIssue,
  Project,
  ProjectSettings,
  QueueItem,
  SearchHit,
  SourceRecord,
  ViewKey,
  WikiFile
} from "./types";

const MarkdownView = lazy(() =>
  import("./components/MarkdownView").then((module) => ({ default: module.MarkdownView }))
);

type EditorMode = "split" | "edit" | "preview";
type UploadTaskStatus = "uploading" | "paused" | "cancelling" | "cancelled" | "done" | "error";

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

const VIEWS: Array<{ key: ViewKey; label: string; icon: typeof BookOpen }> = [
  { key: "wiki", label: "Wiki", icon: BookOpen },
  { key: "files", label: "文件", icon: FileText },
  { key: "sources", label: "来源", icon: Link },
  { key: "search", label: "查询", icon: Search },
  { key: "graph", label: "图谱", icon: Network },
  { key: "lint", label: "体检", icon: ShieldCheck },
  { key: "settings", label: "设置", icon: Settings }
];

const PROVIDER_DEFAULTS: Record<ProjectSettings["provider"], { baseUrl: string; model: string }> = {
  offline: { baseUrl: "", model: "" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  volcengine: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-0-lite-260215"
  },
  "volcengine-coding-plan": {
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    model: "ark-code-latest"
  },
  ollama: { baseUrl: "http://localhost:11434", model: "qwen2.5:7b" },
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-3-5-sonnet-latest" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-1.5-pro" },
  custom: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }
};

const FORMAT_HINT = "支持 doc、docx、ppt、pptx、xls、xlsx、pdf、zip、md、txt、html、csv、json 和常见图片。浏览器上传统一走分片，25000+ 文件建议压成一个 ZIP。";
const TREE_SECTION_LIMIT = 300;
const WIKI_TREE_LIMIT = 900;
const SOURCE_LIST_LIMIT = 500;
const FILE_PAGE_SIZE = 100;
const GRAPH_NODE_LIMIT = 1200;
const CHAT_ATTACHMENT_LIMIT = 6;
const CHAT_ATTACHMENT_TEXT_LIMIT = 12000;
const CHAT_ATTACHMENT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
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
  const [view, setView] = useState<ViewKey>("wiki");
  const [wikiFiles, setWikiFiles] = useState<WikiFile[]>([]);
  const [wikiTotal, setWikiTotal] = useState(0);
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
  const [selectedPath, setSelectedPath] = useState("wiki/index.md");
  const [editor, setEditor] = useState("");
  const [preview, setPreview] = useState("");
  const [editorMode, setEditorMode] = useState<EditorMode>("split");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [chat, setChat] = useState<ChatSession | null>(null);
  const [chats, setChats] = useState<ChatSession[]>([]);
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([]);
  const [chatPending, setChatPending] = useState(false);
  const [useChatContext, setUseChatContext] = useState(true);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [issues, setIssues] = useState<LintIssue[]>([]);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [clip, setClip] = useState({ title: "", url: "", content: "" });
  const [newProject, setNewProject] = useState({ name: "我的 LLM Wiki", description: "" });
  const [uploadTask, setUploadTask] = useState<UploadTaskState | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const wasQueueRunningRef = useRef(false);
  const filePageRequestRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadControlRef = useRef<{
    paused: boolean;
    cancelled: boolean;
    waiters: Array<() => void>;
  }>({ paused: false, cancelled: false, waiters: [] });

  const project = useMemo(() => projects.find((item) => item.id === projectId), [projects, projectId]);
  const running = queue.some((item) => item.status === "queued" || item.status === "running");

  const refreshProjects = useCallback(async () => {
    const payload = await api.projects();
    setProjects(payload.projects);
    setProjectId((current) => current || payload.projects[0]?.id || "");
  }, []);

  const refreshProjectData = useCallback(async () => {
    if (!projectId) return;
    const [wiki, activity] = await Promise.all([
      api.wikiFiles(projectId, { limit: WIKI_TREE_LIMIT }),
      api.activity(projectId, { sourceLimit: SOURCE_LIST_LIMIT, queueLimit: 500, compact: true })
    ]);
    setWikiFiles(wiki.files);
    setWikiTotal(wiki.total ?? wiki.files.length);
    setSources(activity.sources);
    setSourceTotal(activity.sourceTotal ?? activity.sources.length);
    setSourceBytesTotal(activity.sourceBytesTotal ?? 0);
    setQueue(activity.queue);
    setQueueTotal(activity.queueTotal ?? activity.queue.length);
    wasQueueRunningRef.current = activity.queue.some((item) => item.status === "queued" || item.status === "running");
  }, [projectId]);

  const loadFilePage = useCallback(async (offset: number, query: string) => {
    if (!projectId) return;
    const requestId = filePageRequestRef.current + 1;
    filePageRequestRef.current = requestId;
    const safeOffset = Math.max(0, offset);
    setFileLoading(true);
    try {
      const payload = await api.rawFiles(projectId, {
        limit: FILE_PAGE_SIZE,
        offset: safeOffset,
        query: query.trim(),
        compact: true
      });
      if (requestId !== filePageRequestRef.current) return;
      if (!payload.files.length && (payload.total ?? 0) > 0 && safeOffset >= (payload.total ?? 0)) {
        const lastOffset = Math.max(0, Math.floor(((payload.total ?? 1) - 1) / FILE_PAGE_SIZE) * FILE_PAGE_SIZE);
        const lastPage = await api.rawFiles(projectId, {
          limit: FILE_PAGE_SIZE,
          offset: lastOffset,
          query: query.trim(),
          compact: true
        });
        if (requestId !== filePageRequestRef.current) return;
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

  const refreshChats = useCallback(async () => {
    if (!projectId) return;
    const payload = await api.chats(projectId);
    setChats(payload.chats);
    setChat((current) => {
      if (!current || current.id.startsWith("research:")) return current;
      return payload.chats.find((item) => item.id === current.id) || current;
    });
  }, [projectId]);

  const openFile = useCallback(
    async (path: string) => {
      if (!projectId) return;
      const payload = await api.fileContent(projectId, path);
      setSelectedPath(path);
      setEditor(payload.content);
      setPreview(payload.content);
      if (path.startsWith("wiki/")) setView("wiki");
    },
    [projectId]
  );

  useEffect(() => {
    refreshProjects().catch((error) => setNotice(error.message));
  }, [refreshProjects]);

  useEffect(() => {
    refreshProjectData().catch((error) => setNotice(error.message));
    refreshChats().catch((error) => setNotice(error.message));
  }, [refreshProjectData, refreshChats]);

  useEffect(() => {
    if (view !== "files" || !projectId) return;
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
    if (!projectId) return;
    filePageRequestRef.current += 1;
    setGraph(null);
    setIssues([]);
    setSettings(null);
    setHits([]);
    setChat(null);
    setChats([]);
    setChatAttachments([]);
    setChatPending(false);
    setWikiTotal(0);
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
    wasQueueRunningRef.current = false;
    openFile(selectedPath).catch(() => openFile("wiki/index.md").catch((error) => setNotice(error.message)));
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const timer = window.setInterval(() => {
      api.activity(projectId, { sourceLimit: SOURCE_LIST_LIMIT, queueLimit: 500, compact: true })
        .then((activity) => {
          const isRunning = activity.queue.some((item) => item.status === "queued" || item.status === "running");
          setQueue(activity.queue);
          setSources(activity.sources);
          setSourceTotal(activity.sourceTotal ?? activity.sources.length);
          setSourceBytesTotal(activity.sourceBytesTotal ?? 0);
          setQueueTotal(activity.queueTotal ?? activity.queue.length);
          if (view === "files") {
            loadFilePage(fileOffset, fileQuery).catch(() => undefined);
          }
          if (wasQueueRunningRef.current && !isRunning) {
            refreshProjectData().catch(() => undefined);
          }
          wasQueueRunningRef.current = isRunning;
        })
        .catch(() => undefined);
    }, running ? 5000 : 30000);
    return () => window.clearInterval(timer);
  }, [projectId, refreshProjectData, running, view, fileOffset, fileQuery, loadFilePage]);

  useEffect(() => {
    if (view === "graph" && !graph) loadGraph();
    if (view === "settings" && !settings) loadSettings().catch((error) => setNotice(error.message));
  }, [view, projectId, graph, issues.length, settings]);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const payload = await api.createProject(newProject);
      await refreshProjects();
      setProjectId(payload.project.id);
      setNotice("知识库已创建。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrentFile() {
    if (!projectId || !selectedPath) return;
    setBusy(true);
    try {
      await api.saveFile(projectId, selectedPath, editor);
      setPreview(editor);
      await refreshProjectData();
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
    if (uploadTask && ["uploading", "paused", "cancelling"].includes(uploadTask.status)) {
      setNotice("已有上传任务正在进行，请先暂停或取消当前上传。");
      setView("files");
      return;
    }
    const controller = new AbortController();
    uploadAbortRef.current = controller;
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
          if (progress.uploadedBytes !== undefined && progress.totalBytes !== undefined) {
            setNotice(
              `上传中：${progress.detail || `第 ${progress.batchIndex}/${progress.batchCount} 批`}，${formatBytes(progress.uploadedBytes)} / ${formatBytes(progress.totalBytes)}。`
            );
          } else if (progress.batchCount > 1) {
            setNotice(
              `上传中：第 ${progress.batchIndex}/${progress.batchCount} 批，已发送 ${progress.uploadedFiles}/${progress.totalFiles} 个文件，入队 ${progress.queued} 个。`
            );
          }
        }
      });
      await refreshProjectData();
      await loadFilePage(0, fileQuery).catch((error) =>
        setNotice(error instanceof Error ? error.message : String(error))
      );
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
                ? result.message || "文件已上传，后台正在解包并登记到摄入队列。"
                : "文件已进入摄入队列。",
              uploadedFiles: selectedFiles.length,
              uploadedBytes: totalBytes,
              queued: result.queued,
              skipped: result.skipped
            }
          : current
      );
      setNotice(
        result.async
          ? `${batchHint}${result.message || "文件已上传，后台正在解包并登记到摄入队列。"}`
          : `${batchHint}文件已进入摄入队列：${result.queued} 个入队，${result.skipped} 个跳过${archiveHint}。`
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
      setBusy(false);
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
    const chatId = chat?.id.startsWith("research:") ? undefined : chat?.id;
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

    setChat(optimisticChat);
    setQuery("");
    setChatAttachments([]);
    setHits([]);
    setChatPending(true);
    setBusy(true);
    try {
      const payload = await api.chat(projectId, { query: question, chatId, save, attachments, useHistory: useChatContext });
      setHits(payload.hits);
      setChat(payload.chat);
      setChats((current) => [payload.chat, ...current.filter((item) => item.id !== payload.chat.id)]);
      setChatAttachments([]);
      setPreview(payload.answer);
      if (payload.savedPath) setNotice(`已保存到 ${payload.savedPath}`);
      if (payload.savedPath) await refreshProjectData();
      await refreshChats();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message);
      const failedAt = new Date().toISOString();
      setChat((current) =>
        current
          ? {
              ...current,
              updatedAt: failedAt,
              messages: [
                ...current.messages,
                {
                  role: "assistant",
                  content: `请求失败：${message}`,
                  createdAt: failedAt
                }
              ]
            }
          : current
      );
    } finally {
      setChatPending(false);
      setBusy(false);
    }
  }

  async function saveCurrentAnswer() {
    if (!projectId) return;
    if (chat?.id.startsWith("research:")) {
      setNotice(`研究笔记已保存到 ${chat.id.replace(/^research:/, "")}`);
      return;
    }
    const hasAnswer = chat?.messages.some((message) => message.role === "assistant");
    if (!chat?.id || !hasAnswer) {
      await runSearch(true);
      return;
    }
    setBusy(true);
    try {
      const payload = await api.saveChatAnswer(projectId, chat.id);
      setNotice(`已保存到 ${payload.savedPath}`);
      await refreshProjectData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadGraph() {
    if (!projectId) return;
    setBusy(true);
    try {
      setGraph(await api.graph(projectId));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runLint() {
    if (!projectId) return;
    setBusy(true);
    try {
      const payload = await api.lint(projectId);
      setIssues(payload.issues);
      setNotice(`知识库体检完成：${payload.issues.length} 个问题。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runResearch() {
    const topic = query.trim();
    if (!projectId || !topic) return;
    setBusy(true);
    try {
      const payload = await api.research(projectId, { topic });
      const timestamp = new Date().toISOString();
      setQuery("");
      setChatAttachments([]);
      setChat({
        id: `research:${payload.path}`,
        title: topic,
        createdAt: timestamp,
        updatedAt: timestamp,
        messages: [
          {
            role: "user",
            content: `深度研究：${topic}`,
            createdAt: timestamp
          },
          {
            role: "assistant",
            content: payload.markdown,
            citations: [payload.path],
            createdAt: timestamp
          }
        ]
      });
      setHits([]);
      setChatAttachments([]);
      setPreview(payload.markdown);
      setSelectedPath(payload.path);
      setView("search");
      await refreshProjectData();
      await refreshChats();
      setNotice(`研究笔记已保存到 ${payload.path}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadSettings() {
    if (!projectId) return;
    const payload = await api.settings(projectId);
    setSettings(payload.settings);
  }

  async function saveSettings() {
    if (!projectId || !settings) return;
    setBusy(true);
    try {
      const payload = await api.saveSettings(projectId, settings);
      setSettings(payload.settings);
      setNotice("设置已保存。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitClip(event: FormEvent) {
    event.preventDefault();
    if (!projectId || !clip.content.trim()) return;
    setBusy(true);
    try {
      await api.clip(projectId, clip);
      setClip({ title: "", url: "", content: "" });
      await refreshProjectData();
      setNotice("网页剪藏已进入摄入队列。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function setEditorContent(value: string) {
    setEditor(value);
    setPreview(value);
  }

  async function addChatFiles(files: FileList | File[] | null) {
    const selected = Array.from(files ?? []);
    if (!selected.length) return;
    try {
      const remaining = Math.max(0, CHAT_ATTACHMENT_LIMIT - chatAttachments.length);
      const attachments = await Promise.all(selected.slice(0, remaining).map(fileToChatAttachment));
      setChatAttachments((current) => [...current, ...attachments].slice(0, CHAT_ATTACHMENT_LIMIT));
      if (selected.length > remaining) setNotice(`一次最多附加 ${CHAT_ATTACHMENT_LIMIT} 个文件。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function removeChatAttachment(id: string) {
    setChatAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function selectChat(nextChat: ChatSession) {
    setChat(nextChat);
    setHits([]);
    setQuery("");
    setChatAttachments([]);
    setChatPending(false);
    const lastAnswer = [...nextChat.messages].reverse().find((message) => message.role === "assistant");
    if (lastAnswer) setPreview(lastAnswer.content);
    setView("search");
  }

  function startNewChat() {
    setChat(null);
    setHits([]);
    setQuery("");
    setChatAttachments([]);
    setChatPending(false);
    setPreview("");
    setView("search");
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
  const previewContent = view === "wiki" ? preview || editor : preview;

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
            <input value={newProject.name} onChange={(event) => setNewProject({ ...newProject, name: event.target.value })} />
          </label>
          <label>
            用途
            <textarea
              rows={4}
              value={newProject.description}
              onChange={(event) => setNewProject({ ...newProject, description: event.target.value })}
            />
          </label>
          <button className="primary" disabled={busy}>
            <FolderPlus size={18} />
            创建知识库
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="rail" aria-label="主功能">
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

      <aside className="sidebar">
        <div className="project-bar">
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button title="刷新" onClick={() => refreshProjectData()}>
            <RefreshCw size={18} />
          </button>
        </div>
        <div className="project-meta">
          <strong>{project?.name}</strong>
          <span>{project?.description || "本地 Markdown 知识库"}</span>
        </div>
        <div className="status-strip">
          <span className={running ? "pulse" : ""}>{running ? "摄入中" : "空闲"}</span>
          <span>{sourceTotal} 来源</span>
          <span>{wikiTotal} 页面</span>
        </div>
        <FileTree files={wikiFiles} selectedPath={selectedPath} onOpen={openFile} />
      </aside>

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <p>{viewTitle(view)}</p>
            <h2>{workspaceHeading}</h2>
          </div>
          <div className="actions">
            {view === "wiki" && (
              <button className="primary" onClick={saveCurrentFile} disabled={busy}>
                <Save size={18} />
                保存
              </button>
            )}
            {busy && <Loader2 className="spin" size={18} />}
          </div>
        </header>
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button title="关闭" onClick={() => setNotice("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {renderWorkspace()}
      </main>

      <aside className="preview-pane">
        <div className="pane-title">
          <FileText size={17} />
          <span>预览 / 回答</span>
        </div>
        <MarkdownPane content={previewContent} />
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
          />
        );
      case "files":
        return (
          <FilesView
            sources={fileSources}
            queue={queue}
            sourceTotal={sourceTotal}
            sourceBytesTotal={sourceBytesTotal}
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
            onOpen={openFile}
            onDelete={deleteSource}
          />
        );
      case "sources":
        return (
          <ClipSourceView
            clip={clip}
            setClip={setClip}
            onSubmitClip={submitClip}
          />
        );
      case "search":
        return (
          <AskView
            query={query}
            setQuery={setQuery}
            hits={hits}
            chat={chat}
            chats={chats}
            attachments={chatAttachments}
            busy={busy}
            pending={chatPending}
            useChatContext={useChatContext}
            onToggleContext={setUseChatContext}
            onAsk={() => runSearch(false)}
            onResearch={runResearch}
            onSave={saveCurrentAnswer}
            onNewChat={startNewChat}
            onSelectChat={selectChat}
            onAttachFiles={addChatFiles}
            onRemoveAttachment={removeChatAttachment}
            onOpen={openFile}
          />
        );
      case "graph":
        return <GraphView graph={graph} onReload={loadGraph} onOpen={openFile} />;
      case "lint":
        return <LintView issues={issues} onRun={runLint} onOpen={openFile} />;
      case "settings":
        return <SettingsView settings={settings} setSettings={setSettings} onReload={loadSettings} onSave={saveSettings} />;
      default:
        return null;
    }
  }
}

function MarkdownPane({ content }: { content: string }) {
  return (
    <Suspense fallback={<article className="markdown">Loading preview...</article>}>
      <MarkdownView content={content} />
    </Suspense>
  );
}

function MarkdownEditor({
  value,
  mode,
  textareaRef,
  onChange,
  onModeChange,
  onFormat
}: {
  value: string;
  mode: EditorMode;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onModeChange: (mode: EditorMode) => void;
  onFormat: (kind: "h1" | "h2" | "bold" | "italic" | "list" | "link" | "code" | "table") => void;
}) {
  return (
    <section className="editor-workbench">
      <div className="editor-toolbar">
        <div className="tool-group">
          <button title="一级标题" onClick={() => onFormat("h1")}>
            <Heading1 size={17} />
          </button>
          <button title="二级标题" onClick={() => onFormat("h2")}>
            <Heading2 size={17} />
          </button>
          <button title="加粗" onClick={() => onFormat("bold")}>
            <Bold size={17} />
          </button>
          <button title="斜体" onClick={() => onFormat("italic")}>
            <Italic size={17} />
          </button>
          <button title="列表" onClick={() => onFormat("list")}>
            <List size={17} />
          </button>
          <button title="链接" onClick={() => onFormat("link")}>
            <Link size={17} />
          </button>
          <button title="代码" onClick={() => onFormat("code")}>
            <Code2 size={17} />
          </button>
          <button title="表格" onClick={() => onFormat("table")}>
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
      <div className={`editor-grid mode-${mode}`}>
        {mode !== "preview" && (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
          />
        )}
        {mode !== "edit" && (
          <div className="embedded-preview">
            <MarkdownPane content={value} />
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
    const section = file.path.split("/")[1] || "root";
    acc[section] = [...(acc[section] || []), file];
    return acc;
  }, {});

  return (
    <nav className="file-tree">
      {Object.entries(grouped).map(([section, sectionFiles]) => (
        <div key={section} className="tree-section">
          <h3>{section}</h3>
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
  onDelete
}: {
  sources: SourceRecord[];
  queue: QueueItem[];
  sourceTotal: number;
  sourceBytesTotal: number;
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
  onDelete: (source: SourceRecord) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeQueueCount = queue.filter((item) => item.status === "queued" || item.status === "running").length;
  const visibleSources = sources;
  const visibleIds = visibleSources.map((source) => source.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
  const pageStart = fileTotal > 0 ? fileOffset + 1 : 0;
  const pageEnd = Math.min(fileOffset + visibleSources.length, fileTotal);
  const currentPage = fileTotal > 0 ? Math.floor(fileOffset / filePageSize) + 1 : 0;
  const pageCount = fileTotal > 0 ? Math.ceil(fileTotal / filePageSize) : 0;
  const canPrev = fileOffset > 0;
  const canNext = fileOffset + visibleSources.length < fileTotal;

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
          <button className="primary" type="button" onClick={() => fileInputRef.current?.click()}>
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
          <button type="button" onClick={onRescan}>
            <RefreshCw size={17} />
            扫描
          </button>
          <button type="button" onClick={onRefresh}>
            <RefreshCw size={17} />
            刷新
          </button>
          {selectedIds.length > 0 && <span className="selected-count">已选 {selectedIds.length}</span>}
        </div>
        <div className="file-search">
          <input
            placeholder="搜索文件名、路径、类型或状态"
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
          <span>处理中</span>
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
                    <small>{source.fileName}</small>
                  </span>
                </td>
                <td>
                  <span className={`file-status ${source.status}`}>{sourceStatusLabel(source.status)}</span>
                </td>
                <td>{source.kind}</td>
                <td>{formatBytes(source.size)}</td>
                <td>{formatDateTime(source.updatedAt || source.importedAt)}</td>
                <td className="path-cell" title={source.relativePath}>{source.relativePath}</td>
                <td>
                  <div className="file-row-actions">
                    <button type="button" onClick={() => onOpen(source.relativePath)}>原文</button>
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
          <button type="button" disabled={!canPrev || loading} onClick={() => onPageChange(Math.max(0, fileOffset - filePageSize))}>
            上一页
          </button>
          <button type="button" disabled={!canNext || loading} onClick={() => onPageChange(fileOffset + filePageSize)}>
            下一页
          </button>
        </div>
      </div>

      <section className="file-queue-panel">
        <div className="section-toolbar">
          <h3>摄入队列{queueTotal > queue.length ? `（最近 ${queue.length} / ${queueTotal}）` : ""}</h3>
        </div>
        <div className="queue-table">
          {queue.slice().reverse().slice(0, 18).map((item) => (
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
  onSubmitClip
}: {
  clip: { title: string; url: string; content: string };
  setClip: (clip: { title: string; url: string; content: string }) => void;
  onSubmitClip: (event: FormEvent) => void;
}) {
  return (
    <section className="clip-page">
      <form className="clip-form clip-form-main" onSubmit={onSubmitClip}>
        <h3>Web Clip API</h3>
        <input placeholder="标题" value={clip.title} onChange={(event) => setClip({ ...clip, title: event.target.value })} />
        <input placeholder="URL" value={clip.url} onChange={(event) => setClip({ ...clip, url: event.target.value })} />
        <textarea
          rows={12}
          placeholder="粘贴网页正文或 Markdown"
          value={clip.content}
          onChange={(event) => setClip({ ...clip, content: event.target.value })}
        />
        <button className="primary">
          <Play size={17} />
          入队
        </button>
      </form>
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
  query,
  setQuery,
  hits,
  chat,
  chats,
  attachments,
  busy,
  pending,
  useChatContext,
  onToggleContext,
  onAsk,
  onResearch,
  onSave,
  onNewChat,
  onSelectChat,
  onAttachFiles,
  onRemoveAttachment,
  onOpen
}: {
  query: string;
  setQuery: (query: string) => void;
  hits: SearchHit[];
  chat: ChatSession | null;
  chats: ChatSession[];
  attachments: ChatAttachment[];
  busy: boolean;
  pending: boolean;
  useChatContext: boolean;
  onToggleContext: (enabled: boolean) => void;
  onAsk: () => void;
  onResearch: () => void;
  onSave: () => void;
  onNewChat: () => void;
  onSelectChat: (chat: ChatSession) => void;
  onAttachFiles: (files: FileList | File[] | null) => void;
  onRemoveAttachment: (id: string) => void;
  onOpen: (path: string) => void;
}) {
  const messages = chat?.messages.filter((message) => message.role !== "system").slice(-40) ?? [];
  const sessions = useMemo(() => {
    const items = chat && !chat.id.startsWith("pending-") && !chat.id.startsWith("research:")
      ? [chat, ...chats.filter((item) => item.id !== chat.id)]
      : chats;
    return items.slice(0, 60);
  }, [chat, chats]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, pending]);

  return (
    <section className="search-surface ask-surface">
      <div className="ask-layout">
        <aside className="chat-sessions" aria-label="聊天会话">
          <button className="new-chat-button" type="button" onClick={onNewChat}>
            <Plus size={17} />
            新建会话
          </button>
          <label className="context-toggle" title="开启后会结合本会话前面的问答理解追问；关闭后只回答本轮问题。">
            <input
              type="checkbox"
              checked={useChatContext}
              onChange={(event) => onToggleContext(event.target.checked)}
            />
            <span>
              <strong>联系上下文</strong>
              <small>{useChatContext ? "连续追问" : "单轮回答"}</small>
            </span>
          </label>
          <div className="chat-session-list">
            {sessions.map((item) => {
              const last = [...item.messages].reverse().find((message) => message.role !== "system");
              return (
                <button
                  key={item.id}
                  className={chat?.id === item.id ? "active" : ""}
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
                key={`${message.createdAt}-${index}`}
                message={message}
                onOpen={onOpen}
              />
            ))
          ) : (
            <div className="chat-empty">
              <MessageSquare size={30} />
              <h3>向知识库提问</h3>
              <p>可以新建多个会话分开主题；开启联系上下文后，追问会自动结合本会话前面的内容。</p>
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
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="composer-actions">
            <button
              className={`context-pill ${useChatContext ? "active" : ""}`}
              type="button"
              onClick={() => onToggleContext(!useChatContext)}
              title={useChatContext ? "本轮会结合当前会话上下文" : "本轮只按当前输入回答"}
            >
              {useChatContext ? "连续" : "单轮"}
            </button>
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
                  const files = event.currentTarget.files;
                  event.currentTarget.value = "";
                  onAttachFiles(files);
                }}
              />
            </div>
            <button type="button" onClick={onSave} title="保存回答">
              <Save size={18} />
            </button>
            <button
              className="research-action"
              type="button"
              disabled={busy || !query.trim()}
              onClick={onResearch}
              title="深度研究"
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
    </section>
  );
}

function ChatMessageView({ message, onOpen }: { message: ChatSession["messages"][number]; onOpen: (path: string) => void }) {
  return (
    <article className={`chat-message ${message.role}`}>
      <div className="message-avatar">{message.role === "user" ? "你" : "AI"}</div>
      <div className="message-body">
        <div className="message-meta">{message.role === "user" ? "你" : "助手"}</div>
        {message.role === "assistant" ? (
          <div className="message-content">
            <MarkdownPane content={message.content} />
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
              <button key={`${citation}-${citationIndex}`} onClick={() => onOpen(citation)}>
                来源 {citationIndex + 1}
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
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
  const viewWidth = 680 / zoom;
  const viewHeight = 540 / zoom;
  const viewBox = `${340 - viewWidth / 2} ${270 - viewHeight / 2} ${viewWidth} ${viewHeight}`;
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
          <input placeholder="过滤节点" value={query} onChange={(event) => setQuery(event.target.value)} />
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
  onRun,
  onOpen
}: {
  issues: LintIssue[];
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
        <button onClick={onRun}>
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
            <strong>还没有体检结果</strong>
            <p>点击“开始检查”后，会列出断链、缺少元数据、来源缺失、重复标题和摄入失败等问题。没有问题时这里会保持为空。</p>
          </div>
        )}
      </div>
    </section>
  );
}

function SettingsView({
  settings,
  setSettings,
  onReload,
  onSave
}: {
  settings: ProjectSettings | null;
  setSettings: (settings: ProjectSettings) => void;
  onReload: () => void;
  onSave: () => void;
}) {
  if (!settings) {
    return (
      <section className="settings-grid">
        <button onClick={onReload}>
          <RefreshCw size={17} />
          加载设置
        </button>
      </section>
    );
  }
  return (
    <section className="settings-grid">
      <label>
        模型提供方
        <select
          value={settings.provider}
          onChange={(event) => {
            const provider = event.target.value as ProjectSettings["provider"];
            setSettings({ ...settings, provider, ...PROVIDER_DEFAULTS[provider] });
          }}
        >
          <option value="offline">offline</option>
          <option value="openai">openai</option>
          <option value="volcengine">volcengine</option>
          <option value="volcengine-coding-plan">volcengine-coding-plan</option>
          <option value="ollama">ollama</option>
          <option value="anthropic">anthropic</option>
          <option value="gemini">gemini</option>
          <option value="custom">custom</option>
        </select>
      </label>
      <label>
        模型
        <input value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} />
      </label>
      <label>
        Base URL
        <input value={settings.baseUrl} onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} />
      </label>
      <label>
        API Key
        <input
          type="password"
          value={settings.apiKey || ""}
          onChange={(event) => setSettings({ ...settings, apiKey: event.target.value })}
        />
      </label>
      <label>
        Web Search
        <select
          value={settings.webSearchProvider}
          onChange={(event) =>
            setSettings({ ...settings, webSearchProvider: event.target.value as ProjectSettings["webSearchProvider"] })
          }
        >
          <option value="none">none</option>
          <option value="searxng">searxng</option>
          <option value="tavily">tavily</option>
          <option value="serpapi">serpapi</option>
        </select>
      </label>
      <label>
        Search URL
        <input
          value={settings.webSearchUrl || ""}
          onChange={(event) => setSettings({ ...settings, webSearchUrl: event.target.value })}
        />
      </label>
      <label className="wide">
        系统提示词
        <textarea
          rows={6}
          value={settings.systemPrompt}
          onChange={(event) => setSettings({ ...settings, systemPrompt: event.target.value })}
        />
      </label>
      <div className="settings-actions">
        <button onClick={onReload}>
          <RefreshCw size={17} />
          重载
        </button>
        <button className="primary" onClick={onSave}>
          <Save size={17} />
          保存设置
        </button>
      </div>
    </section>
  );
}

async function fileToChatAttachment(file: File): Promise<ChatAttachment> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const base: ChatAttachment = {
    id,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    kind: file.type.startsWith("image/") ? "image" : isTextLikeFile(file) ? "text" : "file"
  };

  if (base.kind === "image" && file.size <= CHAT_ATTACHMENT_IMAGE_MAX_BYTES) {
    return { ...base, dataUrl: await readFileAsDataUrl(file) };
  }

  if (base.kind === "text") {
    const text = await readFileAsText(file);
    return { ...base, text: text.slice(0, CHAT_ATTACHMENT_TEXT_LIMIT) };
  }

  return base;
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

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

function viewTitle(view: ViewKey): string {
  return VIEWS.find((item) => item.key === view)?.label || "工作台";
}

function sourceStatusLabel(status: SourceRecord["status"]): string {
  return {
    queued: "待摄入",
    ingesting: "摄入中",
    ready: "已完成",
    skipped: "已跳过",
    failed: "失败"
  }[status];
}

function queueStatusLabel(status: QueueItem["status"]): string {
  return {
    queued: "等待",
    running: "处理中",
    done: "完成",
    failed: "失败"
  }[status];
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
