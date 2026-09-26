# D0 东京生产部署与最小验收

- **环境/日期/代码版本/镜像：** 2026-09-26（UTC+8）。服务器 `154.36.184.44`（雨云东京，Debian 12 bookworm，内核 6.1，4 vCPU / 7.8 GiB / 40 GB，无 swap，出口 AS979 NetLab Global，无代理）。已有服务：宝塔面板 10（`:8889`）、宝塔 Nginx 1.26.3（`:80`/`:888`）、MySQL（`*:3306`，ufw 未放行）；本次未改动这些服务的既有配置。东京 Supabase `lvbtgwlsebzbtcvjwktq`（`ap-northeast-1`），Web/worker 走 session pooler。发布镜像：
  - `zhiyu-supabase-web:release-20260926`（`473537d1fd49`）/ `zhiyu-supabase-worker:release-20260926`（`b5e6da9b309c`）：P1-1 修复后首个生产版本（04:25 UTC 起）；
  - `zhiyu-supabase-web:release-20260926b`（`bf3910f49fd4`）/ `zhiyu-supabase-worker:release-20260926b`（`1611470fa0c8`）：再加 P3-2 模板修改（05:00 UTC 起）；
  - `zhiyu-supabase-web:release-20260926c`（`993573537d83`）/ `zhiyu-supabase-worker:release-20260926c`（`86aed857f4f4`）：P3-2 数轴配方细化（约 05:34 UTC 起，**当前运行版本**）。
  - 两者均为基线 `a0484f3e` + 本轮未提交改动，在本机用与迁移验收相同的东京构建参数构建（`NEXT_PUBLIC_SUPABASE_URL`/publishable key 指向东京，未残留旧 ref），经 `docker save | gzip | ssh docker load` 传到服务器（约 1.1 GB 压缩，11–13 分钟），服务器上不构建 Next.js。
- **初始问题及复现步骤：** D0 此前只完成第 2 步（生产 compose 覆盖与 Linux 脚本入库）和本机镜像构建；服务器、域名、HTTPS、Auth 回调均未做。开工核对：服务器未安装 Docker；Nginx 无站点；DNS 只有 `www` A 记录（用户随后补了 `@` 记录）；东京 Auth Site URL 为 `http://localhost:3000`，重定向白名单只有两条 localhost。
- **修改范围与原因（服务器与平台操作，均为部署必需）：**
  1. **SSH：** 本机生成专用 ed25519 密钥 `~/.ssh/zhiyu_tokyo_ed25519`，由用户本人用 root 密码登记公钥；此后全程密钥登录。未改 sshd 配置。
  2. **Docker：** 从 Docker 官方 Debian 仓库安装 `docker-ce 29.8.1` + compose 插件 5.5.1。Web 端口只发布到 `127.0.0.1:3000`，ufw 未新增规则。
  3. **部署目录 `/opt/zhiyu`：** `docker-compose.supabase.yml`、`docker-compose.production.yml`、`scripts/supabase-compose.sh`（与仓库一致，已转 LF）；`.env.local`、`.env.hosted.local`（来自本机私有文件，权限 600，仅改 `APP_ORIGIN`、`GENERATION_ALLOWED_ORIGINS`、CA 路径、`ZHIYU_WEB_IMAGE`/`ZHIYU_WORKER_IMAGE`、`TRUST_PROXY_HEADERS=1`）；`secrets/supabase-db-ca.crt`（Supabase 公共 CA，权限 644）。密钥值未打印、未写入仓库或报告。
  4. **HTTPS 与反代：** certbot 2.1.0（Debian 包）webroot 方式签发 Let's Encrypt 证书，覆盖 `zhiyulearn.online` 与 `www.zhiyulearn.online`（签发时接受了 Let's Encrypt 服务条款，未登记邮箱；`certbot.timer` 自动续期，续期后由 `/etc/letsencrypt/renewal-hooks/deploy/reload-bt-nginx.sh` 重载宝塔 Nginx）。新增 `/www/server/panel/vhost/nginx/zhiyulearn.online.conf`（不在宝塔站点列表中）：80 端口只提供 ACME 校验并 301 到 `https://zhiyulearn.online`；`www` 的 443 也 301 到裸域；裸域 443 反代 `127.0.0.1:3000`，覆盖（不追加）`X-Forwarded-For`/`X-Real-IP`，`proxy_buffering off`、`proxy_request_buffering off`、`proxy_cache off`、读写超时 3600 s（SSE/长请求），`client_max_body_size 200m`（应用材料包上限 150 MB）。
  5. **东京 Auth（控制台，用户登录后由执行者操作）：** Site URL `http://localhost:3000` → `https://zhiyulearn.online`；重定向白名单新增 `https://zhiyulearn.online/auth/confirm`、`https://zhiyulearn.online/auth/update-password`，保留两条 localhost 供本机开发。未改邮件模板和其他 Auth 设置。
  6. **启动：** `scripts/supabase-compose.sh start --tier 4 --mode background --accept-jobs --confirm-writes`（Tier 4、`APP_HEAVY_TASK_PER_OWNER_LIMIT=2`、两个 worker，不叠加本机 DNS 覆盖，不启用 `video-export`）。启动前停止了本机栈，避免两组 worker 同时连东京、超出 `app_worker` 连接预算。
