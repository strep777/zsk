# LLM Wiki Web

一个基于 Karpathy “LLM Wiki” 思路的 Web 版知识库：把原始材料编译成可读、可链接、可审查的 Markdown Wiki，而不是只把文档塞进向量库。

## 功能

- 项目级知识库：每个项目都有 `purpose.md`、`schema.md`、`raw/`、`wiki/`、`.llm-wiki/`。
- 来源摄入：支持 `doc`、`docx`、`ppt`、`pptx`、`xls`、`xlsx`、`pdf`、Markdown、Text、HTML、CSV、TSV、JSON 和常见图片。
- Word/PDF 转 Markdown：摄入后会在 `wiki/sources/converted/` 生成可打开的 Markdown 全文；PDF 会按页转 Markdown，并尝试抽取图片。
- Office 兼容：`docx`、`pptx`、`xlsx` 有内置 OOXML 解析；旧版 `doc`、`ppt`、`xls` 在 Docker 中通过 LibreOffice 转换。
- Wiki 编译：自动生成 `wiki/sources/`、`wiki/concepts/`、`wiki/entities/`、`wiki/overview.md`、`wiki/index.md`。
- Markdown 工作台：带标题、加粗、列表、链接、代码、表格工具栏，支持编辑/预览/分栏模式。
- 查询、保存与深研：离线抽取式问答可直接使用；配置模型后升级为综合回答；回答可保存到 `wiki/queries/`；查询页也可以把当前问题沉淀为 `wiki/research/` 研究笔记。
- 图谱：基于 Wikilink、共享来源、转换全文关系生成知识图谱，支持搜索、缩放、节点详情和社区概览。
- 知识库体检：检查断链、孤立页、缺少 frontmatter、重复标题、来源页/转换页缺失等。
- 深度研究：已整合到查询页，支持 SearXNG 外部检索配置。
- Web Clip API：`POST /api/v1/projects/:id/sources/clip` 可把网页正文送入摄入队列。
- 浏览器剪藏扩展：`extension/` 是一个 Chrome/Chromium MV3 扩展，调用本地 Web Clip API。
- Docker 部署：Ubuntu 24.04 镜像，运行时数据挂载到 `/data`。

## Ubuntu Docker 安装

```bash
docker compose up -d --build
```

打开：

```text
http://localhost:19827
```

数据保存在宿主机：

```text
./data
```

Docker 镜像会安装 `poppler-utils`、`pandoc`、`libreoffice-writer`、`libreoffice-calc`、`libreoffice-impress`、`unzip` 和 `fonts-noto-cjk`，用于 PDF、Word、PPT、Excel 的文本/Markdown 转换，以及超大批量 ZIP 导入。

默认保留旧 multipart 上传接口兼容能力，但 Web 页面上传会统一走分片接口，默认每片 8 MB，不再把文件塞进 `/sources/upload`。25000+ 法律 `docx` 建议先压成一个 ZIP，再在 Web 上传这个 ZIP；上传完成后服务端会后台解包、过滤支持的文档格式，并批量登记到摄入队列，页面不需要等待解包完成。

```yaml
environment:
  LLM_WIKI_MAX_UPLOAD_FILES: "30000"
  LLM_WIKI_MAX_UPLOAD_SIZE_MB: "10240"
  LLM_WIKI_UPLOAD_CHUNK_MB: "8"
  LLM_WIKI_MAX_UPLOAD_CHUNKS: "1000000"
  LLM_WIKI_REQUEST_TIMEOUT_MS: "0"
  LLM_WIKI_SOCKET_TIMEOUT_MS: "0"
  LLM_WIKI_QUEUE_FLUSH_INTERVAL: "20"
  LLM_WIKI_MAX_TOPIC_NOTES: "3000"
  LLM_WIKI_MAX_INDEX_FILES: "2000"
  LLM_WIKI_MAX_OVERVIEW_FILES: "2000"
  LLM_WIKI_MAX_TOPIC_INDEX_FILES: "5000"
  LLM_WIKI_MAX_RAW_SEARCH_BYTES: "4194304"
  LLM_WIKI_MAX_GRAPH_NODES: "1500"
  LLM_WIKI_MAX_GRAPH_EDGES: "12000"
  LLM_WIKI_MAX_SOURCE_OVERLAP_FILES: "4"
  LLM_WIKI_METADATA_BYTES: "262144"
  LLM_WIKI_MAX_SEARCH_FILES: "4000"
  LLM_WIKI_MAX_CHAT_ATTACHMENTS: "6"
  LLM_WIKI_MAX_LINT_FILES: "2500"
  LLM_WIKI_MAX_LINT_ISSUES: "1000"
  LLM_WIKI_RAW_LIST_LIMIT: "500"
  LLM_WIKI_RAW_TREE_LIMIT: "5000"
  LLM_WIKI_MAX_UPLOAD_FILE_NAME_BYTES: "180"
  LLM_WIKI_MAX_ARCHIVE_PATH_SEGMENT_BYTES: "180"
```

