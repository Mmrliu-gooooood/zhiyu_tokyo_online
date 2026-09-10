# 系统架构

本文描述当前仓库中的实现边界。最终事实来源依次是代码、配置/迁移、自动化测试；`docs/archive/` 中的计划和排查记录只用于追溯。

## 产品入口与主流程

OpenMAIC / ZHIYU 是一个 Next.js 16 App Router 应用，提供两条课程生产路径和一个课堂运行时：

1. **普通生成**：用户在 `/` 输入主题或材料，经 `/generation-preview` 查看大纲、场景内容和媒体生成进度，完成后进入 `/classroom/[id]`。
2. **Pro 工作台**：`/workspace` 与 `/workbench/new` 通过服务端 Agent Runtime 创建可恢复会话，由课程工具和内置 Skill 规划、生成及修改课程。
3. **课堂与编辑**：`/classroom/[id]` 负责播放、互动、测验、白板和按开关启用的编辑/导出能力。

普通生成可在 Web 请求内执行，也可提交到 PostgreSQL Generation Job，由独立 `generation-worker` 继续处理。后台模式支持页面离开后的轮询、取消、重试、确认大纲和人工复核状态。

## 运行分层

| 层 | 主要位置 | 职责 |
| --- | --- | --- |
| 页面与 API | `app/` | 首页、预览、课堂、工作台及 Route Handlers |
| UI | `components/` | 生成、课堂、编辑器、工作台、设置和基础组件 |
| 业务逻辑 | `lib/` | AI/媒体适配、生成、编排、播放、动作、持久化和导出 |
| 后台任务 | `workers/generation/` | Generation Job 迁移、租约、心跳和任务执行 |
| 运行时 Skill | `skills/agent-runtime/` | Pro Agent 可发现的课程规划与内容生产能力 |
| 可复用包 | `packages/@openmaic/` | DSL、渲染、编辑、导入、生成契约和存储后端 |
| 视频渲染 | `render-service/` | 在隔离容器中用 Chromium 与 FFmpeg 生成 MP4 |

## 生成链路

### 普通模式

- `app/api/generate/*` 提供大纲、场景内容、图片、视频、语音和角色生成接口。
- `app/api/generate-classroom/*` 提供后台任务提交、状态、取消、重试、大纲确认与快照接口。
- `lib/server/generation-pipeline/` 组合材料、搜索、内容与媒体服务。
- `lib/server/generation-jobs/` 定义任务契约、所有权、并发/队列限制、配置快照和 PostgreSQL 仓储。
- `workers/generation/runner.ts` 获取任务租约并调用同一条服务端生成管线，避免 Web 与 Worker 产生两套业务规则。

### Pro 模式

- `app/api/agent/` 管理会话、消息、事件、材料、模型连接、媒体快照和用户 Skill。
- `lib/server/agent-runtime/` 实现会话 Runner、课程工具、Skill 加载、语音目录与后台 Generation Job 工具。
- Pro 入口同时要求客户端构建开关、服务端 Runtime 开关和数据库配置，缺少任一条件都会隐藏入口或重定向到首页。

## 数据与持久化

默认开发模式使用浏览器存储：

- `@openmaic/storage` 的 Browser Document/Runtime/KV/Asset Store 保存课程、运行状态和素材。
- Zustand 设置和设备级状态继续保留在浏览器侧。

启用 `NEXT_PUBLIC_PERSISTENCE=1` 后：

- 浏览器通过 `/api/persistence` 使用 HTTP Document、Runtime 和 Asset Store。
- 服务端以 `DATABASE_URL` 连接 PostgreSQL；资产字节可使用 PostgreSQL，存储包也提供 S3 字节后端。
- 浏览器资产有旧数据读取回退，便于从本地存储渐进迁移。
- `NEXT_PUBLIC_PERSISTENCE_TOKEN` 是浏览器可见的兼容令牌，不应当作正式用户认证方案。

Agent 会话、材料、用户 Skill、Generation Job 和配置快照依赖服务端持久化。生产身份、授权和发布隔离仍应以对应 ADR 和部署实现为准。

## 关键功能开关

`NEXT_PUBLIC_*` 在 Next.js 构建时写入浏览器包；其他开关在服务启动时读取。修改前者后必须重新构建。

| 能力 | 必要配置 |
| --- | --- |
| 服务端持久化 | `NEXT_PUBLIC_PERSISTENCE=1`、匹配令牌、`DATABASE_URL` |
| Pro 工作台 | 持久化前置条件、两个 Pro 开关、至少 32 字节的 `GENERATION_SESSION_SECRET`、64 位十六进制 `PRO_MODEL_ENCRYPTION_KEY` |
| 后台课程生成 | 两个生成开关、会话密钥、64 位十六进制 `GENERATION_MODEL_ENCRYPTION_KEY` 与 `MEDIA_CONFIG_ENCRYPTION_KEY`、已迁移数据库、健康 Worker |
| MAIC 编辑入口 | Pro 工作台，或 `NEXT_PUBLIC_MAIC_EDITOR_ENABLED=1` |
| 新 Renderer | `NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED` / `NEXT_PUBLIC_MAIC_EDITOR_RENDERER_ENABLED` |
| MP4 导出 | `NEXT_PUBLIC_ENABLE_VIDEO_EXPORT=1` 和可访问的 Render Service |
| PPTX 导入 | `NEXT_PUBLIC_ENABLE_PPTX_IMPORT=1` |
| 职业任务引擎 | 服务端 `OPENMAIC_ENABLE_VOCATIONAL=1`；测试 UI 另由公开开关控制 |

开关的权威定义见 `lib/config/feature-flags.ts`，后台生成的范围和默认值见 `lib/server/generation-jobs/config.ts`。

## 工作区包

- `@openmaic/dsl`：纯数据契约、JSON Schema、校验与迁移。
- `@openmaic/renderer`：只读 Slide React 渲染器。
- `@openmaic/editor`：编辑事务、React 交互面和 UI。
- `@openmaic/importer`：浏览器端 PPTX 导入。
- `@openmaic/generation`：与服务商无关的生成契约和 Prompt 资源。
- `@openmaic/storage`：浏览器、HTTP、PostgreSQL 与对象存储适配层。

根 `postinstall` 会构建这些包并把 importer 运行时产物同步到 `public/vendor/maic-importer`。因此安装依赖后不要跳过仓库级 `postinstall`。

## 验证入口

- `pnpm lint`：ESLint。
- `pnpm check`：Prettier 检查。
- `pnpm test`：Vitest 全量测试。
- `pnpm build`：工作区产物校验与 Next.js 生产构建。
- `pnpm test:e2e`：Playwright 浏览器测试。
- `pnpm build:worker`：构建独立 Generation Worker。

更细的包级契约从 [文档索引](../README.md) 进入。
