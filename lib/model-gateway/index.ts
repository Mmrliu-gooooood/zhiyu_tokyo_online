/**
 * Server-side public API of the model gateway. Client code may import only
 * `@/lib/model-gateway/types` (types) and `@/lib/model-gateway/catalog/*`.
 */
export * from './types';
export {
  assistantText,
  fromChatTurns,
  messageText,
  toolResult,
  userContent,
  userParts,
  userText,
} from './messages';
export type { ChatTurn, ImageInput, UserPart } from './messages';
export { readModelSelection, thinkingFromBody } from './selection/read-request';
export type { RequestModelSelection } from './selection/read-request';
export { getBindingResolutionError, resolveBinding } from './selection/resolve-binding';
export type { ResolveBindingInput } from './selection/resolve-binding';
export {
  modelParamsFromBody,
  resolveHeaderBinding,
  resolveParamsBinding,
  resolveRequestBinding,
  selectionFromParams,
} from './selection/request-binding';
export { ModelSelectionError } from './selection/errors';
export {
  GATEWAY_VERSION,
  LEGACY_SELECTION_VERSION,
  persistedSelectionSchema,
  selectionModelString,
  storedSelectionRequest,
} from './selection/persisted';
export {
  modelSelectionSchema,
  parseModelString,
  upgradeLegacyModelParams,
} from './selection/schema';
export type { LegacyModelParams, ModelSelection, UserConnection } from './selection/schema';
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
