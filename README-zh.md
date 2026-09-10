<p align="center">
  <img src="assets/banner.png" alt="OpenMAIC 横幅" width="680" />
</p>

<p align="center">
  从主题或学习材料生成可交互的多智能体课程。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README-zh.md">简体中文</a> ·
  <a href="docs/README.md">技术文档</a> · <a href="LICENSE">MIT License</a>
</p>

# OpenMAIC / ZHIYU

OpenMAIC 是一个用于生成和运行 AI 互动课堂的 Next.js 应用。当前仓库包含 ZHIYU 产品界面、普通课程生成、可选的 Pro Agent 工作台、课堂播放与编辑、多种 AI/媒体服务商适配、浏览器或 PostgreSQL 持久化，以及可独立部署的后台生成 Worker。

本文只描述当前代码已经具备的能力；需要构建开关、数据库、Worker 或外部服务的功能均明确标为可选。

## 已实现能力

- **课程生成**：支持主题、上传材料和 Web 调研，可编辑大纲并显示生成进度。
- **多种场景**：幻灯片、测验、交互 HTML、模拟、游戏、图示、3D 可视化与 PBL 活动。
- **多智能体课堂**：旁白、讨论、白板动作、评分和学习者实时互动。
- **Pro 工作台（可选）**：可恢复 Agent 会话、材料、模型/媒体快照、23 个内置运行时 Skill、课程工具、取消、继续与中途调整。
- **后台课程生成（可选）**：使用 PostgreSQL Generation Job 和独立 Worker，页面关闭或服务重启后仍可恢复。
- **媒体流水线**：TTS、ASR、图片/视频生成、文档解析、本地 `ffmpeg` 抽取和 Web 搜索。
- **编辑与导出**：课程编辑、PPTX/HTML、课堂包、可选 PPTX 导入和隔离式 MP4 渲染。
- **可插拔存储**：浏览器、HTTP、PostgreSQL，以及支持 S3 的资产后端。
- **12 种语言**：`ar-SA`、`de-DE`、`en-US`、`es-MX`、`fr-FR`、`ja-JP`、`ko-KR`、`pt-BR`、`ru-RU`、`vi-VN`、`zh-CN`、`zh-TW`。

## 快速开始

### 环境要求

- Node.js `>=20.9.0`
- pnpm `10.28.0`（准确版本已固定在 `package.json`）

### 安装与启动

```bash
corepack enable
pnpm install
cp .env.example .env.local
pnpm dev
```

