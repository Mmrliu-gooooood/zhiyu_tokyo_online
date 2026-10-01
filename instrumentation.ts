/**
 * Process-scoped startup work.
 *
 * Next calls `register` once per server instance, before it serves a request.
 * That makes it the only place in this app where a background schedule can
 * live: a route module has no such guarantee — it can be instantiated more than
 * once and gets no shutdown hook — so anything periodic started from one is
 * really started per instantiation.
 *
 * `register` must return before the server is ready, so nothing here may block
 * on I/O. Starting a timer does not.
 */
export async function register(): Promise<void> {
  // Also invoked for the Edge runtime, which has neither `pg` nor timers we
  // want; the persistence stack is Node-only.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Imported dynamically so the Edge bundle never pulls in `pg`.
  const { startAssetCollectorSchedule } =
    await import('@/lib/persistence/asset-collector-schedule');
  const assetSchedule = startAssetCollectorSchedule();

  // Warn-first boot-time validation of model routing config (MODEL_ROUTES,
  // DEFAULT_MODEL, <PREFIX>_MODELS). Cheap and non-throwing: broken config
  // surfaces here as [config] warnings instead of failing at request time.
  // Imported dynamically so the Edge bundle never pulls in the fs/js-yaml
  // backed provider config it reads.
  const { validateServerConfig } = await import('@/lib/server/config-validation');
  validateServerConfig();

  // Model gateway checks that must stop startup (e.g. a proxy configured for a
  // provider whose SDK transport would silently bypass it).
  const { runGatewayStartupChecks } = await import('@/lib/model-gateway/startup');
  runGatewayStartupChecks();

  // Warm the model gateway's pi runtime (and keep its lazily loaded entry points
  // in the standalone file trace) without delaying readiness: the platform
  // default model speaks OpenAI Chat Completions.
  void import('@/lib/model-gateway/runtime/pi-registry')
    .then((registry) => registry.warmApi('openai-completions'))
    .catch(() => undefined);

  let runner: import('@/lib/server/agent-runtime/runner').AgentRunnerHandle | undefined;
  let extractionRunner:
    | import('@/lib/server/material-extraction/runner').MaterialExtractionRunnerHandle
    | undefined;
  let stopAgentEventNotifyBus: (() => Promise<void>) | null = null;
  try {
    const { isAgentRuntimeConfigured, isAgentRuntimeWorkerConfigured } =
      await import('@/lib/config/feature-flags');
    if (isAgentRuntimeConfigured()) {
      // The Web process owns the in-memory SSE subscribers, so it needs its
      // own app_web session LISTEN connection. This never receives app_worker
      // credentials; durable polling remains the recovery backstop.
      const [{ startAgentEventNotifyBus }, { getWebListenDatabaseUrl }] = await Promise.all([
        import('@/lib/server/agent-runtime/event-notify-bus'),
        import('@/lib/db/database-urls'),
      ]);
      const eventNotifyBus = startAgentEventNotifyBus({
        connectionString: getWebListenDatabaseUrl(),
      });
      stopAgentEventNotifyBus = () => eventNotifyBus.stop();
    }
    if (isAgentRuntimeWorkerConfigured()) {
      // startAgentRunner only installs a timer. Store/schema initialization is
      // retained behind the store's lazy promise and never blocks register().
      const runtime = await import('@/lib/server/agent-runtime/runner');
      const mediaSnapshots = await import('@/lib/server/media-config-snapshots');
      runner = runtime.startAgentRunner({
        loadMediaConfigSnapshot: async (ownerId, ref) =>
          (await mediaSnapshots.loadMediaConfigSnapshot(
            ownerId,
            ref,
          )) as unknown as import('@/lib/server/agent-runtime/course-tools').AgentSessionMediaConfig,
      });
      const extraction = await import('@/lib/server/material-extraction/runner');
      extractionRunner = extraction.startMaterialExtractionRunner();
    }
  } catch (error) {
    console.error('[instrumentation] Agent runtime startup failed', error);
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      // Park sessions before any pool they use is closed. This preserves the
      // last durable entry-tree checkpoint for immediate takeover.
      try {
        await extractionRunner?.stop();
      } catch (error) {
        console.error('[instrumentation] Material extraction runner drain failed', error);
      }
      try {
        await runner?.stop();
      } catch (error) {
        console.error('[instrumentation] Agent runner drain failed', error);
      }
      try {
        await stopAgentEventNotifyBus?.();
      } catch (error) {
        console.error('[instrumentation] Agent event notify bus drain failed', error);
      }
      try {
        await assetSchedule?.stop();
      } catch (error) {
        console.error('[instrumentation] Asset collector drain failed', error);
      }
      const { trySystemDatabaseUrl } = await import('@/lib/db/database-urls');
      const urls = new Set(
        [process.env.DATABASE_URL?.trim(), trySystemDatabaseUrl()].filter(
          (value): value is string => Boolean(value),
        ),
      );
      for (const connectionString of urls) {
        try {
          const { getServerPersistenceProvider } =
            await import('@/lib/persistence/server-provider');
          const { pool } = await getServerPersistenceProvider(connectionString);
          await pool.end();
        } catch (error) {
          console.error('[instrumentation] Persistence pool shutdown failed', error);
        }
      }
    })();
    return shutdownPromise;
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
