/**
 * The process-wide model gateway. Business code calls `gateway.stream`,
 * `gateway.complete` or `runToolLoop`; tests build isolated instances with
 * `createGateway(overrides)` or testing/faux-gateway.ts.
 */
import type { ModelGateway } from '../types';
import { createGateway } from './pipeline';

export { createGateway };
export type { GatewayDeps, LlmCallLog } from './pipeline';

export const gateway: ModelGateway = createGateway();
