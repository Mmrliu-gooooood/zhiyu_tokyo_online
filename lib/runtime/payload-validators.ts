import { isChatMessageSkeleton, isQuizAttemptSkeleton } from '@openmaic/dsl';
import type { RuntimePayloadValidator } from '@openmaic/storage';

import { whiteboardRuntimePayloadValidator } from '@/lib/whiteboard/runtime/validate';
import { validateQuizAttemptPayloadV2 } from '@/lib/quiz/attempt-schema';
import { learningCheckRuntimePayloadValidator } from '@/lib/learning/contracts';
import { learningDialogueRuntimePayloadValidator } from '@/lib/learning/guided-runtime';
import { teachBackRuntimePayloadValidator } from '@/lib/learning/teach-back/contracts';

const chat: RuntimePayloadValidator = (payload) =>
  isChatMessageSkeleton(payload)
    ? { valid: true }
    : {
        valid: false,
        errors: [
          {
            path: '/payload',
            message: 'chat payload must match ChatMessageSkeleton (role + content)',
          },
        ],
      };

const quizAttempt: RuntimePayloadValidator = (payload) => {
  const errors =
    typeof payload === 'object' &&
    payload !== null &&
    'payloadVersion' in payload &&
    payload.payloadVersion === 2
      ? validateQuizAttemptPayloadV2(payload)
      : [];
  return errors.length === 0 &&
    (isQuizAttemptSkeleton(payload) ||
      (typeof payload === 'object' &&
        payload !== null &&
        'payloadVersion' in payload &&
        payload.payloadVersion === 2))
    ? { valid: true }
    : {
        valid: false,
        errors: [
          {
            path: '/payload',
            message:
              errors[0] ?? 'quizAttempt payload must match QuizAttemptSkeleton (phase + answers)',
          },
        ],
      };
};

/** Complete app validator table. RuntimeStore options replace their defaults. */
export const APP_RUNTIME_PAYLOAD_VALIDATORS = Object.freeze({
  chat,
  learningCheck: learningCheckRuntimePayloadValidator,
  learningDialogue: learningDialogueRuntimePayloadValidator,
  quizAttempt,
  whiteboard: whiteboardRuntimePayloadValidator,
  teachBack: teachBackRuntimePayloadValidator,
}) satisfies Readonly<Record<string, RuntimePayloadValidator>>;