其中 `LLM_WIKI_UPLOAD_CHUNK_MB` 控制 Web 上传分片大小，`LLM_WIKI_REQUEST_TIMEOUT_MS` 和 `LLM_WIKI_SOCKET_TIMEOUT_MS` 默认为 `0` 表示禁用 Node 侧上传超时。`LLM_WIKI_QUEUE_FLUSH_INTERVAL` 控制摄入队列每处理多少个文件落盘一次，`LLM_WIKI_MAX_TOPIC_NOTES` 控制单个概念/实体页最多沉淀多少条来源笔记，`LLM_WIKI_MAX_INDEX_FILES`、`LLM_WIKI_MAX_OVERVIEW_FILES` 和 `LLM_WIKI_MAX_TOPIC_INDEX_FILES` 控制后台自动更新首页、总览和概念/实体索引时的元数据扫描量。`LLM_WIKI_MAX_RAW_SEARCH_BYTES` 控制搜索原始文本文件的大小上限；Office/PDF 这类二进制文件会通过转换后的 Markdown 参与搜索。图谱相关的三个参数用于限制超大知识库返回的节点和边数量，避免浏览器一次加载过大的图谱 JSON。`LLM_WIKI_MAX_SEARCH_FILES`、`LLM_WIKI_MAX_LINT_FILES` 和 `LLM_WIKI_MAX_LINT_ISSUES` 分别限制问答正文扫描、知识库体检扫描页数和体检返回问题数。`LLM_WIKI_RAW_LIST_LIMIT` 和 `LLM_WIKI_RAW_TREE_LIMIT` 控制原始来源调试接口的默认返回量。`LLM_WIKI_METADATA_BYTES` 控制文件树/图谱读取每个 Markdown 文件头部元数据的大小。`LLM_WIKI_MAX_UPLOAD_FILE_NAME_BYTES` 控制浏览器分片上传临时文件名的字节上限，`LLM_WIKI_MAX_ARCHIVE_PATH_SEGMENT_BYTES` 控制 ZIP 内单个文件名/目录名写入磁盘前的字节上限，服务会自动解码 `#U4e09` 这类 ZIP Unicode 转义并截断超长法规文件名。

制作 ZIP 示例：

```bash
cd /path/to/legal-docx
zip -r legal-docx.zip .
```

如果前面还有 Nginx/Caddy/1Panel 反向代理，请把请求体限制设置为大于分片大小，例如 Nginx `client_max_body_size 32m;`，并适当放大 `proxy_read_timeout`、`proxy_send_timeout`。新版默认分片是 8 MB；如果代理仍是 1 MB，浏览器仍会看到 `ERR_CONNECTION_RESET` 或 413。

### docker-compose.yml 配置说明

