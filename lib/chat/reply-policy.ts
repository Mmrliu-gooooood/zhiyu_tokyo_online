/** Limits apply to live user replies, never to generated lecture actions. */
export function getReplyPolicy(messages: unknown[], config: { sessionType?: string }) {
  const user = [...messages]
    .reverse()
    .find(
      (message): message is Record<string, unknown> =>
        !!message && typeof message === 'object' && 'role' in message && message.role === 'user',
    );
  const text = user
    ? (typeof user.content === 'string'
        ? user.content
        : Array.isArray(user.parts)
          ? user.parts.map((part) => (part?.type === 'text' ? part.text : '')).join('\n')
          : ''
      ).trim()
    : '';
  // Whole-message matching deliberately excludes “对吗” and “明白了，但…”.
  const acknowledgment =
    /^(?:明白了|我明白了|懂了|我懂了|知道了|我知道了|清楚了|了解了|对|对的|是的|好|好的|嗯|谢谢|谢谢老师|没问题了|没有其他问题了|不用了|ok|okay|got it|understood|thanks|thank you)[\s。！!,.，]*$/i.test(
      text,
    );
  const deeperDiscussion =
    /(?:请|想|希望|我们|大家).{0,12}(?:深入讨论|展开讨论|辩论|多角度讨论)|(?:discuss in depth|debate this)/i.test(
      text,
    );
  return {
    userInitiated: Boolean(user),
    acknowledgment,
    maxTurns: user
      ? acknowledgment
        ? 1
        : deeperDiscussion
          ? 3
          : 2
      : config.sessionType === 'discussion'
        ? 6
        : 3,
  };
}

export function buildUserReplyGuidance(messages: unknown[], role?: string): string {
  const policy = getReplyPolicy(messages, {});
  if (!policy.userInitiated) return '';
  if (policy.acknowledgment) {
    return 'The user gave a bare acknowledgment. Have only the teacher acknowledge briefly in ONE short sentence, then end this side conversation. Do not repeat explanations, introduce a topic, or ask a follow-up question.';
  }
  return [
    'For this user turn, the teacher answers first. Stop once the question is answered. Do not call an agent who already spoke in this turn.',
    policy.maxTurns === 3
      ? 'The user explicitly requested deeper discussion: allow at most two brief, distinct supporting contributions.'
      : 'Allow at most ONE optional non-teacher contribution, only if it adds a missing fact or clarifies a misconception. No praise-only reactions, repeated summaries, or student-to-student conversation.',
    role && role !== 'teacher'
      ? 'Your entire contribution is ONE short sentence (about 40 Chinese characters). Add one useful point, then stop. Do not ask a question or invite another agent.'
      : 'Answer the actual question directly and concisely. Do not invent a new exercise or invite classmates to keep the conversation going. Ask a follow-up only if clarification is necessary to answer the user.',
  ].join('\n');
}
