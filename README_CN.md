# LLM Wiki Web

> 本文为详细配置与接口参考。项目介绍和入门教程请先阅读 [README](README.md)。

一个基于 Karpathy “LLM Wiki” 思路的 Web 版知识库：把原始材料编译成可读、可链接、可审查的 Markdown Wiki，而不是只把文档塞进向量库。

## 功能

- 项目级知识库：每个项目都有 `raw/`、`wiki/`、`.llm-wiki/`；新建时只保留最小 `wiki/index.md`，避免空白占位页干扰阅读。
- 来源摄入：支持 `doc`、`docx`、`ppt`、`pptx`、`xls`、`xlsx`、`pdf`、Markdown、Text、HTML、CSV、TSV、JSON 和常见图片。
- Word/PDF 转 Markdown：摄入后会在 `wiki/sources/converted/` 生成可打开的 Markdown 全文；PDF 会按页转 Markdown，并尝试抽取图片。
- Office 兼容：`docx`、`pptx`、`xlsx` 有内置 OOXML 解析；旧版 `doc`、`ppt`、`xls` 在 Docker 中通过 LibreOffice 转换。
- Wiki 编译：摄入后自动生成 `wiki/sources/`、`wiki/concepts/`、`wiki/entities/`、`wiki/overview.md`、`wiki/log.md` 并更新 `wiki/index.md`。
- Markdown 工作台：带标题、加粗、列表、链接、代码、表格工具栏，支持编辑/预览/分栏模式。
- 查询与深研：离线抽取式问答可直接使用；配置模型后升级为综合回答；查询页可以把当前问题沉淀为 `wiki/research/` 研究笔记。
- Skill/MCP 能力目录：设置页可维护项目级 Skill 指令和 MCP 服务器清单；查询对话会载入已启用 Skill，并把 MCP 工具/资源作为外部能力目录提供给模型。
- 图谱：基于 Wikilink、共享来源、转换全文关系生成知识图谱，支持搜索、缩放、节点详情和社区概览。
- 知识库体检：检查断链、孤立页、缺少 frontmatter、重复标题、来源页/转换页缺失等。
- 深度研究：已整合到查询页，知识库使用内置搜索，外部网页索引支持 Typesense 等服务。
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

Docker 镜像使用 Node.js 22，并安装 `poppler-utils`、`pandoc`、`libreoffice-writer`、`libreoffice-calc`、`libreoffice-impress`、`unzip` 和 `fonts-noto-cjk`，用于 PDF、Word、PPT、Excel 的文本/Markdown 转换，以及超大批量 ZIP 导入。设置 `LLM_WIKI_API_TOKEN` 后，网页首页提供 Token 登录；登录 Cookie 有效期为 8 小时。

默认保留旧 multipart 上传接口兼容能力，但 Web 页面上传会统一走分片接口，默认每片 8 MB，不再把文件塞进 `/sources/upload`。普通文件上传完成后会立即登记并自动进入摄入队列；25000+ 法律 `docx` 建议先压成一个 ZIP，再在 Web 上传这个 ZIP；上传完成后服务端会后台解包、过滤支持的文档格式，并批量自动摄入，页面不需要等待解包完成。