| 配置项 | 当前值 | 说明 |
| --- | --- | --- |
| `services` | - | Docker Compose 的服务列表。当前只定义了一个服务。 |
| `services.llm-wiki-web` | - | LLM Wiki Web 主服务，包含前端页面、后端 API、文档转换和摄入队列。 |
| `build` | `.` | 使用当前目录下的 `Dockerfile` 构建镜像。代码更新后需要重新构建。 |
| `container_name` | `llm-wiki-web` | 固定容器名称，方便用 `docker logs llm-wiki-web` 查看日志。 |
| `ports` | `19827:3000` | 宿主机端口到容器端口的映射。左边是宿主机端口，右边是容器内 `PORT`。 |
| `environment.PORT` | `3000` | Node 服务在容器内监听的端口，需要和 `ports` 右侧一致。 |
| `environment.LLM_WIKI_DATA_DIR` | `/data` | 容器内数据目录，保存知识库、原始文件、转换 Markdown、队列和设置。 |
| `environment.LLM_WIKI_MAX_UPLOAD_FILES` | `30000` | 兼容旧 multipart 上传接口的文件数量上限。新版 Web 页面上传统一走分片接口。 |
| `environment.LLM_WIKI_MAX_UPLOAD_SIZE_MB` | `10240` | 兼容旧 multipart 上传接口的单文件大小上限，单位 MB。新版 Web 页面上传受分片大小控制。 |
| `environment.LLM_WIKI_UPLOAD_CHUNK_MB` | `8` | Web 上传分片大小，单位 MB。反向代理 `client_max_body_size` 必须大于它。 |
| `environment.LLM_WIKI_MAX_UPLOAD_CHUNKS` | `1000000` | 单个文件最大分片数，用于限制异常上传会话占用磁盘。 |
| `environment.LLM_WIKI_REQUEST_TIMEOUT_MS` | `0` | Node HTTP 请求超时，单位毫秒。`0` 表示禁用，适合大文件上传。 |
| `environment.LLM_WIKI_SOCKET_TIMEOUT_MS` | `0` | Node socket 空闲超时，单位毫秒。`0` 表示禁用，适合大文件上传。 |
| `environment.LLM_WIKI_QUEUE_FLUSH_INTERVAL` | `20` | 摄入队列每处理多少个文件写一次进度。小一些进度更实时，但磁盘写入更多。 |
| `environment.LLM_WIKI_MAX_TOPIC_NOTES` | `3000` | 单个概念/实体页面最多保留多少条来源笔记，避免页面无限变大。 |
| `environment.LLM_WIKI_MAX_INDEX_FILES` | `2000` | 自动更新首页时最多扫描多少个 Wiki 页面元数据。 |
| `environment.LLM_WIKI_MAX_OVERVIEW_FILES` | `2000` | 自动更新知识库总览时最多扫描多少个 Wiki 页面元数据。 |
| `environment.LLM_WIKI_MAX_TOPIC_INDEX_FILES` | `5000` | 自动建立概念/实体索引时最多扫描多少个 Wiki 页面元数据。 |
| `environment.LLM_WIKI_MAX_RAW_SEARCH_BYTES` | `4194304` | 搜索原始文本文件时单文件读取上限，单位 bytes。Office/PDF 使用转换后的 Markdown 搜索。 |
| `environment.LLM_WIKI_MAX_GRAPH_NODES` | `1500` | 知识图谱接口最多返回多少个节点，避免浏览器渲染过载。 |
| `environment.LLM_WIKI_MAX_GRAPH_EDGES` | `12000` | 知识图谱接口最多返回多少条边，避免图谱 JSON 和 SVG 过大。 |
| `environment.LLM_WIKI_MAX_SOURCE_OVERLAP_FILES` | `4` | 计算来源重叠关系时，每个页面最多抽样多少个来源，降低大库图谱计算成本。 |
| `environment.LLM_WIKI_METADATA_BYTES` | `262144` | 文件树/图谱读取 Markdown 头部元数据的上限，单位 bytes。 |
| `environment.LLM_WIKI_MAX_SEARCH_FILES` | `4000` | 问答搜索最多扫描多少个 Wiki Markdown 正文；来源标题/摘要仍会快速匹配。 |
| `environment.LLM_WIKI_MAX_LINT_FILES` | `2500` | 知识库体检手动检查最多扫描多少个 Wiki Markdown 页面，避免大库进入体检页面时卡顿。 |
| `environment.LLM_WIKI_MAX_LINT_ISSUES` | `1000` | 知识库体检手动检查最多返回多少条问题，避免前端一次渲染过多结果。 |
| `environment.LLM_WIKI_RAW_LIST_LIMIT` | `500` | 原始来源列表接口默认返回多少条来源记录。 |
| `environment.LLM_WIKI_RAW_TREE_LIMIT` | `5000` | 原始文件树接口默认最多遍历多少个原始文件。 |
| `environment.LLM_WIKI_MAX_CHAT_ATTACHMENTS` | `6` | 单次聊天最多附加多少个文件或图片。 |
| `environment.LLM_WIKI_MAX_CHAT_ATTACHMENT_TEXT_BYTES` | `24000` | 单个文本附件送入问答上下文的 UTF-8 字节上限。 |
| `environment.LLM_WIKI_MAX_CHAT_ATTACHMENT_DATA_URL_BYTES` | `6291456` | 单个图片附件 data URL 的 UTF-8 字节上限。 |
| `environment.LLM_WIKI_MAX_UPLOAD_FILE_NAME_BYTES` | `180` | 分片上传临时文件名的 UTF-8 字节上限，用于处理超长中文单文件名或 ZIP 名。 |
| `environment.LLM_WIKI_MAX_ARCHIVE_PATH_SEGMENT_BYTES` | `180` | ZIP 内单个路径段写入磁盘前的 UTF-8 字节上限，用于处理超长法规文件名。 |
| `volumes` | `./data:/data` | 数据持久化挂载。宿主机 `./data` 会映射到容器内 `/data`。 |
| `restart` | `unless-stopped` | 容器异常退出后自动重启；手动停止后不会自动拉起。 |