- **发现并当场修正的问题：** 首次启动两个 worker 反复重启（`Generation worker startup failed`），Web 虽健康但同样读不到 CA：容器以 uid 1001 运行，compose 的文件型 secret 忽略 `uid/gid/mode`，而我把 CA 文件设成了 600。CA 为公开证书，改为 644 后全部健康。已在“剩余事项”提示今后部署沿用 644。
- **前后指标：**
  - 服务器 → 东京：`*.supabase.co` DNS 10–30 ms、TCP 11–32 ms、TLS 47–82 ms；pooler TCP 11–33 ms；DeepSeek TLS 56 ms；MiniMax TLS 256–544 ms（本机对照：到 pooler TCP 210–430 ms、新建 DB 连接约 2.9 s）。
  - 读取延迟与池等待：见 [P1-1 服务器基线](2026-09-26-p1-1-hosted-auth-reconnect-fix-and-tokyo-server-baseline.md)（服务器处理 P95 全部 < 450 ms，池等待最大 64 ms）。
  - 资源（空闲，release b）：Web 约 151 MiB、worker 107–149 MiB；主机已用 1.5 GiB / 7.8 GiB；磁盘已用 13 GB / 40 GB（含两套发布镜像）。
- **自动测试命令及结果：** 本项新增/修改的代码测试见汇总报告；服务器侧检查：
  - `scripts/supabase-compose.sh config`：通过；解析后 Web/worker `APP_ORIGIN`/`GENERATION_ALLOWED_ORIGINS` 只含 `https://zhiyulearn.online`，Web 端口 `host_ip: 127.0.0.1`，`TRUST_PROXY_HEADERS=1`，`ASSET_BYTE_EGRESS=direct`。
  - `scripts/supabase-compose.sh readiness`（两个版本各一次）：`ready=true`，accounts v19、generation v4、worker 2/2、3 个私有桶可达。
  - `https://zhiyulearn.online/api/health` 200；`http://www.…/x` → 301 `https://zhiyulearn.online/x`。
