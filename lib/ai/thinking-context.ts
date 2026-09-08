/**
 * Async-context carrier for per-request ThinkingConfig.
 *
 * callLLM / streamLLM wrap each AI SDK call in thinkingContext.run()
 * so that the custom fetch wrapper in providers.ts can read the
 * current thinking preference and inject vendor-specific body params.
 *
 * IMPORTANT: This module uses node:async_hooks which is server-only.
 * providers.ts must NOT import this module directly (it's also used
 * on the client via settings.ts). Instead, providers.ts reads the
 * context via globalThis.__thinkingContext, which is set here at
 * module load time and guaranteed to be available before any fetch
 * wrapper runs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ThinkingConfig } from '@/lib/types/provider';

type ThinkingContextCarrier = AsyncLocalStorage<ThinkingConfig | undefined>;

const serverGlobal = globalThis as typeof globalThis & {
  __thinkingContext?: ThinkingContextCarrier;
};

// Production bundling can evaluate this module from more than one server
// chunk. Reuse the first carrier in the process so a later module copy cannot
// redirect provider fetches away from the ALS in which callLLM is running.
export const thinkingContext =
  serverGlobal.__thinkingContext ?? new AsyncLocalStorage<ThinkingConfig | undefined>();

// providers.ts reads this client-safe seam instead of importing async_hooks.
serverGlobal.__thinkingContext = thinkingContext;
