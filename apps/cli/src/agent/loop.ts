/**
 * The local agentic coding loop.
 *
 * Runs entirely in the CLI process: the model (via the Vercel AI Gateway) calls
 * the local coding tools in a multi-step loop until the task is done. This is
 * the piece that turns `oxagen` from a thin remote chat client into a
 * Claude Code-style coding agent operating on the local repository.
 *
 * Engram context retrieval layers on top of this (Phase 2): a `compile()` call
 * will assemble retrieved memory into a context section, and `remember()` will
 * record episodic events after each turn. The loop is structured so that
 * `history` and the system prompt are the seams where that context plugs in.
 */
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { buildTools } from "./tools.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { resolveModelId } from "./model.js";
import { ensureGatewayKey } from "./env.js";

export interface RunAgentOptions {
  /** The user's prompt for this turn. */
  prompt: string;
  /** Prior conversation messages (for multi-turn REPL sessions). */
  history?: ModelMessage[];
  /** Working directory the agent operates on (default: process.cwd()). */
  cwd?: string;
  /** Gateway model slug override. */
  model?: string;
  /** Max tool-loop steps before stopping (default 32). */
  maxSteps?: number;
  /** Abort the turn (e.g. user hit Ctrl-C). */
  signal?: AbortSignal;
  /** Streamed assistant text deltas. */
  onText?: (delta: string) => void;
  /** Fired when the model invokes a tool. */
  onToolCall?: (name: string, input: unknown) => void;
}

export interface RunAgentResult {
  text: string;
  steps: number;
  /** Full message history including this turn's assistant/tool messages. */
  messages: ModelMessage[];
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export class MissingGatewayKeyError extends Error {
  constructor() {
    super(
      "No AI_GATEWAY_API_KEY found. Set it in your shell, in ~/.config/oxagen/config.json " +
        '("gatewayKey"), or in a .env.local above the working directory.',
    );
    this.name = "MissingGatewayKeyError";
  }
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const cwd = opts.cwd ?? process.cwd();
  if (!ensureGatewayKey(cwd)) throw new MissingGatewayKeyError();

  const messages: ModelMessage[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.prompt },
  ];

  const result = streamText({
    model: resolveModelId(opts.model),
    system: buildSystemPrompt(cwd),
    messages,
    tools: buildTools(cwd),
    stopWhen: stepCountIs(opts.maxSteps ?? 32),
    abortSignal: opts.signal,
    onStepFinish: ({ toolCalls }) => {
      if (!opts.onToolCall) return;
      for (const tc of toolCalls ?? []) {
        const call = tc as { toolName: string; input?: unknown; args?: unknown };
        opts.onToolCall(call.toolName, call.input ?? call.args);
      }
    },
  });

  let text = "";
  for await (const delta of result.textStream) {
    text += delta;
    opts.onText?.(delta);
  }

  const steps = (await result.steps).length;
  const usage = await result.usage;
  const response = await result.response;

  return {
    text,
    steps,
    messages: [...messages, ...response.messages],
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    },
  };
}
