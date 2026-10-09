import type { ModelProfile } from "../types.js";
import { isProviderKind } from "./providerSettings.js";
import { serviceJson, serviceUrl } from "./serviceHttp.js";
import { textInput, validateSettingsInput } from "./validation.js";

export function diagnosticModel(value: Partial<ModelProfile>): ModelProfile {
  validateSettingsInput({ modelProfiles: [value] });
  if (!value || !isProviderKind(value.provider) || value.provider === "offline") throw Object.assign(new Error("请选择有效的模型提供商。"), { status: 400 });
  return {
    id: typeof value.id === "string" ? value.id : "", name: typeof value.name === "string" ? value.name : "",
    provider: value.provider, baseUrl: serviceUrl(value.baseUrl),
    model: typeof value.model === "string" ? value.model.trim() : "",
    apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : undefined, enabled: true
  };
}

export async function discoverModels(value: Partial<ModelProfile>): Promise<{ models: string[]; message: string }> {
  const profile = diagnosticModel(value);
  const base = profile.baseUrl;
  const headers: Record<string, string> = {};
  if (profile.apiKey) headers.authorization = `Bearer ${profile.apiKey}`;
  let endpoint = `${base}/models`;
  if (profile.provider === "ollama" && !base.endsWith("/v1")) endpoint = `${base}/api/tags`;
  if (profile.provider === "anthropic") {
    endpoint = `${base.endsWith("/v1") ? base : base + "/v1"}/models?limit=100`;
    delete headers.authorization;
    headers["x-api-key"] = profile.apiKey || "";
    headers["anthropic-version"] = "2023-06-01";
  }
  if (profile.provider === "gemini") {
    endpoint = `${/\/v1(?:beta)?$/.test(base) ? base : base + "/v1beta"}/models?pageSize=1000`;
    delete headers.authorization;
    headers["x-goog-api-key"] = profile.apiKey || "";
  }
  const models = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const data = await serviceJson(endpoint, { headers });
    const items = data.data ?? data.models;
    if (!Array.isArray(items)) throw new Error("接口没有返回模型列表；请检查服务是否支持自动获取模型。");
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (profile.provider === "gemini" && (!Array.isArray(item.supportedGenerationMethods) || !item.supportedGenerationMethods.includes("generateContent"))) continue;
      const name = item.id || item.name || item.model;
      if (typeof name === "string" && /\uFFFD/.test(name)) throw new Error("模型列表含有无法识别字符，请检查服务端的文本编码。");
      if (typeof name === "string" && name.trim()) models.add(textInput(profile.provider === "gemini" ? name.replace(/^models\//, "") : name, "服务返回的模型名称", { required: true, max: 160, singleLine: true }).trim());
    }
    const next = new URL(endpoint);
    if (profile.provider === "gemini" && typeof data.nextPageToken === "string" && data.nextPageToken) next.searchParams.set("pageToken", data.nextPageToken);
    else if (profile.provider === "anthropic" && data.has_more && data.last_id) next.searchParams.set("after_id", data.last_id);
    else if (data.has_more && data.data?.at(-1)?.id) next.searchParams.set("after", data.data.at(-1).id);
    else return { models: [...models].sort(), message: models.size ? `已获取 ${models.size} 个模型，选择后可测试实际回答。` : "服务连接成功，但没有可用的对话模型。" };
    if (endpoint === next.toString()) throw new Error("模型列表的分页标记重复。");
    endpoint = next.toString();
  }
  throw new Error("模型列表超过分页上限，请缩小服务中的模型范围后重试。");
}
