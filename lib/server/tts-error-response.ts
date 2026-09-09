import { QwenTTSError } from '@/lib/audio/tts-providers';
import { QwenVoiceCloneError, qwenVoiceCloneErrorMessage } from '@/lib/audio/qwen-voice-clone';
import type { ApiErrorCode } from './api-response';

export interface TTSProviderErrorResponse {
  code: ApiErrorCode;
  status: number;
  message: string;
}

/** Keep provider-specific error interpretation out of the provider-neutral route. */
export function getTTSProviderErrorResponse(error: unknown): TTSProviderErrorResponse | null {
  if (error instanceof QwenVoiceCloneError) {
    return {
      code: error.code,
      status: error.httpStatus || 502,
      message: qwenVoiceCloneErrorMessage(error),
    };
  }
  if (error instanceof QwenTTSError) {
    return { code: error.code, status: error.httpStatus, message: error.message };
  }
  return null;
}
