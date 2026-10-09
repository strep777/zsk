export function serviceUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw Object.assign(new Error("请填写服务地址。"), { status: 400 });
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw Object.assign(new Error("服务地址需要是有效的 HTTP 或 HTTPS URL，请把密钥填写在 API Key 中。"), { status: 400 });
  }
}

export async function serviceJson(url: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(15000) });
  if (!response.ok) throw Object.assign(new Error(`服务请求失败：HTTP ${response.status}。请检查地址、密钥和接口权限。`), { status: 502 });
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("服务返回的内容不是有效的 JSON，请检查接口地址。"); }
  if (!payload || typeof payload !== "object") throw new Error("服务返回的 JSON 结构无效，请检查接口地址。");
  return payload;
}

export function diagnosticError(error: unknown, secrets: Array<string | undefined> = []): Error {
  const original = error instanceof Error ? error.message : String(error);
  let message = /timeout|timed out|aborted/i.test(original) ? "请求超时，请检查服务是否运行及网络是否可达。" :
    /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(original) ? "无法连接服务，请检查地址、端口及服务是否运行。" : original;
  for (const secret of secrets) if (secret) message = message.split(secret).join("[已隐藏]");
  message = message.replace(/(?:Bearer\s+)[^\s"']+/gi, "Bearer [已隐藏]").replace(/[\uFFFD]+/g, "[无法识别字符]");
  return Object.assign(new Error(message.slice(0, 1200)), { status: (error as { status?: number })?.status || 502 });
}
