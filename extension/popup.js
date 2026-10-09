const baseUrlInput = document.getElementById("baseUrl");
const projectIdInput = document.getElementById("projectId");
const apiTokenInput = document.getElementById("apiToken");
const statusEl = document.getElementById("status");
const clipButton = document.getElementById("clip");

chrome.storage.sync.get(["baseUrl", "projectId", "apiToken"], (values) => {
  if (values.baseUrl) baseUrlInput.value = values.baseUrl;
  if (values.projectId) projectIdInput.value = values.projectId;
  if (values.apiToken) apiTokenInput.value = values.apiToken;
});

document.getElementById("clip").addEventListener("click", async () => {
  if (clipButton.disabled) return;
  const baseUrl = baseUrlInput.value.trim().replace(/\/+$/, "");
  const projectId = projectIdInput.value.trim();
  const apiToken = apiTokenInput.value.trim();

  if (!baseUrl) {
    statusEl.textContent = "请先填写服务地址。";
    return;
  }
  if (!projectId) {
    statusEl.textContent = "请先填写知识库 ID。";
    return;
  }
  try {
    const serviceUrl = new URL(baseUrl);
    if (!/^https?:$/.test(serviceUrl.protocol) || serviceUrl.search || serviceUrl.hash || serviceUrl.username || serviceUrl.password) throw new Error();
  } catch { statusEl.textContent = "请填写有效的 HTTP 或 HTTPS 服务地址。"; return; }
  chrome.storage.sync.set({ baseUrl, projectId, apiToken });

  clipButton.disabled = true;
  try {
    statusEl.textContent = "正在读取当前页面...";
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      statusEl.textContent = "无法读取当前标签页。";
      return;
    }
    if (!/^https?:\/\//i.test(tab.url || "")) { statusEl.textContent = "浏览器内部页面无法剪藏，请打开普通网页后重试。"; return; }

    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title,
        url: location.href,
        content: `# ${document.title}\n\n${document.body.innerText}`
      })
    });
    if (!injected?.result) {
      statusEl.textContent = "页面内容读取失败。";
      return;
    }

    statusEl.textContent = "正在发送...";
    const headers = { "content-type": "application/json" };
    if (apiToken) headers["x-api-token"] = apiToken;
    const response = await fetch(`${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/sources/clip`, {
      method: "POST",
      headers,
      body: JSON.stringify(injected.result)
    });
    if (response.ok) {
      statusEl.textContent = "已发送到摄入队列。";
      return;
    }
    const payload = await response.json().catch(() => null);
    statusEl.textContent = `发送失败：${payload?.error || response.status}`;
  } catch (error) {
    statusEl.textContent = `发送失败：${error instanceof Error ? error.message : String(error)}`;
  } finally { clipButton.disabled = false; }
});
