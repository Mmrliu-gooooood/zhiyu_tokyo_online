/** Never expose provider response bodies, request headers, or connection secrets. */
export function safeModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/PRO_SKILL_UNAVAILABLE|session skill .* is unavailable for its owner/i.test(message))
    return 'PRO_SKILL_UNAVAILABLE: 当前会话的 skill 不可用，请重新选择可用的 skill。';
  if (
    /PRO_MODEL_(REVOKED|NOT_FOUND|CONNECTION_UNAVAILABLE)|revoked|not found or unavailable/i.test(
      message,
    )
  )
    return 'PRO_MODEL_REVOKED: 模型连接已清除或不可用，请打开模型设置后重新检查。';
  if (
    /PRO_MODEL_(PROTOCOL|PROVIDER_TYPE_MISMATCH|UNSAFE_ENDPOINT)|unsupported pi api|api\/dialect|provider type|Unknown provider/i.test(
      message,
    )
  )
    return 'PRO_MODEL_PROTOCOL: 模型协议不受支持，请打开模型设置后重新检查。';
  if (/PRO_MODEL_TOOLS|does not support.*tool|tool.*not supported/i.test(message))
    return 'PRO_MODEL_TOOLS: 当前模型不支持工具调用，请在模型设置中更换模型。';
  if (
    /PRO_MODEL_(AUTH|KEY_REQUIRED)|401|403|unauthorized|invalid.*key|api key|required.*key/i.test(
      message,
    )
  )
    return 'PRO_MODEL_AUTH: 模型凭据缺失或无效，请打开模型设置后重新检查。';
  if (/PRO_MODEL_RATE_LIMIT|429|rate.?limit/i.test(message))
    return 'PRO_MODEL_RATE_LIMIT: 模型服务限流，请稍后重试。';
  if (/must explicitly configure|No model could|PRO_MODEL_MISSING/i.test(message))
    return 'PRO_MODEL_MISSING: 尚未绑定可用模型，请打开模型设置后重新检查。';
  if (/PRO_MODEL_THINKING|thinking\.effort/i.test(message))
    return 'PRO_MODEL_THINKING: 驱动路由的 thinking.effort 与工具调用不兼容，请检查模型设置。';
  if (/encrypt|master.*key|PRO_MODEL_ENCRYPTION/i.test(message))
    return 'PRO_MODEL_ENCRYPTION: 服务器模型连接加密配置不可用，请联系管理员。';
  if (/abort|cancel/i.test(message)) return 'PRO_MODEL_CANCELLED: 模型调用已取消。';
  return 'PRO_MODEL_EXECUTION: 模型调用未完成，请检查模型设置或稍后重试。';
}

/** These failures require a new configuration before an undelivered message can run. */
export function isModelConfigurationError(error: unknown): boolean {
  return /^PRO_MODEL_(AUTH|REVOKED|PROTOCOL|TOOLS|MISSING|THINKING|ENCRYPTION):/.test(
    safeModelError(error),
  );
}
