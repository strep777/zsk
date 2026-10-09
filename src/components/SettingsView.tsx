import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Save, X, LoaderCircle } from "lucide-react";
import { api } from "../api";
import type { ModelProfile, ProjectSettings, ProviderKind } from "../types";

type Response = Awaited<ReturnType<typeof api.diagnoseSettings>>;
type Result = { signature: string; pending: boolean; ok?: boolean; message: string; response?: string; latencyMs?: number };
const addresses: Record<ProviderKind, string> = {
  offline: "", custom: "", openai: "https://api.openai.com/v1",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3", "volcengine-coding-plan": "https://ark.cn-beijing.volces.com/api/coding/v3",
  ollama: "http://localhost:11434", anthropic: "https://api.anthropic.com", gemini: "https://generativelanguage.googleapis.com"
};
const providerNames: Record<ProviderKind, string> = {
  offline: "摘要模式", openai: "OpenAI", custom: "OpenAI 兼容服务", ollama: "Ollama",
  anthropic: "Anthropic", gemini: "Gemini", volcengine: "火山引擎", "volcengine-coding-plan": "火山 Coding Plan"
};
function id(prefix: string) { return `${prefix}-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)}`; }
function list(value: string): string[] { return [...new Set(value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean))]; }
function configured(profile: ModelProfile) { return profile.provider !== "offline" && Boolean(profile.model.trim() && profile.baseUrl.trim() && (["ollama", "custom"].includes(profile.provider) || profile.apiKey?.trim())); }
function connection(profile?: ModelProfile) { return profile ? { provider: profile.provider, baseUrl: profile.baseUrl, apiKey: profile.apiKey } : null; }
function searchConnection(settings: ProjectSettings) { return JSON.stringify([settings.webSearchProvider, settings.webSearchUrl, settings.webSearchApiKey]); }

