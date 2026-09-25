import type { LanguageModel } from 'ai';
import { isHostedAuthEnabled } from '@/lib/auth/mode';
import { generationQuotaActive, getProviderQuotaOwner } from './provider-call-context';

/** Quota wraps each actual SDK provider operation, including streaming lifetime. */
export function withGenerationModelQuota(model: LanguageModel): LanguageModel {
  if (process.env.GENERATION_BACKGROUND_ENABLED !== '1' || generationQuotaActive()) return model;
  if (typeof model === 'string')
    throw new Error('Background deployment requires an explicitly resolved model');
  return new Proxy(model, {
    get(target, key, receiver) {
      const original: unknown = Reflect.get(target, key, receiver);
      if ((key !== 'doGenerate' && key !== 'doStream') || typeof original !== 'function')
        return original;
      return async (options: { abortSignal?: AbortSignal }) => {
        const signal = options.abortSignal
          ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(300_000)])
          : AbortSignal.timeout(300_000);
        // The browser-driven/legacy deployment must not load PostgreSQL's queue
        // dependency graph merely by importing the shared LLM layer. Keep the
        // synchronous stream factory while acquiring quota at the actual call.
        const [{ PostgresGenerationLimiter }, { generationConfig }, { getGenerationRequestPool }] =
          await Promise.all([import('./limiter'), import('./config'), import('./runtime')]);
        signal.throwIfAborted();
        const config = generationConfig();
        const limiter = new PostgresGenerationLimiter(
          getGenerationRequestPool(),
          {
            llm: config.llmConcurrency,
            tts: config.ttsConcurrency,
            media: config.mediaConcurrency,
          },
          { ownerId: isHostedAuthEnabled() ? getProviderQuotaOwner() : undefined },
        );
        if (key === 'doGenerate')
          return limiter.run('llm', 'deployment', signal, () =>
            Reflect.apply(original, target, [{ ...options, abortSignal: signal }]),
          );
        // Return the stream as soon as it opens, holding its slot until close,
        // cancellation, or error. The caller need not drain before receiving it.
        return new Promise((resolve, reject) => {
          void limiter
            .run('llm', 'deployment', signal, async () => {
              const response = await Reflect.apply(original, target, [
                { ...options, abortSignal: signal },
              ]);
              const reader = response.stream.getReader();
              await new Promise<void>((finished, failed) => {
                const abort = () => {
                  void reader.cancel(signal.reason).catch(() => {});
                  failed(signal.reason);
                };
                signal.addEventListener('abort', abort, { once: true });
                const end = () => signal.removeEventListener('abort', abort);
                const stream = new ReadableStream({
                  async pull(controller) {
                    try {
                      const item = await reader.read();
                      if (item.done) {
                        controller.close();
                        end();
                        finished();
                      } else controller.enqueue(item.value);
                    } catch (error) {
                      controller.error(error);
                      end();
                      failed(error);
                    }
                  },
                  async cancel(reason) {
                    end();
                    await reader.cancel(reason);
                    failed(reason ?? new Error('Stream cancelled'));
                  },
                });
                resolve({ ...response, stream });
                if (signal.aborted) abort();
              });
            })
            .catch(reject);
        });
      };
    },
  });
}
