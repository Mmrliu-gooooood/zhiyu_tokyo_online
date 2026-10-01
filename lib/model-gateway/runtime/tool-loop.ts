/**
 * Multi-step tool loop (plan 3.12) for PBL planner / instructor style agents.
 * Each step is one full gateway call (quota, usage and logging per step).
 * Tool inputs are validated with zod; invalid input or a throwing tool becomes
 * an `isError` tool result the model sees, as the AI SDK did. Every tool call
 * executes exactly once, in the order the model emitted them.
 */
import { z } from 'zod';
import { toolResult } from '../messages';
import type {
  AssistantMessage,
  GatewayCallOptions,
  GatewayMessage,
  GatewayStreamEvent,
  GatewayTool,
  ModelBinding,
  ModelGateway,
  NormalizedUsage,
  ToolCall,
} from '../types';
import { toPiToolSchema } from './pi-registry';
import { addUsage, ZERO_USAGE } from './usage';

export interface LoopToolContext {
  toolCallId: string;
  step: number;
  signal?: AbortSignal;
}

export interface LoopTool<Input = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input>;
  execute(input: Input, ctx: LoopToolContext): unknown | Promise<unknown>;
}

export interface ToolLoopToolResult {
  toolCallId: string;
  toolName: string;
  output: unknown;
  isError: boolean;
}

export interface ToolLoopStep {
  index: number;
  message: AssistantMessage;
  text: string;
  toolCalls: ToolCall[];
  toolResults: ToolLoopToolResult[];
  usage: NormalizedUsage;
}

export interface ToolLoopRequest {
  system?: string;
  messages: GatewayMessage[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous tool inputs
  tools: LoopTool<any>[];
  /** Upper bound on model calls. */
  maxSteps: number;
  /** Stop after a step when this returns true (checked after its tools ran). */
  stopWhen?: (step: ToolLoopStep) => boolean;
  onStepFinish?: (step: ToolLoopStep) => void | Promise<void>;
  maxOutputTokens?: number | 'model-default' | 'omit';
  temperature?: number;
}

export type ToolLoopEvent =
  | GatewayStreamEvent
  | ({ type: 'tool_result' } & ToolLoopToolResult)
  | { type: 'step_finish'; step: ToolLoopStep };

export interface ToolLoopResult {
  steps: ToolLoopStep[];
  /** The request messages plus every assistant turn and tool result appended by the loop. */
  messages: GatewayMessage[];
  text: string;
  usage: NormalizedUsage;
  finishReason: 'stop' | 'length' | 'tool-calls' | 'stop-condition' | 'max-steps';
}

export interface ToolLoopStream extends AsyncIterable<ToolLoopEvent> {
  result(): Promise<ToolLoopResult>;
}

/** zod v4 → JSON Schema → pi tool declaration. */
export function toGatewayTool(tool: LoopTool): GatewayTool {
  const schema = z.toJSONSchema(tool.inputSchema, { io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: tool.name, description: tool.description, parameters: toPiToolSchema(schema) };
}

function serializeOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output ?? null);
  } catch {
    return String(output);
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export function runToolLoop(
  gateway: ModelGateway,
  binding: ModelBinding,
  req: ToolLoopRequest,
  opts: GatewayCallOptions,
): ToolLoopStream {
  const events: ToolLoopEvent[] = [];
  let waiters: (() => void)[] = [];
  let finished = false;
  let outcome: { result?: ToolLoopResult; error?: unknown } | undefined;
  const push = (event: ToolLoopEvent) => {
    events.push(event);
    const wake = waiters;
    waiters = [];
    for (const fn of wake) fn();
  };
  const finish = (value: { result?: ToolLoopResult; error?: unknown }) => {
    outcome = value;
    finished = true;
    const wake = waiters;
    waiters = [];
    for (const fn of wake) fn();
  };
  const wait = () => new Promise<void>((resolve) => waiters.push(resolve));

  const toolsByName = new Map(req.tools.map((tool) => [tool.name, tool]));
  const declarations = req.tools.map(toGatewayTool);

  void (async () => {
    const messages: GatewayMessage[] = [...req.messages];
    const steps: ToolLoopStep[] = [];
    let usage = ZERO_USAGE;
    try {
      for (let index = 0; index < req.maxSteps; index += 1) {
        const stream = gateway.stream(
          binding,
          {
            system: req.system,
            messages,
            tools: declarations,
            toolChoice: 'auto',
            maxOutputTokens: req.maxOutputTokens,
            temperature: req.temperature,
          },
          opts,
        );
        for await (const event of stream) push(event);
        const turn = await stream.result();
        usage = addUsage(usage, turn.usage);
        messages.push(turn.message);

        const toolResults: ToolLoopToolResult[] = [];
        const runTools = turn.stopReason === 'toolUse' ? turn.toolCalls : [];
        for (const call of runTools) {
          const result = await executeTool(call, index);
          toolResults.push(result);
          messages.push(
            toolResult(call, serializeOutput(result.output), { isError: result.isError }),
          );
          push({ type: 'tool_result', ...result });
        }
        const step: ToolLoopStep = {
          index,
          message: turn.message,
          text: turn.text,
          toolCalls: turn.toolCalls,
          toolResults,
          usage: turn.usage,
        };
        steps.push(step);
        push({ type: 'step_finish', step });
        await req.onStepFinish?.(step);

        const done = (finishReason: ToolLoopResult['finishReason']) =>
          finish({ result: { steps, messages, text: turn.text, usage, finishReason } });
        if (runTools.length === 0) return done(turn.stopReason === 'length' ? 'length' : 'stop');
        if (req.stopWhen?.(step)) return done('stop-condition');
        if (index + 1 >= req.maxSteps) return done('max-steps');
      }
      finish({
        result: {
          steps,
          messages,
          text: steps.at(-1)?.text ?? '',
          usage,
          finishReason: 'max-steps',
        },
      });
    } catch (error) {
      finish({ error });
    }
  })();

  async function executeTool(call: ToolCall, step: number): Promise<ToolLoopToolResult> {
    const base = { toolCallId: call.id, toolName: call.name };
    const tool = toolsByName.get(call.name);
    if (!tool) return { ...base, output: `Unknown tool: ${call.name}`, isError: true };
    const parsed = tool.inputSchema.safeParse(call.arguments);
    if (!parsed.success) {
      return {
        ...base,
        output: `Invalid input for tool ${call.name}: ${formatIssues(parsed.error)}`,
        isError: true,
      };
    }
    try {
      opts.signal?.throwIfAborted();
      const output = await tool.execute(parsed.data, {
        toolCallId: call.id,
        step,
        signal: opts.signal,
      });
      return { ...base, output, isError: false };
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      return {
        ...base,
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  return {
    [Symbol.asyncIterator]() {
      let cursor = 0;
      return {
        async next() {
          while (cursor >= events.length) {
            if (finished) return { done: true, value: undefined };
            await wait();
          }
          return { done: false, value: events[cursor++]! };
        },
      };
    },
    async result() {
      while (!finished) await wait();
      if (outcome?.error) throw outcome.error;
      return outcome!.result!;
    },
  };
}