export function SettingsView({ projectId, settings, setSettings, onReload, onSave, busy }: {
  projectId: string; settings: ProjectSettings | null; setSettings: (settings: ProjectSettings) => void;
  onReload: () => void; onSave: () => void; busy: boolean;
}) {
  const [results, setResults] = useState<Record<string, Result>>({});
  const [models, setModels] = useState<Record<string, { signature: string; values: string[] }>>({});
  const [collections, setCollections] = useState<{ signature: string; values: string[] } | null>(null);
  const [listDrafts, setListDrafts] = useState<Record<string, { signature: string; text: string }>>({});
  const [testingAll, setTestingAll] = useState(false);
  const current = useRef(settings), draftSettings = useRef(settings), mounted = useRef(true);
  const pending = useRef(new Set<string>());
  current.current = settings;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (settings !== draftSettings.current) {
      draftSettings.current = settings;
      setListDrafts({});
    }
  }, [settings]);

  const signature = (key: string, value: ProjectSettings | null): string => {
    if (!value) return "";
    const [kind, itemId] = key.split(":");
    if (kind === "models") return JSON.stringify(connection(value.modelProfiles.find((profile) => profile.id === itemId)));
    if (kind === "model") return JSON.stringify(value.modelProfiles.find((profile) => profile.id === itemId));
    if (kind === "mcp") {
      const server = value.mcpServers.find((item) => item.id === itemId);
      return JSON.stringify(server && { transport: server.transport, url: server.url, command: server.command, args: server.args, apiKey: server.apiKey });
    }
    if (kind === "skill") return JSON.stringify(value.skills.find((item) => item.id === itemId));
    if (kind === "skill-test") return JSON.stringify({ skill: value.skills.find((item) => item.id === itemId), prompt: value.systemPrompt, models: value.modelProfiles, active: value.activeModelId });
    if (kind === "prompt") return JSON.stringify({ prompt: value.systemPrompt, models: value.modelProfiles, active: value.activeModelId });
    if (kind === "web-collections") return JSON.stringify([value.webSearchProvider, value.webSearchUrl, value.webSearchApiKey, value.webSearchCollection]);
    if (kind === "web") return JSON.stringify([value.webSearchProvider, value.webSearchUrl, value.webSearchApiKey, value.webSearchCollection, value.webSearchQueryBy]);
    return JSON.stringify([value.localSearchProvider, value.typesenseUrl, value.typesenseApiKey, value.typesenseCollection]);
  };
  const run = async (key: string, action: string, body: unknown, apply?: (response: Response, latest: ProjectSettings) => ProjectSettings | void) => {
    if (!mounted.current || !current.current || pending.current.has(key)) return;
    if ((key === "web" || key === "web-collections") && (pending.current.has("web") || pending.current.has("web-collections"))) return;
    const initial = signature(key, current.current);
    pending.current.add(key);
    setResults((old) => ({ ...old, [key]: { signature: initial, pending: true, message: "正在测试，请稍候…" } }));
    try {
      const response = await api.diagnoseSettings(projectId, action, body);
      if (!mounted.current || !current.current || signature(key, current.current) !== initial) return;
      const updated = apply?.(response, current.current);
      if (updated) { current.current = updated; draftSettings.current = updated; setSettings(updated); }
      setResults((old) => ({ ...old, [key]: { signature: signature(key, current.current), pending: false, ok: true, ...response } }));
    } catch (error) {
      if (!mounted.current || signature(key, current.current) !== initial) return;
      setResults((old) => ({ ...old, [key]: { signature: initial, pending: false, ok: false, message: error instanceof Error ? error.message : String(error) } }));
    } finally {
      pending.current.delete(key);
      if (mounted.current) setResults((old) => {
        if (!old[key]?.pending) return old;
        const next = { ...old };
        delete next[key];
        return next;
      });
    }
  };
  const working = (key: string) => busy || testingAll || Boolean(results[key]?.pending)
    || ((key === "web" || key === "web-collections") && Boolean(results.web?.pending || results["web-collections"]?.pending));
  const status = (key: string) => {
    const result = results[key];
    if (!result || result.signature !== signature(key, settings)) return null;
    return <div className={`settings-diagnostic ${result.pending ? "pending" : result.ok ? "success" : "error"}`} role={result.ok === false ? "alert" : "status"}>
      <span>{result.pending && <LoaderCircle size={14} className="spin" />}{result.message}{result.latencyMs !== undefined && `（${result.latencyMs} ms）`}</span>
      {result.response && <pre>{result.response}</pre>}
    </div>;
  };
  if (!settings) return <section className="settings-grid"><button onClick={onReload} disabled={busy}><RefreshCw size={17} />加载设置</button></section>;
  const collectionValues = collections?.signature === searchConnection(settings) ? collections.values : [];

  const update = (patch: Partial<ProjectSettings>) => {
    const updated = { ...current.current!, ...patch };
    current.current = updated;
    draftSettings.current = updated;
    setSettings(updated);
    return updated;
  };
  const listValue = (key: string, values: string[] | undefined, separator: string) => listDrafts[key]?.signature === JSON.stringify(values || []) ? listDrafts[key].text : (values || []).join(separator);
  const editList = (key: string, text: string, parse: (text: string) => string[] = list) => {
    const values = parse(text);
    setListDrafts((old) => ({ ...old, [key]: { signature: JSON.stringify(values), text } }));
    return values;
  };
  const discoverCollections = (value: ProjectSettings) => run("web-collections", "web-search-collections", { settings: value }, (response, latest) => {
    setCollections({ signature: searchConnection(latest), values: response.collections || [] });
    return response.queryBy && !latest.webSearchQueryBy?.trim() ? { ...latest, webSearchQueryBy: response.queryBy } : undefined;
  });
  const updateModel = (itemId: string, patch: Partial<ModelProfile>) => {
    const latest = current.current!;
    const profiles = latest.modelProfiles.map((profile) => profile.id === itemId ? { ...profile, ...patch } : profile);
    const active = profiles.find((profile) => profile.id === latest.activeModelId && profile.enabled && configured(profile)) || profiles.find((profile) => profile.enabled && configured(profile));
    update({ modelProfiles: profiles, activeModelId: active?.id, provider: active?.provider || "offline", model: active?.model || "", baseUrl: active?.baseUrl || "", apiKey: active?.apiKey });
  };
  const updateSkill = (itemId: string, patch: Partial<ProjectSettings["skills"][number]>) => update({ skills: current.current!.skills.map((item) => item.id === itemId ? { ...item, ...patch } : item) });
  const updateMcp = (itemId: string, patch: Partial<ProjectSettings["mcpServers"][number]>) => update({ mcpServers: current.current!.mcpServers.map((item) => item.id === itemId ? { ...item, ...patch } : item) });
  const testAll = async () => {
    if (testingAll) return;
    setTestingAll(true);
    try {
      for (const initial of settings.modelProfiles.filter((profile) => profile.enabled)) {
        const profile = current.current?.modelProfiles.find((item) => item.id === initial.id);
        if (mounted.current && profile?.enabled) await run(`model:${profile.id}`, "model-test", { profile });
      }
      if (!mounted.current || !current.current) return;
      await run("builtin", "builtin-search", {});
      if (current.current?.webSearchProvider !== "none") await run("web", "web-search", { settings: current.current });
      for (const initial of settings.mcpServers.filter((server) => server.enabled)) {
        const server = current.current?.mcpServers.find((item) => item.id === initial.id);
        if (mounted.current && server?.enabled) await run(`mcp:${server.id}`, "mcp", { server });
      }
    } finally { if (mounted.current) setTestingAll(false); }
  };
  const validateSkill = (skill: ProjectSettings["skills"][number]) => {
    const message = !skill.name.trim() ? "请填写 Skill 名称。" : !skill.prompt.trim() ? "请填写 Skill 指令。" : /\uFFFD/.test(skill.prompt + skill.name) ? "指令含有无法识别字符，请修改后再试。" : "指令格式有效；可使用“测试效果”查看模型的实际回答。";
    setResults((old) => ({ ...old, [`skill:${skill.id}`]: { signature: signature(`skill:${skill.id}`, current.current), pending: false, ok: message.startsWith("指令格式有效"), message } }));
  };
  return <section className="settings-view" aria-label="知识库设置"><div className="settings-grid">
    <div className="settings-intro wide">
      <p>测试和获取会使用当前填写的配置；保存后应用到知识库。模型测试会发送一条简短请求。</p>
      <button onClick={() => void testAll()} disabled={busy || testingAll || Boolean(pending.current.size)}>
        {testingAll ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{testingAll ? "正在测试连接…" : "测试全部连接"}
      </button>
    </div>
    <div className="settings-panel wide">
      <div className="settings-panel-title"><div><strong>模型卡片</strong><p>获取服务中的模型，再测试实际回答。启用并保存的模型可在查询页选择。</p></div>
        <button type="button" disabled={busy || settings.modelProfiles.length >= 24} onClick={() => update({ modelProfiles: [...settings.modelProfiles, { id: id("model"), name: "", provider: "custom", model: "", baseUrl: "", apiKey: "", enabled: true }] })}><Plus size={16} />添加模型</button>
      </div>
      <div className="settings-list model-card-list">
        {settings.modelProfiles.map((profile) => {
          const values = models[profile.id]?.signature === JSON.stringify(connection(profile)) ? models[profile.id].values : [];
          const usable = configured(profile) && profile.enabled;
          const tested = results[`model:${profile.id}`]?.ok && results[`model:${profile.id}`]?.signature === signature(`model:${profile.id}`, settings);
          return <div className={`settings-card model-profile-card${settings.activeModelId === profile.id && usable ? " active" : ""}`} key={profile.id}>
            <div className="settings-card-head">
              <label className="toggle-row"><input type="checkbox" checked={profile.enabled} onChange={(event) => updateModel(profile.id, { enabled: event.target.checked })} />启用</label>
              <div className="settings-card-actions">
                <button disabled={!usable || busy} onClick={() => update({ activeModelId: profile.id, provider: profile.provider, model: profile.model, baseUrl: profile.baseUrl, apiKey: profile.apiKey })}>{settings.activeModelId === profile.id ? "默认" : "设为默认"}</button>
                <button title="删除模型" disabled={busy} onClick={() => {
                  const profiles = settings.modelProfiles.filter((item) => item.id !== profile.id);
                  const active = profiles.find((item) => item.id === settings.activeModelId) || profiles.find((item) => item.enabled && configured(item));
                  update({ modelProfiles: profiles, activeModelId: active?.id, provider: active?.provider || "offline", model: active?.model || "", baseUrl: active?.baseUrl || "", apiKey: active?.apiKey });
                }}><X size={15} /></button>
              </div>
            </div>
            <div className="capability-grid">
              <label>名称<input value={profile.name} placeholder="选填，用于区分模型" onChange={(event) => updateModel(profile.id, { name: event.target.value })} /></label>
              <label>提供商<select value={profile.provider} onChange={(event) => { const provider = event.target.value as ProviderKind; updateModel(profile.id, { provider, model: "", baseUrl: addresses[provider], apiKey: "" }); }}>{Object.entries(providerNames).filter(([key]) => key !== "offline").map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
              <label>模型<input value={profile.model} list={`models-${profile.id}`} placeholder="点击获取模型，或输入模型 ID" onChange={(event) => updateModel(profile.id, { model: event.target.value })} />
                <datalist id={`models-${profile.id}`}>{values.map((value) => <option key={value} value={value} />)}</datalist>
              </label>
              <label>Base URL<input value={profile.baseUrl} placeholder={addresses[profile.provider] || "填写 OpenAI 兼容服务地址"} onChange={(event) => updateModel(profile.id, { baseUrl: event.target.value })} /></label>
              <label className="wide">API Key<input type="password" autoComplete="new-password" value={profile.apiKey || ""} placeholder={["ollama", "custom"].includes(profile.provider) ? "本地服务可留空；有代理鉴权时填写密钥" : "填写模型服务密钥"} onChange={(event) => updateModel(profile.id, { apiKey: event.target.value })} /></label>
              {values.length > 0 && <label className="wide">服务模型列表<select aria-label="服务模型列表" value={values.includes(profile.model) ? profile.model : ""} onChange={(event) => updateModel(profile.id, { model: event.target.value })}><option value="">选择服务返回的模型</option>{values.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
              <p className={`model-card-status ${tested && usable ? "ready" : usable ? "configured" : "missing"}`}>{settings.activeModelId === profile.id && usable ? "当前默认模型 · " : ""}{usable ? tested ? "模型测试已通过。" : "字段已填写，请测试实际可用性。" : "请完成模型和服务地址配置；未启用或未完整配置的卡片不会出现在查询页。"}</p>
            </div>
            <div className="settings-test-actions">
              <button disabled={working(`models:${profile.id}`)} onClick={() => void run(`models:${profile.id}`, "models", { profile }, (response, latest) => {
                setModels((old) => ({ ...old, [profile.id]: { signature: JSON.stringify(connection(profile)), values: response.models || [] } }));
                const latestProfile = latest.modelProfiles.find((item) => item.id === profile.id);
                if (latestProfile && latestProfile.model === profile.model && !latestProfile.model.trim() && response.models?.length === 1) {
                  const filled = { ...latestProfile, model: response.models[0] };
                  return { ...latest, modelProfiles: latest.modelProfiles.map((item) => item.id === profile.id ? filled : item),
                    ...(!latest.activeModelId && filled.enabled && configured(filled) ? { activeModelId: filled.id, provider: filled.provider, model: filled.model, baseUrl: filled.baseUrl, apiKey: filled.apiKey } : {}) };
                }
              })}>{results[`models:${profile.id}`]?.pending ? "正在获取…" : "获取模型"}</button>
              <button disabled={working(`model:${profile.id}`)} onClick={() => void run(`model:${profile.id}`, "model-test", { profile })}>{results[`model:${profile.id}`]?.pending ? "正在测试…" : "测试模型"}</button>
            </div>
            {status(`models:${profile.id}`)}{status(`model:${profile.id}`)}
          </div>;
        })}
        {!settings.modelProfiles.length && <p className="muted">尚未配置模型。添加模型后可获取列表并测试，查询也可以使用摘要模式。</p>}
      </div>
    </div>
    <div className="settings-panel wide">
      <div className="settings-panel-title"><div><strong>本地知识库搜索</strong><p>使用内置文件搜索读取知识库和已摄入资料，知识库内容保留在应用中。</p></div></div>
      <p>当前引擎：内置文件搜索</p>
      <div className="settings-test-actions"><button disabled={working("builtin")} onClick={() => void run("builtin", "builtin-search", {})}>{results.builtin?.pending ? "正在检查…" : "检查内置搜索配置"}</button></div>
      {status("builtin")}
    </div>
    <div className="settings-panel wide">
      <div className="settings-panel-title"><div><strong>外部搜索</strong><p>用于查询和研究时补充网络资料；连接测试只验证选择的搜索服务。</p></div></div>
      <div className="capability-grid">
        <label>搜索服务<select value={settings.webSearchProvider} onChange={(event) => { update({ webSearchProvider: event.target.value as ProjectSettings["webSearchProvider"], webSearchUrl: "", webSearchApiKey: "", webSearchCollection: "", webSearchQueryBy: "" }); setCollections(null); }}><option value="typesense">Typesense</option><option value="none">关闭</option><option value="searxng">SearXNG</option><option value="tavily">Tavily</option><option value="serpapi">SerpAPI</option></select></label>
        <label>搜索地址<input value={settings.webSearchUrl || ""} placeholder={settings.webSearchProvider === "typesense" ? "http://localhost:8108" : settings.webSearchProvider === "tavily" ? "留空使用 Tavily 官方接口" : settings.webSearchProvider === "serpapi" ? "留空使用 SerpAPI 官方接口" : "填写 SearXNG 服务地址"} disabled={settings.webSearchProvider === "none"} onChange={(event) => { update({ webSearchUrl: event.target.value }); setCollections(null); }} /></label>
        <label className="wide">搜索 API Key<input type="password" autoComplete="new-password" value={settings.webSearchApiKey || ""} disabled={settings.webSearchProvider === "none"} onChange={(event) => update({ webSearchApiKey: event.target.value })} /></label>
        {settings.webSearchProvider === "typesense" && <>
          <label>网页索引集合<input value={settings.webSearchCollection || ""} list="web-typesense-collections" placeholder="选择已有网页资料的集合" onChange={(event) => update({ webSearchCollection: event.target.value, webSearchQueryBy: "" })} /><datalist id="web-typesense-collections">{collectionValues.map((value) => <option key={value} value={value} />)}</datalist></label>
          <label>检索字段<input value={settings.webSearchQueryBy || ""} placeholder="留空自动获取，例如 title,content" onChange={(event) => update({ webSearchQueryBy: event.target.value })} /></label>
          {collectionValues.length > 0 && <label className="wide">服务集合列表<select aria-label="选择网页索引集合" value={collectionValues.includes(settings.webSearchCollection || "") ? settings.webSearchCollection : ""} disabled={working("web-collections")} onChange={(event) => {
            const latest = update({ webSearchCollection: event.target.value, webSearchQueryBy: "" });
            if (latest.webSearchCollection) void discoverCollections(latest);
          }}><option value="">选择集合（自动获取字段）</option>{collectionValues.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>}
          <p className="muted wide">选择服务集合后自动获取检索字段；只有检索权限时，可手动填写集合和字段。集合需已有网页资料，包含 url（或 link、canonical_url）及正文；应用不会向集合写入知识库资料。</p>
        </>}
      </div>
      <div className="settings-test-actions">{settings.webSearchProvider === "typesense" && <button disabled={working("web-collections")} onClick={() => void discoverCollections(settings)}>{results["web-collections"]?.pending ? "正在获取…" : "获取集合和字段"}</button>}<button disabled={working("web") || settings.webSearchProvider === "none"} onClick={() => void run("web", "web-search", { settings }, (response, latest) => response.queryBy && !latest.webSearchQueryBy?.trim() ? { ...latest, webSearchQueryBy: response.queryBy } : undefined)}>{results.web?.pending ? "正在测试…" : "测试搜索"}</button></div>{status("web-collections")}{status("web")}
    </div>
    <div className="settings-panel wide">
      <label>系统提示词<textarea rows={12} value={settings.systemPrompt} placeholder="留空使用默认知识库问答规则" onChange={(event) => update({ systemPrompt: event.target.value })} /></label>
      <div className="settings-test-actions"><button disabled={working("prompt")} onClick={() => void run("prompt", "prompt-test", { settings })}>{results.prompt?.pending ? "正在测试…" : "测试提示词"}</button></div>{status("prompt")}
    </div>
    <div className="settings-panel wide">
      <div className="settings-panel-title"><div><strong>Skill 能力</strong><p>查询会加载已启用的指令；验证格式后，可用默认模型测试指令效果。</p></div><button disabled={busy || settings.skills.length >= 24} onClick={() => update({ skills: [...settings.skills, { id: id("skill"), name: "", prompt: "", description: "", tags: [], enabled: true }] })}><Plus size={16} />添加 Skill</button></div>
      <div className="settings-list">{settings.skills.map((skill) => <div className="settings-card" key={skill.id}>
        <div className="settings-card-head"><label className="toggle-row"><input type="checkbox" checked={skill.enabled} onChange={(event) => updateSkill(skill.id, { enabled: event.target.checked })} />启用</label><button title="删除 Skill" disabled={busy} onClick={() => update({ skills: settings.skills.filter((item) => item.id !== skill.id) })}><X size={15} /></button></div>
        <div className="capability-grid">
          <label>名称<input value={skill.name} placeholder="填写 Skill 名称" onChange={(event) => updateSkill(skill.id, { name: event.target.value })} /></label>
          <label>标签<input value={listValue(`tags:${skill.id}`, skill.tags, ", ")} placeholder="选填，使用逗号分隔" onChange={(event) => updateSkill(skill.id, { tags: editList(`tags:${skill.id}`, event.target.value) })} /></label>
          <label className="wide">说明<input value={skill.description || ""} placeholder="适用的任务" onChange={(event) => updateSkill(skill.id, { description: event.target.value })} /></label>
          <label className="wide">Skill 指令<textarea rows={4} value={skill.prompt} placeholder="填写真实任务规则" onChange={(event) => updateSkill(skill.id, { prompt: event.target.value })} /></label>
        </div>
        <div className="settings-test-actions"><button onClick={() => validateSkill(skill)}>验证指令</button><button disabled={working(`skill-test:${skill.id}`)} onClick={() => void run(`skill-test:${skill.id}`, "prompt-test", { settings, prompt: [settings.systemPrompt, skill.prompt].filter(Boolean).join("\n\n") })}>{results[`skill-test:${skill.id}`]?.pending ? "正在测试…" : "测试效果"}</button></div>{status(`skill:${skill.id}`)}{status(`skill-test:${skill.id}`)}
      </div>)}{!settings.skills.length && <p className="muted">尚未添加 Skill。</p>}</div>
    </div>
    <div className="settings-panel wide">
      <div className="settings-panel-title"><div><strong>MCP 服务器</strong><p>支持 HTTP、SSE 和 stdio。连接测试会初始化协议并读取工具和资源目录。</p></div><button disabled={busy || settings.mcpServers.length >= 16} onClick={() => update({ mcpServers: [...settings.mcpServers, { id: id("mcp"), name: "", transport: "http", url: "", tools: [], resources: [], enabled: true }] })}><Plus size={16} />添加 MCP</button></div>
      <div className="settings-list">{settings.mcpServers.map((server) => <div className="settings-card" key={server.id}>
        <div className="settings-card-head"><label className="toggle-row"><input type="checkbox" checked={server.enabled} onChange={(event) => updateMcp(server.id, { enabled: event.target.checked })} />启用</label><button title="删除 MCP 服务器" disabled={busy} onClick={() => update({ mcpServers: settings.mcpServers.filter((item) => item.id !== server.id) })}><X size={15} /></button></div>
        <div className="capability-grid">
          <label>名称<input value={server.name} placeholder="选填，连接后可获取服务名称" onChange={(event) => updateMcp(server.id, { name: event.target.value })} /></label>
          <label>传输方式<select value={server.transport} onChange={(event) => updateMcp(server.id, { transport: event.target.value as typeof server.transport })}><option value="http">HTTP</option><option value="sse">SSE</option><option value="stdio">stdio</option></select></label>
          {server.transport === "stdio" ? <>
            <label>命令<input value={server.command || ""} placeholder="填写后端服务器上的可执行文件" onChange={(event) => updateMcp(server.id, { command: event.target.value })} /></label>
            <label>参数（每行一个）<textarea rows={3} value={listValue(`args:${server.id}`, server.args, "\n")} onChange={(event) => updateMcp(server.id, { args: editList(`args:${server.id}`, event.target.value, (text) => text.split("\n").filter(Boolean)) })} /></label>
          </> : <>
            <label className="wide">URL<input value={server.url || ""} placeholder="填写真实的 MCP 服务地址" onChange={(event) => updateMcp(server.id, { url: event.target.value })} /></label>
            <label className="wide">MCP API Key<input type="password" autoComplete="new-password" value={server.apiKey || ""} placeholder="选填，以 Bearer 方式发送" onChange={(event) => updateMcp(server.id, { apiKey: event.target.value })} /></label>
          </>}
          <label className="wide">说明<input value={server.description || ""} placeholder="服务提供的能力" onChange={(event) => updateMcp(server.id, { description: event.target.value })} /></label>
          <label>工具（每行一个）<textarea rows={3} value={listValue(`tools:${server.id}`, server.tools, "\n")} placeholder="连接后自动获取" onChange={(event) => updateMcp(server.id, { tools: editList(`tools:${server.id}`, event.target.value) })} /></label>
          <label>资源（每行一个）<textarea rows={3} value={listValue(`resources:${server.id}`, server.resources, "\n")} placeholder="连接后自动获取" onChange={(event) => updateMcp(server.id, { resources: editList(`resources:${server.id}`, event.target.value) })} /></label>
        </div>
        <div className="settings-test-actions">
          <button disabled={working(`mcp:${server.id}`)} onClick={() => void run(`mcp:${server.id}`, "mcp", { server })}>{results[`mcp:${server.id}`]?.pending ? "正在连接…" : "测试 MCP 连接"}</button>
          <button disabled={working(`mcp:${server.id}`)} onClick={() => void run(`mcp:${server.id}`, "mcp", { server }, (response, latest) => ({ ...latest, mcpServers: latest.mcpServers.map((item) => item.id === server.id ? {
            ...item, name: item.name || response.name || "",
            tools: JSON.stringify(item.tools) === JSON.stringify(server.tools) ? response.tools || [] : item.tools,
            resources: JSON.stringify(item.resources) === JSON.stringify(server.resources) ? response.resources || [] : item.resources
          } : item) }))}>获取工具和资源</button>
        </div>{status(`mcp:${server.id}`)}
      </div>)}{!settings.mcpServers.length && <p className="muted">尚未添加 MCP 服务器。</p>}</div>
    </div>
    </div><div className="settings-actions"><button disabled={busy} onClick={onReload}><RefreshCw size={17} />重载</button><button className="primary" disabled={busy} onClick={onSave}><Save size={17} />{busy ? "正在保存…" : "保存设置"}</button></div>
  </section>;
}