```yaml
environment:
  LLM_WIKI_MAX_UPLOAD_FILES: "30000"
  LLM_WIKI_MAX_UPLOAD_SIZE_MB: "10240"
  LLM_WIKI_UPLOAD_CHUNK_MB: "8"
  LLM_WIKI_MAX_UPLOAD_CHUNKS: "1000000"
  LLM_WIKI_REQUEST_TIMEOUT_MS: "0"
  LLM_WIKI_SOCKET_TIMEOUT_MS: "0"
  LLM_WIKI_MAX_TOPIC_NOTES: "3000"
  LLM_WIKI_MAX_INDEX_FILES: "2000"
  LLM_WIKI_MAX_OVERVIEW_FILES: "2000"
  LLM_WIKI_MAX_TOPIC_INDEX_FILES: "5000"
  LLM_WIKI_MAX_RAW_SEARCH_BYTES: "4194304"
  LLM_WIKI_MAX_GRAPH_NODES: "1500"
  LLM_WIKI_MAX_GRAPH_EDGES: "12000"
  LLM_WIKI_MAX_SOURCE_OVERLAP_FILES: "4"
  LLM_WIKI_METADATA_BYTES: "262144"
  LLM_WIKI_MAX_CHAT_ATTACHMENTS: "6"
  LLM_WIKI_MAX_SKILLS: "24"
  LLM_WIKI_MAX_MCP_SERVERS: "16"
  LLM_WIKI_MAX_LINT_FILES: "2500"
  LLM_WIKI_MAX_LINT_ISSUES: "1000"
  LLM_WIKI_RAW_LIST_LIMIT: "500"
  LLM_WIKI_RAW_TREE_LIMIT: "5000"
  LLM_WIKI_MAX_UPLOAD_FILE_NAME_BYTES: "180"
  LLM_WIKI_MAX_ARCHIVE_PATH_SEGMENT_BYTES: "180"
```

