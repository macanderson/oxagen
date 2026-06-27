/**
 * The local agentic coding loop.
 *
 * Runs entirely in the CLI process: the model (via the Vercel AI Gateway) calls
 * local coding tools in a multi-step loop until the task is done. This is what
 * makes `oxagen` a real coding agent operating on the local repository.
 *
 * It is wired to Oxagen's knowledge-graph context engine in two places: recalled
 * project memory is injected before the turn, and the turn's activity is written
 * back as episodic memory after it.
 */
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { buildTools } from "./tools.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { resolveModelId } from "./model.js";
import { ensureGatewayKey, MissingGatewayKeyError } from "./env.js";
import { loadSettings } from "../settings/resolve.js";
import { wrapToolsWithGate } from "../settings/gate.js";
import { runHooks } from "../settings/hooks.js";
import { loadMcpTools, type McpServerStatus } from "../mcp/client.js";
import type { OxagenSettings } from "../settings/schema.js";
import type { ProjectContext } from "./project-context.js";
import type { SessionMemory } from "./memory.js";

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
  /** Loaded project rules (CLAUDE.md/AGENTS.md), injected into the system prompt. */
  projectContext?: ProjectContext;
  /** Read-only mode: no file mutation or command execution. */
  readOnly?: boolean;
  /** Session memory (Oxagen context engine). Recalled before, written after. */
  memory?: SessionMemory | null;
  /** Abort the turn (e.g. user hit Ctrl-C). */
  signal?: AbortSignal;
  /** Streamed assistant text deltas. */
  onText?: (delta: string) => void;
  /** Fired when the model invokes a tool. */
  onToolCall?: (name: string, input: unknown) => void;
  /** Fired when a tool is blocked by a permission rule or PreToolUse hook. */
  onToolBlocked?: (name: string, reason: string) => void;
  /** Fired once per external MCP server after its connect attempt. */
  onMcpServer?: (status: McpServerStatus) => void;
  /**
   * Resolved `settings.json` for this turn (permissions, hooks). Defaults to the
   * settings resolved from `cwd`. Injectable so callers (and tests) can override.
   */
  settings?: OxagenSettings;
}

export interface RunAgentResult {
  text: string;
  steps: number;
  /** Full message history including this turn's assistant/tool messages. */
  messages: ModelMessage[];
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

// Re-exported from ./env so consumers (e.g. the planner) can catch it without
// importing this whole loop (and its heavy transitive deps).
export { MissingGatewayKeyError };

/** Best-effort extraction of the human-readable cause from an AI Gateway error. */
function gatewayMessage(error: unknown): string {
  // AI SDK gateway errors carry the provider JSON on `.responseBody`.
  const body = (error as { responseBody?: unknown })?.responseBody;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      /* not JSON */
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Turn a raw streaming/gateway error into one clean, actionable Error. Keeps the
 * common dogfooding failures (no credits, bad key, rate limit) legible instead
 * of leaking the AI SDK's internal error object to the terminal.
 *
 * Exported for tests.
 */
export function normalizeAgentError(error: unknown): Error {
  const msg = gatewayMessage(error);
  if (/insufficient_funds|positive credit balance/i.test(msg)) {
    return new Error(
      "AI Gateway has no credit balance — every request (including BYOK) needs " +
        "credits. Add them to your Vercel AI Gateway account, then retry.",
    );
  }
  if (/\b401\b|unauthorized|invalid.*api.?key/i.test(msg)) {
    return new Error(
      "AI Gateway rejected the request (401). Check that AI_GATEWAY_API_KEY is set and valid.",
    );
  }
  if (/\b429\b|rate.?limit/i.test(msg)) {
    return new Error("AI Gateway rate-limited the request (429). Wait a moment and retry.");
  }
  return error instanceof Error ? error : new Error(msg);
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const cwd = opts.cwd ?? process.cwd();
  if (!ensureGatewayKey(cwd)) throw new MissingGatewayKeyError();

  // settings.json drives this turn's tool permissions and lifecycle hooks.
  const settings = opts.settings ?? loadSettings({ cwd }).settings;

  // Recall relevant project memory and write the incoming prompt (best-effort).
  const recalled = opts.memory ? await opts.memory.recallContext() : "";
  void opts.memory?.remember("user_prompt", opts.prompt);

  let system = buildSystemPrompt({
    cwd,
    projectContext: opts.projectContext,
    readOnly: opts.readOnly,
  });
  if (recalled) {
    system +=
      "\n\n## Recent project activity (recalled from the Oxagen context engine)\n" +
      recalled;
  }

  // SessionStart hooks may print context (sprint, on-call notes, changelog) to
  // stdout; append it to the system prompt so the model sees it this turn.
  const sessionStart = await runHooks(
    settings.hooks,
    { event: "SessionStart", cwd },
    opts.signal,
  );
  if (sessionStart.output) {
    system += "\n\n## Session context (from SessionStart hooks)\n" + sessionStart.output;
  }

  const messages: ModelMessage[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.prompt },
  ];

  // Connect external MCP servers declared in settings.json and materialize their
  // tools alongside the local ones. Skipped in read-only mode (MCP tools may
  // mutate) and when none are configured. Per-server failures are isolated; the
  // clients are closed in the finally below.
  const hasServers =
    !opts.readOnly && Object.keys(settings.mcpServers ?? {}).length > 0;
  const mcp = hasServers
    ? await loadMcpTools(settings, { onStatus: opts.onMcpServer })
    : null;

  // Gate every tool with the settings-driven permission rules and Pre/PostToolUse
  // hooks. A denied call or a blocking hook returns a string the model reads.
  const tools = wrapToolsWithGate(
    { ...buildTools(cwd, { readOnly: opts.readOnly }), ...(mcp?.tools ?? {}) },
    {
      cwd,
      permissions: settings.permissions,
      hooks: settings.hooks,
      signal: opts.signal,
      onBlocked: opts.onToolBlocked,
    },
  );

  try {
  // Capture the underlying stream error ourselves. Supplying onError replaces
  // the AI SDK default (which dumps the whole error object to the console), so
  // gateway failures surface as one clean, actionable line instead of a wall of
  // internal fields.
  let streamError: unknown = null;
  const result = streamText({
    model: resolveModelId(opts.model),
    system,
    messages,
    tools,
    stopWhen: stepCountIs(opts.maxSteps ?? 32),
    abortSignal: opts.signal,
    onError: ({ error }) => {
      streamError = error;
    },
    onStepFinish: ({ toolCalls }) => {
      for (const tc of toolCalls ?? []) {
        const call = tc as { toolName: string; input?: unknown; args?: unknown };
        const input = call.input ?? call.args;
        opts.onToolCall?.(call.toolName, input);
        void opts.memory?.remember("tool_call", {
          tool: call.toolName,
          input,
        });
      }
    },
  });

  let text = "";
  try {
    for await (const delta of result.textStream) {
      text += delta;
      opts.onText?.(delta);
    }
  } catch (err) {
    streamError ??= err;
  }

  if (streamError) throw normalizeAgentError(streamError);

  const steps = (await result.steps).length;
  const usage = await result.usage;
  const response = await result.response;

  void opts.memory?.remember("assistant_reply", text.slice(0, 500), "success");

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
  } finally {
    // Always disconnect MCP servers, even if the turn threw.
    await mcp?.close();
  }
}