PowerShell 请用 `Copy-Item .env.example .env.local` 代替 `cp`。打开 [http://localhost:3000](http://localhost:3000)。

生成课程前至少配置一个可用的 LLM 连接。可以使用 `.env.local`、私有的 `server-providers.yml`，或当前流程支持的应用内设置。不要提交任何 API Key。

最小示例：

```env
OPENAI_API_KEY=sk-...
DEFAULT_MODEL=openai:gpt-5.5
```

当前代码中的 LLM 适配包括 OpenAI 及兼容 API、Azure OpenAI、Anthropic、Amazon Bedrock、Google、DeepSeek、Qwen、Kimi、MiniMax、GLM、SiliconFlow、Doubao、OpenRouter、Grok、Tencent、Xiaomi、Atlas Cloud、Ollama 和 Lemonade。TTS、ASR、图片、视频、PDF 与搜索服务需分别配置，完整变量和说明见 [.env.example](.env.example)。

### 验证生产构建

```bash
pnpm lint
pnpm check
pnpm test
pnpm build
```

其他常用命令：

```bash
pnpm test:e2e       # Playwright
pnpm build:worker   # 构建独立生成 Worker
pnpm test:package-tarballs
```

## 运行与部署模式

| 模式 | 服务 | 存储 | 适用场景 |
| --- | --- | --- | --- |
| 本地开发 | Next.js | 浏览器 | 默认开发与普通课堂流程 |
| 标准 Docker | `openmaic` | 浏览器 + 应用数据卷 | 单机应用 |
| 服务端持久化 | `openmaic` + PostgreSQL | HTTP API + PostgreSQL | 持久课程、运行时和资产 |
| 后台生成 | Web + PostgreSQL + `generation-worker` | PostgreSQL 任务与检查点 | 跨页面/重启继续生成 |
| 视频导出 | Web + `render-service` | 自包含渲染任务 | 可选 Chromium/FFmpeg MP4 |

标准 Docker：

```bash
docker compose up --build
```

可选 profile：

```bash
docker compose --profile server-persistence up --build
docker compose --profile video-export up --build
```

`docker-compose.persistence.yml` 和 `scripts/generation-compose.ps1` 用于保护已有卷的 ZHIYU 持久部署，并不是空环境的一键模板。启用 PostgreSQL、Pro 工作台、后台任务或 MP4 前，请阅读[部署与运行模式](docs/deployment/runtime-modes.md)。

## 关键功能开关

公开的 `NEXT_PUBLIC_*` 变量会在构建时写入浏览器包，修改后必须重新构建。

| 能力 | 必要配置 |
| --- | --- |
| 服务端持久化 | `NEXT_PUBLIC_PERSISTENCE=1`、匹配的持久化令牌、`DATABASE_URL` |
| Pro 工作台 | 持久化前置条件、`NEXT_PUBLIC_PRO_WORKBENCH_ENABLED=1`、`OPENMAIC_AGENT_RUNTIME_ENABLED=1`、`GENERATION_SESSION_SECRET`、64 位十六进制 `PRO_MODEL_ENCRYPTION_KEY` |
| 后台生成 | 两个生成开关、会话密钥、64 位十六进制 `GENERATION_MODEL_ENCRYPTION_KEY` 与 `MEDIA_CONFIG_ENCRYPTION_KEY`、已迁移数据库、健康 Worker |
| MP4 入口 | `NEXT_PUBLIC_ENABLE_VIDEO_EXPORT=1`，并可访问 Render Service |
| PPTX 导入入口 | `NEXT_PUBLIC_ENABLE_PPTX_IMPORT=1` |

开关行为的权威实现是 `lib/config/feature-flags.ts`；不能仅凭界面出现某个开关判断生产能力已经可用。

## 架构概览

```text
浏览器路由（/、/generation-preview、/workspace、/classroom/[id]）
        │
        ├── Next.js Route Handlers（生成、Agent、媒体、持久化）
        │        ├── 与服务商解耦的生成和编排
        │        ├── 浏览器或 HTTP/PostgreSQL 存储
        │        └── 可选 PostgreSQL 任务队列
        │                         │
        │                         └── generation-worker
        │
        └── 可选 render-service（隔离 Chromium + FFmpeg）
```

核心工作区包：

- `@openmaic/dsl`：有版本的幻灯片/课程契约与校验器。
- `@openmaic/renderer`：只读 React 幻灯片渲染器。
- `@openmaic/editor`：编辑事务、React 交互面和 UI。
- `@openmaic/importer`：仅浏览器运行的 PPTX 导入器。
- `@openmaic/generation`：与服务商无关的生成契约和 Prompt 资源。
- `@openmaic/storage`：浏览器、HTTP、PostgreSQL 和资产存储原语。

路由和数据流详见[系统架构](docs/architecture/system-overview.md)。

## 技术文档

请从[技术文档索引](docs/README.md)进入。索引将现行架构/部署说明与 ADR、调研、历史实施计划和排障记录分开。包 README、运行时 Prompt 与 Agent Skill 继续和代码放在一起，因为它们是实现契约的一部分。

## 贡献与安全

提交 Pull Request 前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，漏洞报告方式见 [SECURITY.md](SECURITY.md)。不要提交 `.env.local`、`server-providers.yml`、数据库地址、加密密钥或服务商凭据。

## 论文与许可证

研究使用请引用论文 [《From MOOC to MAIC: Reimagine Online Teaching and Learning through LLM-driven Agents》](https://doi.org/10.1007/s11390-025-6000-0)。

根项目采用 [MIT License](LICENSE)。仓库内的第三方工作区包保留各自许可证，包括 `packages/mathml2omml`（LGPL-3.0-or-later）和 `packages/pptxgenjs`（MIT）。
