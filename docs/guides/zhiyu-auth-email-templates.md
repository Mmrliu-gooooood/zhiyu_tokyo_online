# 智域 Auth 邮件模板（粘贴到 Supabase Dashboard）

MCP **不能**改 Email Templates。默认英文模板用 `{{ .ConfirmationURL }}`，会把用户送到 Site URL 并带上 `#access_token=`（implicit hash）。本项目必须改成 `token_hash` 查询参数，走官方 Next.js with-supabase 的 `/auth/confirm`。

打开：[Email Templates](https://supabase.com/dashboard/project/lzomhnjyymalupgvcato/auth/templates)

路径：Authentication → Emails → Templates（或 Notifications → Templates）。

`{{ .SiteURL }}` 现在是 `http://localhost:3000`。allow-list 只有这条主机，**不要**改用 `127.0.0.1`。不要用 `{{ .ConfirmationURL }}`。

SMTP（`auth.zhiyulearn.online` / Resend）已保存。QQ 已提示发件人未验证：随后做 DMARC/对齐，不作为本次通过项。

操作者已说明 Confirm + Reset 的 `token_hash` HTML 已粘贴进 Dashboard。在有收件箱截图证明之前，仍把**新邮件**当作 `{{ .SiteURL }}/auth/confirm?token_hash=…`；若再次出现 `#access_token=` 则视为失败。MCP 仍然不能改模板。

## Confirm signup（立刻替换）

Subject: `确认你的智域邮箱`

```html
<h2>确认邮箱</h2>
<p>点击下面的链接确认注册。如果不是你本人操作，请忽略这封信。</p>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email">确认邮箱</a></p>
```

保存后新注册才会落到 `/auth/confirm?token_hash=…&type=email`，地址栏不会出现 `access_token`。

## Reset password（立刻替换）

Subject: `重置智域密码`

```html
<h2>重置密码</h2>
<p>点击下面的链接设置新密码。如果不是你本人操作，请忽略这封信。</p>
<p><a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery">重置密码</a></p>
```

点开后由 `/auth/confirm` 校验，再跳到 `/auth/update-password`（不要改密码除非你在测重置）。

## Magic Link / Invite

本期不启用 Magic Link 登录。Invite 如 Dashboard 必填，可指向同一 confirm 路由，产品入口只有邮箱密码注册。

不要在认证信里放课程内容、促销或用户昵称。
