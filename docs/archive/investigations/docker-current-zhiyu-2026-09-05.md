# zhiyu 当前部署与 Docker 清理记录

2026-09-05：按用户要求部署最新优化代码，应用名称为 `zhiyu`、端口为 3000，并清理重复和过时 Docker 资源。

## 当前保留

| 类型 | 名称 | 用途 / 状态 |
| --- | --- | --- |
| 容器 | `zhiyu` | 最新优化代码，运行中，`127.0.0.1:3000 → 3000` |
| 容器 | `openmaic-main-postgres-1` | 原 PostgreSQL 数据库，运行中且 healthy |
| 镜像 | `zhiyu:latest` | 最新应用，ID `3cf11ed120c8` |
| 镜像 | `postgres:16` | 原数据库依赖，ID `f1c3376c26f2` |
| 镜像 | `zhiyu-worker:latest` | 最新独立 Worker，ID `18c493241881`，备用，未启动容器 |

访问地址：<http://localhost:3000>。当前共 2 个容器、3 个镜像条目。

应用镜像完整 ID：`sha256:3cf11ed120c80a217395811afcc47766044b88863bb438acdc66f44d002d9248`。

## 已清理

- 旧版应用容器 `zhiyu-before-bugfix-20260905`。
- 两个隔离数据库测试容器 `openmaic-generation-test-db-20260905`、`openmaic-generation-verify-20260905`。
- 被新版本替换的原 `zhiyu` 容器；它在更新验证期间临时命名为 `zhiyu-retired-cleanup-20260905`，验证通过后删除。
- 旧应用镜像 `zhiyu:before-bugfix-20260905`、`zhiyu:bugfix-20260905`。
- 无运行容器使用的 Playwright 测试镜像和 `node:22-alpine` 构建基础镜像条目。
- Worker 的日期标签已统一为 `zhiyu-worker:latest`，未保留重复旧标签。

全部 Docker 数据卷和本机备份保留；本次不执行卷删除或全局 prune。

## 验证与功能状态

- 最新应用 Docker 生产构建通过，日志 `.scratch/zhiyu-latest-docker-build.log`。
- 首页 HTTP 200，`/api/server-providers` 返回 `parallelSceneConcurrency=2`，确认有界并发配置已在运行实例生效。
- 后台开关仍为关闭，`background.enabled=false`。本次部署兼容应用与并发优化，没有跳过原方案要求的后台生成灰度验收；未在原库执行 generation 新表迁移。
- 应用实际镜像 ID、3000 端口、原数据卷挂载均已核对。数据库五项基线（document_stages、document_scenes、asset_entries、runtime_sessions、stage_meta）更新前后均为 0 行。
- 没有改动 UI 布局、样式或文案。本次源码配置改动仅为 Compose 固定应用/Worker 的镜像名和容器名。
- Compose 的固定项目名仍为 `openmaic-main`，以保留原数据库及卷身份；Docker Desktop 中它是服务分组，不是另一份重复应用。

## 数据保护

切换前在应用和数据库已停止的状态下重新备份两个原卷，并保存旧容器配置及环境文件。备份目录为 `.scratch/zhiyu-cleanup-backup-20260905`，限制为当前用户访问，不进入 Git 或镜像。

| 备份 | 字节数 | SHA-256 |
| --- | ---: | --- |
| postgres.tar | 49,469,440 | `E20576246CED2130540504895014A3A6E47085E91CC0002C471A058D9800C4B7` |
| app-data.tar | 30,720 | `F04F6D13F757A2277B135AE5D645F9A4A9D1247D123CD88C0C81C57ADDB92704` |

后续使用 `scripts/generation-compose.ps1` 作为统一部署入口。镜像名与容器名已写入 `docker-compose.persistence.yml`，重建仍使用 `zhiyu:latest` / `zhiyu`，不再生成额外日期应用标签。