- **真实操作与课程/任务/会话 ID：**
  - 管理员由用户本人在正式域名登录（执行者未输入密码）；读取旧课 `94c0ee87-…`、新课 `e48a0067-…` 及其资产全部 200（P1-1 测量 240 轮）。
  - **第 8 步重建读回：** 在无活动生成任务时由 release → release b 重建全部容器；重建后 `/tmp`、`/app/data`（tmpfs）为空；文档 `94c0ee87-…`（97,695 B）、图片 `ast_hde6jh95…`（408,179 B）、stage-meta `e48a0067-…` 的 SHA-256 前缀与重建前完全一致（`3eb0dcb9a999995d`、`5ffd11efdc5980cd`、`99e8b7d454846770`）。
  - **新生成课程（后台模式，开启图片与配音）：** 课程 `1fea0102-de3f-44ce-bb80-2613e4a34f57`（任务 `3389c4c8-5eed-44a2-8aed-0ed3c68dc12c`，2 分 23 秒，7 页，40 条配音资产全部存在）与 `5d7a559e-83ab-42fc-8891-7ed11e4d023b`（任务 `6c7db969-2f26-4d42-88a0-27588e91f3b3`，1 分 49 秒，5 页，34 条配音）；同类课在本机栈需约 14.7 分钟。两门课在生产课堂中正常加载、翻页、显示讲解；详情见 [P3-2 报告](2026-09-26-p3-2-teaching-image-accuracy.md)。
  - **课堂流式（SSE 经 Nginx）：** 在课程 `1fea0102-…` 的课堂聊天提问一次，`/api/chat` 4.1 s 完成，老师文字回答与白板绘制动作实时出现，未出现缓冲或超时。
  - **学习记录保存：** 上述提问写入该课的聊天会话；稍后另开课堂页面直接读回：会话列表 200（1 个 chat 会话），该会话记录 200、4 条且包含提问内容“2/4”。
  - **密码重置邮件：** 在正式域名“忘记密码”页为测试账号 `lzg0724aaa@163.com` 请求重置；Auth 日志 05:14:55 UTC `user_recovery_requested`，`/recover` 200，回调为 `https://zhiyulearn.online/auth/confirm?next=/auth/update-password`（在白名单内）。邮件实际到达与链接点击需用户在 163 邮箱确认。
  - **匿名越权：** 未登录请求课程 `1fea0102-…` 的文档、stage-meta、音频资产与学习记录全部 401。
  - **镜像升级：** 之后又以同样的“无活动任务 → 改标签 → apply → readiness”流程升级到 `release-20260926c`（仅提示模板变化），readiness `ready=true`。
- **权限与持久化检查：** Web 只监听 127.0.0.1，外部只能经 Nginx；Nginx 覆盖转发头后才开启 `TRUST_PROXY_HEADERS=1`；桶仍为私有；Postgres 生产启动后 ERROR/FATAL 0 条。
- **回退方式及是否验证：** 服务器保留上一发布标签，把 `.env.hosted.local` 中两个镜像标签改回后 `scripts/supabase-compose.sh apply` 即可（release → release b 的切换已实际执行，反向未演练）；Nginx 删除 `zhiyulearn.online.conf` 并 `nginx -s reload` 即恢复原状；Auth 设置可在控制台改回。本机镜像另有 `*:rollback-20260925-pre-postlaunch`。
- **结论：** 受外部条件限制——正式域名、HTTPS、Auth 回调、容器重建读回、管理员读取与生成已通过；第 6 步中需要用户本人参与的项目（测试账号登录/登出、注册确认邮件与密码重置链接的实际点击、另一设备读回、另一账号越权访问）未全部完成，见剩余事项。
- **剩余事项：**
  - 用户用测试账号 `lzg0724aaa@163.com` 在正式域名登录/登出、打开重置密码邮件确认链接指向 `https://zhiyulearn.online/auth/confirm`，并在另一设备读回；另一账号访问管理员课程应被拒。
  - 本会话中 root 密码与管理员密码出现在对话里，建议部署完成后由用户修改；如不再需要，可删除 `/root/.ssh/authorized_keys` 中注释为 `claude-deploy-zhiyu-20260926` 的公钥。
  - MySQL 监听 `*:3306`（ufw 已拦截），属原有宝塔配置，未改动。
  - 未启用 MP4 导出（`video-export` profile），仅 ZIP 导出；容量为初始 Tier 4，未声称 16 并发通过。