常见调整：

- 服务器已有服务占用 3000 端口：把 `ports` 改成 `"19827:3000"`，浏览器访问 `http://服务器IP:19827`。
- 1Panel/Nginx 仍然报 `ERR_CONNECTION_RESET`：保持 `LLM_WIKI_UPLOAD_CHUNK_MB=8`，并把代理请求体限制设到 `32m` 或更高。
- 图谱页面卡顿：降低 `LLM_WIKI_MAX_GRAPH_NODES` 和 `LLM_WIKI_MAX_GRAPH_EDGES`。
- 摄入进度刷新不够及时：降低 `LLM_WIKI_QUEUE_FLUSH_INTERVAL`，例如 `20`。

## 本地开发

```bash
npm install
npm run dev
```

生产构建与运行：

```bash
npm run build
npm start
```

## 模型配置

默认可离线运行。配置模型后，摄入摘要和问答会优先走模型，失败时自动回退到离线规则。

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
```

也可以在 Web 设置页选择 `openai`、`volcengine`、`volcengine-coding-plan`、`ollama`、`anthropic`、`gemini` 或 `custom`。

其他 provider 可使用各自独立的环境变量，避免 OpenAI 配置串到不同服务：

```bash
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b

ANTHROPIC_API_KEY=...
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-3-5-sonnet-latest

GEMINI_API_KEY=...
GEMINI_BASE_URL=https://generativelanguage.googleapis.com
GEMINI_MODEL=gemini-1.5-pro

CUSTOM_API_KEY=...
CUSTOM_BASE_URL=https://your-openai-compatible-endpoint/v1
CUSTOM_MODEL=your-model
```

## 火山方舟 / Coding Plan

Web 设置页可以直接选择：

- `volcengine`：普通火山方舟 OpenAI 兼容接口，默认 `https://ark.cn-beijing.volces.com/api/v3`。
- `volcengine-coding-plan`：Coding Plan 专用 OpenAI 兼容接口，默认 `https://ark.cn-beijing.volces.com/api/coding/v3`。

环境变量：

```bash
VOLCENGINE_API_KEY=...
VOLCENGINE_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
VOLCENGINE_MODEL=doubao-seed-2-0-lite-260215

VOLCENGINE_CODING_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
VOLCENGINE_CODING_MODEL=ark-code-latest
```

火山方舟也兼容 `ARK_API_KEY`、`ARK_BASE_URL`、`ARK_MODEL`、`ARK_CODING_BASE_URL`、`ARK_CODING_MODEL`。

## HTTP API 示例

创建项目：

```bash
curl -X POST http://localhost:3000/api/v1/projects \
  -H "content-type: application/json" \
  -d '{"name":"我的知识库","description":"LLM Wiki 实验"}'
```

剪藏网页：

```bash
curl -X POST http://localhost:3000/api/v1/projects/<projectId>/sources/clip \
  -H "content-type: application/json" \
  -d '{"title":"一篇文章","url":"https://example.com","content":"# 正文\n\nMarkdown 内容"}'
```

查询：

```bash
curl -X POST http://localhost:3000/api/v1/projects/<projectId>/chat \
  -H "content-type: application/json" \
  -d '{"query":"这个知识库的核心概念是什么？","save":true}'
```

## 浏览器剪藏扩展

1. 打开 Chrome/Chromium 的扩展管理页。
2. 启用开发者模式。
3. 加载 `extension/` 目录。
4. 在弹窗里填写服务地址和 Project ID；Docker Compose 默认服务地址是 `http://localhost:19827`。
5. 如果服务端启用了 `LLM_WIKI_API_TOKEN`，在弹窗里填写同一个 API Token。
6. 点击“发送当前页面”。

## 目录结构

```text
data/projects/<project-id>/
  purpose.md
  schema.md
  raw/
    sources/
    assets/
  wiki/
    index.md
    overview.md
    log.md
    sources/
      converted/
    concepts/
    entities/
    queries/
    research/
    synthesis/
    comparisons/
  .llm-wiki/
    settings.json
    sources.json
    queue.json
  chats/
```

## 验证

当前已通过：

```bash
npm run typecheck
npm test
npm run build
```