其中 `LLM_WIKI_UPLOAD_CHUNK_MB` 控制 Web 上传分片大小，`LLM_WIKI_REQUEST_TIMEOUT_MS` 和 `LLM_WIKI_SOCKET_TIMEOUT_MS` 默认为 `0` 表示禁用 Node 侧上传超时。摄入队列会按每个文件写入真实进度，前端可以看到当前正在摄入的具体文件。`LLM_WIKI_MAX_TOPIC_NOTES` 控制单个概念/实体页最多沉淀多少条来源笔记，`LLM_WIKI_MAX_INDEX_FILES`、`LLM_WIKI_MAX_OVERVIEW_FILES` 和 `LLM_WIKI_MAX_TOPIC_INDEX_FILES` 控制后台自动更新首页、总览和概念/实体索引时的元数据扫描量。`LLM_WIKI_MAX_RAW_SEARCH_BYTES` 控制搜索原始文本文件的大小上限；Office/PDF 这类二进制文件会通过转换后的 Markdown 参与搜索。图谱相关的三个参数用于限制超大知识库返回的节点和边数量，避免浏览器一次加载过大的图谱 JSON。问答正文覆盖全部知识库 Markdown 文件，并限制同时读取的文件数量及保留的结果数量，避免按文件顺序漏检。`LLM_WIKI_MAX_LINT_FILES` 和 `LLM_WIKI_MAX_LINT_ISSUES` 分别限制知识库体检扫描页数和体检返回问题数。`LLM_WIKI_MAX_SKILLS` 和 `LLM_WIKI_MAX_MCP_SERVERS` 控制每个知识库设置里最多保存多少条 Skill 和 MCP 服务器记录。`LLM_WIKI_RAW_LIST_LIMIT` 和 `LLM_WIKI_RAW_TREE_LIMIT` 控制原始来源调试接口的默认返回量。`LLM_WIKI_METADATA_BYTES` 控制文件树/图谱读取每个 Markdown 文件头部元数据的大小。`LLM_WIKI_MAX_UPLOAD_FILE_NAME_BYTES` 控制浏览器分片上传临时文件名的字节上限，`LLM_WIKI_MAX_ARCHIVE_PATH_SEGMENT_BYTES` 控制 ZIP 内单个文件名/目录名写入磁盘前的字节上限，服务会自动解码 `#U4e09` 这类 ZIP Unicode 转义并截断超长法规文件名。

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
| `environment.LLM_WIKI_MAX_TOPIC_NOTES` | `3000` | 单个概念/实体页面最多保留多少条来源笔记，避免页面无限变大。 |
| `environment.LLM_WIKI_MAX_INDEX_FILES` | `2000` | 自动更新首页时最多扫描多少个 Wiki 页面元数据。 |
| `environment.LLM_WIKI_MAX_OVERVIEW_FILES` | `2000` | 自动更新知识库总览时最多扫描多少个 Wiki 页面元数据。 |
| `environment.LLM_WIKI_MAX_TOPIC_INDEX_FILES` | `5000` | 自动建立概念/实体索引时最多扫描多少个 Wiki 页面元数据。 |
| `environment.LLM_WIKI_MAX_RAW_SEARCH_BYTES` | `4194304` | 搜索原始文本文件时单文件读取上限，单位 bytes。Office/PDF 使用转换后的 Markdown 搜索。 |
| `environment.LLM_WIKI_MAX_GRAPH_NODES` | `1500` | 知识图谱接口最多返回多少个节点，避免浏览器渲染过载。 |
| `environment.LLM_WIKI_MAX_GRAPH_EDGES` | `12000` | 知识图谱接口最多返回多少条边，避免图谱 JSON 和 SVG 过大。 |
| `environment.LLM_WIKI_MAX_SOURCE_OVERLAP_FILES` | `4` | 计算来源重叠关系时，每个页面最多抽样多少个来源，降低大库图谱计算成本。 |
| `environment.LLM_WIKI_METADATA_BYTES` | `262144` | 文件树/图谱读取 Markdown 头部元数据的上限，单位 bytes。 |
| `environment.LLM_WIKI_MAX_LINT_FILES` | `2500` | 知识库体检手动检查最多扫描多少个 Wiki Markdown 页面，避免大库进入体检页面时卡顿。 |
| `environment.LLM_WIKI_MAX_LINT_ISSUES` | `1000` | 知识库体检手动检查最多返回多少条问题，避免前端一次渲染过多结果。 |
| `environment.LLM_WIKI_RAW_LIST_LIMIT` | `500` | 原始来源列表接口默认返回多少条来源记录。 |
| `environment.LLM_WIKI_RAW_TREE_LIMIT` | `5000` | 原始文件树接口默认最多遍历多少个原始文件。 |
| `environment.LLM_WIKI_MAX_CHAT_ATTACHMENTS` | `6` | 单次聊天最多附加多少个文件或图片。 |
| `environment.LLM_WIKI_MAX_CHAT_ATTACHMENT_TEXT_BYTES` | `24000` | 单个文本附件送入问答上下文的 UTF-8 字节上限。 |
| `environment.LLM_WIKI_MAX_CHAT_ATTACHMENT_DATA_URL_BYTES` | `6291456` | 单个图片附件 data URL 的 UTF-8 字节上限。 |
| `environment.LLM_WIKI_MAX_SKILLS` | `24` | 每个知识库设置里最多保存多少条 Skill 指令。 |
| `environment.LLM_WIKI_MAX_MCP_SERVERS` | `16` | 每个知识库设置里最多保存多少个 MCP 服务器记录。 |
| `environment.LLM_WIKI_MAX_UPLOAD_FILE_NAME_BYTES` | `180` | 分片上传临时文件名的 UTF-8 字节上限，用于处理超长中文单文件名或 ZIP 名。 |
| `environment.LLM_WIKI_MAX_ARCHIVE_PATH_SEGMENT_BYTES` | `180` | ZIP 内单个路径段写入磁盘前的 UTF-8 字节上限，用于处理超长法规文件名。 |
| `volumes` | `./data:/data` | 数据持久化挂载。宿主机 `./data` 会映射到容器内 `/data`。 |
| `restart` | `unless-stopped` | 容器异常退出后自动重启；手动停止后不会自动拉起。 |

常见调整：

- 服务器已有服务占用 3000 端口：把 `ports` 改成 `"19827:3000"`，浏览器访问 `http://服务器IP:19827`。
- 1Panel/Nginx 仍然报 `ERR_CONNECTION_RESET`：保持 `LLM_WIKI_UPLOAD_CHUNK_MB=8`，并把代理请求体限制设到 `32m` 或更高。
- 图谱页面卡顿：降低 `LLM_WIKI_MAX_GRAPH_NODES` 和 `LLM_WIKI_MAX_GRAPH_EDGES`。

## 本地开发

Node.js 版本要求见 package.json 的 engines 字段，可使用与容器一致的 Node.js 22.12+ 的 22.x 版本。一般模型请求默认超时为 120 秒；Ollama 原生正式问答另有总时限和空闲时限，摄入分析默认最多 30 秒，详见本文末尾说明。

