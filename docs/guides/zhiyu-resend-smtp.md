# 智域：Resend SMTP 与本机 Site URL

智域用户用**自己的邮箱**（含 QQ、163）注册：邮箱 + 智域平台密码 + 确认邮件。没有 QQ / 微信 OAuth。终端用户不注册 Resend。邮件由 **Supabase Auth 经 Resend SMTP** 发出。

`zhiyulearn.online` 已登记为计划生产域名，但**尚未部署、不能假定解析或 HTTPS**。发信域名 `auth.zhiyulearn.online` 已由操作者在 Resend 验证，Custom SMTP 已在 Dashboard 保存。当前开发/联调入口是 `http://localhost:3000`（不要用 `127.0.0.1`，allow-list 没有这条）。

邮件 DNS（SPF/DKIM/DMARC）与网站上线是两件事：可以先验证发信域名，不必先把营销站挂上网。

官方依据：[Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)、[Resend + Supabase SMTP](https://resend.com/docs/send-with-supabase-smtp)。默认 Supabase SMTP 只给组织成员发信，约每小时 2 封，**不能**当作 QQ/163 验收通道。

仓库里**没有** Resend 账号、API key 或已验证发信域名。不要把占位符当成已配置。

## 当前必须写进 Dashboard 的 Auth URL

项目：`zhiyu` / `lzomhnjyymalupgvcato`。MCP 不能改 Auth Site URL，需要你在 Dashboard 手动设置。

**Authentication → URL Configuration（现在）**

| 字段 | 当前值 |
| --- | --- |
| Site URL | `http://localhost:3000`（操作者已保存；不要改成网站域名） |
| Redirect allow-list | `http://localhost:3000/auth/confirm` |
| | `http://localhost:3000/auth/update-password` |

当前 **没有** `127.0.0.1` 回调。浏览器和 Auth `redirect_to` 必须用 `http://localhost:3000`。

应用 `APP_ORIGIN` 同步为 `http://localhost:3000`。确认路由是 `GET /auth/confirm?token_hash=…&type=email|recovery|signup`，与官方 Next.js `with-supabase` 一致。

**以后网站真的部署到生产再改（现在不要改）**

1. Site URL → `https://zhiyulearn.online`
2. 把上面 4 条 localhost 回调留着（本机联调仍需要），再增加：
   - `https://zhiyulearn.online/auth/confirm`
   - `https://zhiyulearn.online/auth/update-password`
3. `.env.hosted.local` 的 `APP_ORIGIN=https://zhiyulearn.online`
4. 强制登录隔离时，用带 `AUTH_MODE=supabase` 的**独立** compose 项目。课堂 `openmaic-main` 可以烘焙 `NEXT_PUBLIC_SUPABASE_*` 并保持 `AUTH_MODE` 为空，这样 `/auth/confirm` 能换票，匿名课堂仍可用。

拥有域名 ≠ 站点已上线。在证书和反代就绪前，不要把 Site URL 切到 `https://zhiyulearn.online`。

## 你需要完成的 Resend / DNS / SMTP（仓库做不到）

### A. Resend 账号与发信域名

1. 在 [resend.com](https://resend.com) 开账号（免费额度即可先试；不要为了本任务去买新的付费云资源）。
2. 添加发信域名。建议与网站部署分开，例如 `mail.zhiyulearn.online` 或直接 `zhiyulearn.online`。以 Resend 控制台给出的记录为准。
3. 在**域名 DNS**（不是本仓库、也不是必须先上网站）添加 Resend 给出的记录，通常包括：
   - DKIM：若干 `CNAME`（或 TXT，以控制台为准）
   - SPF：`TXT`（不要和已有 SPF 冲突，应合并）
   - DMARC：`_dmarc` 的 `TXT`（可先 `p=none`）
4. 等 Resend 显示 domain **Verified**。未验证时不要填进 Supabase，也不要宣布 QQ/163 可用。
5. 创建 API key，只放进密钥库。不要提交 git、不要贴进文档或聊天记录。

### B. Supabase Dashboard → Authentication → Emails → SMTP Settings

打开 [SMTP 设置](https://supabase.com/dashboard/project/lzomhnjyymalupgvcato/auth/smtp)（路径以控制台实际菜单为准：Authentication → Notifications / Emails → SMTP）。

| Dashboard 字段 | 填什么 | 不要填 |
| --- | --- | --- |
| Enable custom SMTP | 打开 | 保持默认 SMTP |
| Sender email | 已验证域名上的地址，例如 `noreply@mail.zhiyulearn.online` | `noreply@localhost`、未验证域名 |
| Sender name | `智域` | 营销文案、促销签名 |
| Host | `smtp.resend.com` | 其它猜的主机 |
| Port | `465` | 不要混用未确认的端口 |
| Username | `resend` | API key、邮箱账号 |
| Password | Resend API key（密钥库） | 用户 QQ/163 邮箱密码 |

保存后 Auth 才会把确认信、重发、找回密码交给 Resend。仓库应用**不**直连 Resend；用户**不**向智域提供邮箱登录密码。

### C. 邮件模板（必须与 `/auth/confirm` 一致）

Dashboard → Authentication → Email Templates。不要用默认的 hash-fragment / Magic Link 混用。本项目走 `token_hash` + `verifyOtp`。

**Confirm signup** 按钮/链接：

```text
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email
```

**Reset password**：

```text
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery
```

短正文即可，不要夹营销、不要用户昵称。完整可粘贴 HTML 见 [zhiyu-auth-email-templates.md](zhiyu-auth-email-templates.md)。

开启 **Confirm email**（不要自动确认普通注册）。预置 admin 由脚本 `email_confirm: true` 创建，不走这封信。

## 应用侧已经接好的部分

- `/auth/sign-up`：邮箱 + 智域密码 + 重复密码 → `signUp` → `/auth/check-email`
- `/auth/confirm`：校验 `token_hash`，类型限 `email` / `recovery` / `email_change` / `signup`
- `/auth/login`、`/auth/forgot-password`、`/auth/update-password`
- `POST /api/auth/resend`：同源 + 限频；成功文案不暴露邮箱是否存在
- 重定向 `next` 只允许站内路径

真实 QQ/163 的注册、确认、重发、找回：**只有实际发出并点开链接后才能标通过**。

已发生的邮件若仍是默认英文 `{{ .ConfirmationURL }}`，点开会落到 `http://localhost:3000/#access_token=…`。必须按 [zhiyu-auth-email-templates.md](zhiyu-auth-email-templates.md) 粘贴 `token_hash` 模板后再发新信。应用会去掉地址栏 hash，但那不是官方 confirm 流程。
