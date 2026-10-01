/**
 * The only module allowed to import the pi-ai runtime (see the model gateway
 * plan, section 3.2). Provider instances and the per-call `Models` view are
 * added in P1-2.
 */

/**
 * Tracing anchors for the standalone build. pi-ai is server-external and its
 * entry points are loaded lazily, so without literal specifiers here Next's
 * file tracing would leave the package out of `.next/standalone`. pi-ai's own
 * provider -> API modules use relative literal `import()`s, which the tracer
 * follows from these entry points. The thunks are never called.
 */
const _piRuntimeTraceAnchors = {
  root: () => import('@earendil-works/pi-ai'),
  deepseek: () => import('@earendil-works/pi-ai/providers/deepseek'),
  openAICompletions: () => import('@earendil-works/pi-ai/api/openai-completions'),
};
void _piRuntimeTraceAnchors;

export {};