`npm test` 运行单元和界面回归测试；`npm run test:smoke` 会先构建，再启动隔离数据目录中的服务，检查登录、中文上传、摄入、问答、深研和删除，结束后清理测试数据。

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

模型卡片提供“获取模型”和“测试模型”：直接使用尚未保存的地址和密钥获取服务端模型列表、发送简短对话请求，显示实际回答与耗时。字段完整时显示“请测试实际可用性”，测试通过后才显示成功；修改配置会使旧测试结果失效。Ollama 同时支持原生地址及以 `/v1` 结尾的兼容接口地址，有代理鉴权时会发送填写的 Bearer 密钥。本地 OpenAI 兼容服务可以不填写 API Key。测试超时沿用 `LLM_WIKI_MODEL_TIMEOUT_MS`，默认 120 秒，以便本地模型冷启动。

设置页还提供外部搜索连接测试、系统提示词测试、Skill 指令验证和模型效果测试、MCP 连接测试及工具/资源自动获取。MCP 支持 Streamable HTTP、SSE 和 stdio；stdio 命令运行在应用后端所在的主机或容器中。查询会自动调用目录中支持 `query` 参数的只读检索工具，其他工具只用于能力说明。测试全部连接会逐项显示结果，测试及获取本身不会保存配置；点击“保存设置”后应用。

新项目不预填模型、Skill、MCP 或测试资料。系统提示词默认使用指定的九条知识库问答规则；可自行修改，留空时恢复默认规则。新增能力卡片从空内容开始；未填写指令的启用 Skill、缺少地址/命令的 MCP 在保存时会显示明确错误，避免静默丢失。

## 内置知识库搜索与 Typesense 外部搜索

知识库始终使用内置文件搜索，直接读取已有 Wiki 和摄入资料。Typesense 配置位于“外部搜索”：填写地址及 API Key，点击“获取集合和字段”，选择已有网页资料的集合，再点击“测试搜索”。测试和获取使用当前草稿，点击“保存设置”后用于问答和研究。旧版放在本地搜索区域的 Typesense 地址、密钥及集合会迁移到外部搜索字段。

Typesense 检索其已有索引，本身不抓取互联网；网页数据采集和索引由现有服务维护。文档需要 `url`（或 `link`、`canonical_url`）和正文，只有实际存在的 HTTP/HTTPS 地址会作为引用。检索字段留空时根据集合结构自动识别 `title`、`content` 等文字字段；也可手动填写逗号分隔的字段，使用仅检索密钥。获取集合和字段需要额外读取权限，应用不要求该集合的写入权限，也不会把知识库资料同步过去。未配置、无结果或服务失败时不会改用其他网站搜索。

地址从应用后端访问：应用在 Docker 中时，`localhost` 指向应用容器，连接已有 Typesense 可填写同一 Docker 网络中的服务名或后端可达的宿主机地址。选择已有网页索引集合，不需要重新安装已部署的 Typesense。

