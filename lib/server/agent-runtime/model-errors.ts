const UNAVAILABLE_MESSAGE = 'PRO_MODEL_UNAVAILABLE: 模型服务暂时不可用，请稍后重试。';

const GATEWAY_CODE_MESSAGES: Partial<Record<string, string>> = {
  MODEL_CONFIGURATION: 'PRO_MODEL_AUTH: 模型凭据缺失或无效，请打开模型设置后重新检查。',
  MODEL_UNSAFE_ENDPOINT: 'PRO_MODEL_PROTOCOL: 模型协议不受支持，请打开模型设置后重新检查。',
  MODEL_AUTH_FAILED: 'PRO_MODEL_AUTH: 模型凭据缺失或无效，请打开模型设置后重新检查。',
  MODEL_REAUTH_REQUIRED: 'PRO_MODEL_AUTH: 模型凭据缺失或无效，请打开模型设置后重新检查。',
  MODEL_RATE_LIMITED: 'PRO_MODEL_RATE_LIMIT: 模型服务限流，请稍后重试。',
  MODEL_ABORTED: 'PRO_MODEL_CANCELLED: 模型调用已取消。',
  // Gateway-side (database / quota / entitlement backend) failure before sending: not a setting.
  MODEL_GATEWAY_UNAVAILABLE: UNAVAILABLE_MESSAGE,
};

/** After-class classmate chats (B05): fixed codes the chat page explains. */
const STUDY_CODE_MESSAGES: Partial<Record<string, string>> = {
  STUDY_CLASSMATE_MODEL_UNAVAILABLE:
    '学伴的独立回答模型当前不可用，没有改用其他模型；请到学伴设置中修改，或改回“继承当前模型”。',
  STUDY_CLASSMATE_ARCHIVED: '这个学伴已归档，恢复后才能继续对话。',
  STUDY_CLASSMATE_NOT_FOUND: '这个学伴已不存在。',
  STUDY_SPACE_ARCHIVED: '这个学科已归档，恢复后才能继续对话。',
  STUDY_SPACE_NOT_FOUND: '这个学科已不存在。',
  STUDY_COMPANION_UNAVAILABLE: '课后答疑功能当前未开启。',
};

/** Never expose provider response bodies, request headers, or connection secrets. */
export function safeModelError(error: unknown): string {
  // A CompanionRunError, or its already-mapped message passed back in.
  const studyMatch =
    error instanceof Error && error.name === 'CompanionRunError'
      ? /^(STUDY_[A-Z_]+)(?::([a-z_]+))?:/.exec(error.message)
      : typeof error === 'string'
        ? /^(STUDY_[A-Z_]+)(?::([a-z_]+))?: /.exec(error)
        : null;
  if (studyMatch && STUDY_CODE_MESSAGES[studyMatch[1]!]) {
    const code = studyMatch[2] ? `${studyMatch[1]}:${studyMatch[2]}` : studyMatch[1]!;
    return `${code}: ${STUDY_CODE_MESSAGES[studyMatch[1]!]}`;
  }
  const gatewayCode =
    error instanceof Error && error.name === 'GatewayError'
      ? (error as Error & { code?: string }).code
      : undefined;
  const mapped = gatewayCode ? GATEWAY_CODE_MESSAGES[gatewayCode] : undefined;
  if (mapped) return mapped;
  if (gatewayCode) return 'PRO_MODEL_EXECUTION: 模型调用未完成，请检查模型设置或稍后重试。';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (message.startsWith('PRO_MODEL_UNAVAILABLE:')) return UNAVAILABLE_MESSAGE;
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
  return /^(PRO_MODEL_(AUTH|REVOKED|PROTOCOL|TOOLS|MISSING|THINKING|ENCRYPTION)|STUDY_[A-Z_]+(:[a-z_]+)?):/.test(
    safeModelError(error),
  );
}
