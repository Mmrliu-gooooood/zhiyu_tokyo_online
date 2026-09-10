# 部署与运行模式

项目有多个可选运行拓扑。先选择需要的能力，再配置环境；不要把实验功能开关全部打开。

## 共同前置条件

- Node.js `>=20.9.0`
- pnpm `10.28.0`（建议通过 Corepack 使用仓库锁定版本）
- 至少一个可用 LLM 服务商，配置在 `.env.local` 或私有 `server-providers.yml`
- 启用音频/视频本地抽取时，系统 `PATH` 中需要 `ffmpeg` 和 `ffprobe`

`.env.local`、`server-providers.yml` 和凭据不得提交。完整变量及注释以 `.env.example` 为准。

## 模式 A：本地开发（默认浏览器持久化）

```bash
corepack enable
pnpm install
pnpm dev
```

访问 `http://localhost:3000`。默认不需要 PostgreSQL；课程、运行状态和资产保存在浏览器存储中。此模式适合开发普通生成和课堂体验，不提供可跨进程恢复的 Agent/后台任务。

## 模式 B：标准 Docker

```bash
docker compose up --build
```

默认只启动 `openmaic`，并挂载 `openmaic-data`。`docker-compose.yml` 还定义两个按 profile 启用的服务：PostgreSQL 与 Render Service。

构建阶段可选 `ALPINE_MIRROR` 与 `NPM_REGISTRY`；它们会进入 Docker 构建参数，请勿包含用户名、密码或 Token。

## 模式 C：服务端持久化

1. 在 `.env.local` 设置 `DATABASE_URL`、`PERSISTENCE_DEV_TOKEN` 与所需服务商变量。
2. 构建环境设置 `NEXT_PUBLIC_PERSISTENCE=1` 和相同值的 `NEXT_PUBLIC_PERSISTENCE_TOKEN`。
3. 启动 PostgreSQL profile：

```bash
docker compose --profile server-persistence up --build
```

公开令牌会进入浏览器 JavaScript，仅用于当前持久化接口兼容层，不是正式账户鉴权。对公网部署前必须另行落实可信身份、授权边界、HTTPS 和备份恢复。

## 模式 D：Pro Agent 工作台

完整 Pro 流程建立在服务端持久化之上。至少配置：

- `NEXT_PUBLIC_PRO_WORKBENCH_ENABLED=1`（构建时）
- `OPENMAIC_AGENT_RUNTIME_ENABLED=1`（运行时）
- `DATABASE_URL`
- 至少 32 字节且保持稳定的 `GENERATION_SESSION_SECRET`
- 64 位十六进制 `PRO_MODEL_ENCRYPTION_KEY`，用于加密 Home 模型连接
- 可用的 `DEFAULT_MODEL` / `MODEL_ROUTES`，或已经同步的 Home 模型连接

如果 Pro 需要使用 Home 中的媒体服务配置，还要设置稳定的 64 位十六进制 `MEDIA_CONFIG_ENCRYPTION_KEY`。密钥更换会使旧快照或连接无法解密，不要在容器重建时临时生成。

可以用 `openssl rand -hex 32` 分别生成 32 字节随机值，但每个用途必须使用不同值并保存在部署密钥管理中。Pro 入口只有在客户端开关、服务端 Runtime 和数据库都可用时才显示；密钥缺失仍会导致会话所有权或模型/媒体同步返回 503。

## 模式 E：独立后台 Generation Worker

Worker 镜像目标为 `generation-worker`，入口为 `dist-worker/generation.mjs`。Web 与 Worker 必须共享：

- 同一个 `DATABASE_URL`
- 至少 32 字节且稳定的 `GENERATION_SESSION_SECRET`（Web 所有者会话）
- `MEDIA_CONFIG_ENCRYPTION_KEY`
- `GENERATION_MODEL_ENCRYPTION_KEY`
- 模型、媒体、搜索和代理网络配置
- `GENERATION_BACKGROUND_ENABLED=1` 与 `GENERATION_ACCEPTING_JOBS=1`

先构建 Worker，再执行幂等迁移：

```bash
pnpm build:worker
pnpm generation:migrate
pnpm generation:worker
```

仓库中的 `docker-compose.persistence.yml` 是现有 ZHIYU 持久部署的保护性覆盖文件，不是空环境的一键模板。它要求已经存在的 `openmaic-main_openmaic-postgres` 和 `openmaic-main_openmaic-data` 卷，并固定检查 Web/Worker 镜像、源代码 revision、密钥和本机端口。Windows 部署应使用：

```powershell
.\scripts\generation-compose.ps1 check
.\scripts\generation-compose.ps1 build
.\scripts\generation-compose.ps1 migrate
.\scripts\generation-compose.ps1 start-worker
.\scripts\generation-compose.ps1 start-app
.\scripts\generation-compose.ps1 status
```

脚本故意拒绝缺失卷或不匹配配置，避免误建空数据库覆盖真实部署。

## 模式 F：MP4 Render Service

```bash
docker compose --profile video-export up --build
```

同时设置 `NEXT_PUBLIC_ENABLE_VIDEO_EXPORT=1` 并重新构建 Web。Render Service 接收自包含的 Hyperframes ZIP，在隔离容器中调用 Chromium 与 FFmpeg；默认标准资源配置要求约 8 GiB 内存，低内存配置见 [render-service/README.md](../../render-service/README.md)。

## 健康检查与发布门槛

- Web 存活：`GET /api/health`
- Web 就绪：`GET /api/health/ready`
- Worker 自检：`node dist-worker/generation.mjs --check`
- Compose 发布脚本还会验证 Worker 数据库心跳、镜像 revision 与持久卷身份

发布前至少运行：

```bash
pnpm lint
pnpm check
pnpm test
pnpm build
pnpm build:worker
```

涉及真实浏览器流程时再运行 `pnpm test:e2e`；涉及 Docker 拓扑时使用对应 profile 做健康检查。
