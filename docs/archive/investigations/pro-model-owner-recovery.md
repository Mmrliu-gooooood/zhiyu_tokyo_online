# 本地旧会话恢复

PRO 现在仅使用 `generation_owner` 签名 cookie。`anonymous_id` 不再证明身份，即使设置了 `GENERATION_TRUST_LEGACY_OWNER=1` 也不会在 PRO 自动接管旧 UUID。数据库中的旧会话、课程和附件仍保留，不自动重分配。

受信任的本机管理员可以恢复经过核实的旧 owner：

1. 从本机备份、原浏览器 `anonymous_id` 和数据库会话内容核实实际归属；仅知道一个 UUID 不足以授权。不要让远端用户请求代签其他 owner。
2. 在受保护的本机终端中提供与应用相同的 `GENERATION_SESSION_SECRET` 环境变量。运行 `node scripts/sign-pro-owner-session.mjs --owner anon:<已核实的UUID> --output <新建私密文件路径>`。脚本不修改数据库、不覆盖文件，也不在普通日志中输出签名。
3. 在该用户浏览器开发者工具的应用/Cookies 面板，将本站 `generation_owner` 值设为私密文件中的完整内容（属性 Path `/`、HttpOnly、SameSite Strict；HTTPS 使用 Secure）。刷新页面后原 owner 的课程和会话可继续访问。
4. 删除临时私密文件，保持 `GENERATION_TRUST_LEGACY_OWNER=0`。签名 cookie 是身份凭证，不要复制到工单、日志或截图。

这条恢复路径要求管理员持有部署签名密钥，并明确核实、选择一个旧 owner；不存在按浏览器提交 UUID 自动认领的 HTTP 接口。

本次本机交付已根据用户截图中的会话 `aa68d847-a035-46c8-b645-266aca05e431` 和原数据库核实旧 owner，并将其签名 cookie 预先写入 `.scratch/pro-model-deploy-backup/verified-owner-cookie.txt`。该文件仅供这台电脑原用户执行第 3 步恢复；不要分享文件内容。已有 2 个会话、2 门课程、11 个页面继续保存在原数据库中。

模型连接密文使用独立 `PRO_MODEL_ENCRYPTION_KEY`（64 个十六进制字符，即随机 32 字节 AES 密钥）。需与数据库一起备份；更换密钥后旧连接必须从 Home 重新同步。会话中只保存连接 id/revision。
