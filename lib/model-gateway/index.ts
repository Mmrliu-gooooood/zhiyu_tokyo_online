/**
 * Server-side public API of the model gateway. Client code may import only
 * `@/lib/model-gateway/types` (types) and `@/lib/model-gateway/catalog/*`.
 */
export * from './types';
export { assistantText, messageText, toolResult, userContent, userText } from './messages';
export type { ImageInput } from './messages';
export { GatewayError, isGatewayError } from './runtime/errors';
export type { GatewayErrorCode } from './runtime/errors';
export { gateway, createGateway } from './runtime/gateway';
export type { GatewayDeps, LlmCallLog } from './runtime/gateway';
export { runToolLoop, toGatewayTool } from './runtime/tool-loop';
export type {
  LoopTool,
  LoopToolContext,
  ToolLoopEvent,
  ToolLoopRequest,
  ToolLoopResult,
  ToolLoopStep,
  ToolLoopStream,
} from './runtime/tool-loop';
export {
  AllowAllEntitlementPolicy,
  getEntitlementPolicy,
  setEntitlementPolicy,
} from './runtime/entitlement';
export { createBinding, withThinking } from './credentials/handles';
export type { BindingFields, CredentialHandle } from './credentials/handles';