协议参考：[Ollama 模型列表](https://docs.ollama.com/api/tags)、[Ollama OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility)、[Typesense 文档导入](https://typesense.org/docs/29.0/api/documents.html)、[Typesense 检索](https://typesense.org/docs/29.0/api/search.html)、[MCP 官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x)。

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
4. 在弹窗里填写服务地址和知识库 ID；Docker Compose 默认服务地址是 `http://localhost:19827`。
5. 如果服务端启用了 `LLM_WIKI_API_TOKEN`，在弹窗里填写同一个 API Token。
6. 点击“发送当前页面”。

## 目录结构

```text
data/projects/<project-id>/
  raw/
    sources/
    assets/
  wiki/
    index.md
    overview.md      # 摄入后自动生成
    log.md           # 摄入后自动生成
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

接口在写入前校验请求类型、字符、数量和长度；非法请求返回明确的 400/413 错误，不覆盖已有内容。手动编辑只允许知识库范围内的 Markdown 文件，空名称、损坏字符及 Windows 保留文件名会被拒绝。不能提取正文的来源显示失败原因，不生成仅含元数据的知识页。

ZIP 默认最多 100000 个条目、单文件解包 256 MB、总解包 10240 MB，分别可用 `LLM_WIKI_MAX_ARCHIVE_ENTRIES`、`LLM_WIKI_MAX_ARCHIVE_FILE_SIZE_MB`、`LLM_WIKI_MAX_ARCHIVE_SIZE_MB` 调整。没有受支持文档的 ZIP 会失败；已有分片不可用不同内容覆盖，已完成上传重试末片不会重复导入。

每个知识库默认最多 2 个排队或运行中的研究任务，可用 `LLM_WIKI_MAX_ACTIVE_RESEARCH_TASKS` 调整；相同的活动任务返回既有任务。对话附件有数量、大小和正文限制，读取开头部分时界面会提示，可在文件页上传完整材料用于检索。

当前已通过：

```bash
npm run typecheck
npm test
npm run build
node scripts/run-smoke.mjs
```

上传期间仅更新上传卡片的进度，暂停时也不会刷新文件列表或摄入状态；已发出的刷新请求会取消。整批上传结束后统一刷新一次；取消或失败时刷新已上传结果，再恢复正常轮询。浏览器分片请求带 `deferRefresh=1`，服务不在每个文件完成时扫描并返回整个知识库的状态。

查询页使用已保存的模型和搜索配置；未保存的设置草稿不会影响实际请求。首次进入自动选择默认模型，手动选择摘要模式后保持选择。外部搜索关闭时不联网，服务失败或无结果时不切换其他服务；配置缺失时联网按钮会显示禁用原因。

Ollama 原生接口的连接测试与正式问答统一使用 `think: false`，避免测试成功后正式问答只返回思考内容。模型调用失败会显示具体错误原因，并隐藏 API Key；未尝试外部搜索时不会提示联网搜索失败。内置检索覆盖全部知识库 Markdown，最多同时读取 16 个文件，并只保留所需的高分结果；旧的 `LLM_WIKI_MAX_SEARCH_FILES` 参数已取消。

合法文本附件完整发送并保存在会话中，连续对话可继续读取历史附件；关闭上下文后不发送历史附件。同一会话使用历史时不可重叠提问，冲突返回 409，可在前一轮完成后重试。错误会话 ID 不会被规范化为另一条会话。

Ollama 原生正式问答在服务端流式接收，默认连续 120 秒没有数据或总计 600 秒后停止，已收到的部分回答会明确标记未完成；前端仍在请求结束后显示结果。总时限可通过 `LLM_WIKI_OLLAMA_CHAT_TIMEOUT_MS` 调整，空闲时限使用 `LLM_WIKI_MODEL_TIMEOUT_MS`。反向代理的读取超时也须允许此请求时长。连接测试只是短回答测试，不代表长问答一定能在时限内完成。

摄入分析独立使用 JSON 指令，默认最多 30 秒、1024 token（`LLM_WIKI_ANALYSIS_TIMEOUT_MS`、`LLM_WIKI_ANALYSIS_MAX_TOKENS`）。同一轮队列中某个模型配置分析失败后，该配置的后续资料使用离线正文摘要，避免每份文件重复等待失败模型；修改配置或启动下一轮队列会重新尝试。离线提取保留全文及来源，但不等同于模型的语义分析。

### 修复旧的空主题页

先更新代码并完成 `npm run build`，然后停止应用服务。在相同的数据目录配置下执行：

```bash
npm run repair:topics -- --project <知识库ID>
```

Docker 部署先构建新版镜像、停止 `llm-wiki-web` 服务，再运行 `docker compose run --rm --no-deps llm-wiki-web npm run repair:topics -- --project <知识库ID>`；完成后重新启动服务。不要与摄入进程同时运行。

修复命令从已有来源及转换正文补充 concepts/entities 页的占位定义、空来源笔记和来源元数据，不调用模型、不重新上传，保留人工实质内容。每个来源最多读取开头 256 KB；正文仍不足时明确提示，不编造定义。重复运行不会重复追加内容。

最新本地验收：28 个测试文件、375 项回归及 50 项 HTTP 冒烟通过，类型检查和生产构建通过。模型请求使用隔离协议服务，远程真实模型的长回答仍需部署后验证。
