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
import { filterToolsForAgent } from "../agents/tools.js";
import { loadRules, renderRulesSection, guardsToDeny } from "../rules/index.js";
import {
  AgentTimeoutError,
  TIMEOUTS,
  makeTurnController,
  makeStallDetector,
  wrapToolsWithTimeout,
} from "./timeouts.js";
import type { Rule } from "../rules/types.js";
import type { AgentDefinition } from "../agents/types.js";
import type { OxagenSettings } from "../settings/schema.js";
import type { ProjectContext } from "./project-context.js";
import type { SessionMemory } from "./memory.js";
import type { ToolEvent } from "./trace.js";
import type { PermissionBroker } from "./permissions.js";

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
  /** Permission broker gating mutating tools (absent ⇒ ungated). */
  broker?: PermissionBroker;
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
  /**
   * Workspace rules for this turn. Injected into the system prompt (Tier 1) and
   * their guards hard-enforced at the tool gate (Tier 2). Defaults to the rules
   * loaded from `cwd`; injectable for tests.
   */
  rules?: Rule[];
  /**
   * Run this turn as a named agent: its system prompt replaces the default
   * identity, its tool allowlist restricts the available tools, and its model
   * is used unless `model` overrides it.
   */
  agent?: AgentDefinition;
  /** Fired once per tool with its input, result, and timing (for verbose telemetry). */
  onToolEvent?: (e: ToolEvent) => void;
}

export interface RunAgentResult {
  text: string;
  steps: number;
  /** Full message history including this turn's assistant/tool messages. */
  messages: ModelMessage[];
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/** Heuristic: did a tool result represent an error? Exported for tests. */
export function isErrorResult(out: unknown): boolean {
  if (out instanceof Error) return true;
  if (out && typeof out === "object") {
    const o = out as { isError?: unknown; error?: unknown };
    if (o.isError === true || (o.error != null && o.error !== false)) return true;
  }
  return false;
}

/** JSON-stringify a value, falling back to String(), capped to `max` chars. Exported for tests. */
export function stringifyCapped(v: unknown, max: number): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
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
  // Our own timeout errors: pass through as-is — the message is already
  // user-facing ("⏱ Agent step timed out after…").
  if (error instanceof AgentTimeoutError) return error;

  // AbortError from the AI SDK when a signal fires without a typed reason
  // (e.g. user pressed Esc without going through the timeout path).
  if (error instanceof Error && error.name === "AbortError") {
    // The signal's reason may already be a typed AgentTimeoutError.
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof AgentTimeoutError) return cause;
    return new Error("Agent turn was cancelled.");
  }

  // Undefined reason from signal.abort() with no argument.
  if (error == null) {
    return new Error("Agent turn was cancelled.");
  }

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

  // Create a single AbortController for the entire turn. It fires as soon as
  // EITHER the caller's signal fires (Esc / Ctrl-C) OR the per-turn deadline
  // (TIMEOUTS.turnMs) elapses — whichever comes first. Every sub-operation
  // (LLM call, tool executes, hook runners) receives this signal so they all
  // cancel together with no dangling work.
  const turnController = makeTurnController(opts.signal);
  const turnSignal = turnController.signal;

  // settings.json drives this turn's tool permissions and lifecycle hooks.
  const settings = opts.settings ?? loadSettings({ cwd }).settings;

  // Workspace rules: injected into the prompt (Tier 1) + hard-gated (Tier 2).
  const rules = opts.rules ?? loadRules({ cwd });

  // Recall relevant project memory and write the incoming prompt (best-effort).
  const recalled = opts.memory ? await opts.memory.recallContext() : "";
  void opts.memory?.remember("user_prompt", opts.prompt);

  let system = buildSystemPrompt({
    cwd,
    projectContext: opts.projectContext,
    readOnly: opts.readOnly,
    agent: opts.agent
      ? { name: opts.agent.name, systemPrompt: opts.agent.systemPrompt }
      : undefined,
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
    turnSignal,
  );
  if (sessionStart.output) {
    system += "\n\n## Session context (from SessionStart hooks)\n" + sessionStart.output;
  }

  // Tier 1 adherence: tell the model about the workspace rules it must follow.
  system += renderRulesSection(rules);

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

  // Merge local + MCP tools, restrict to the agent's allowlist (if any), then
  // gate with the settings-driven permission rules and Pre/PostToolUse hooks.
  const availableTools = filterToolsForAgent(
    { ...buildTools(cwd, { readOnly: opts.readOnly, broker: opts.broker }), ...(mcp?.tools ?? {}) },
    opts.agent?.tools,
  );
  // Tier 2 adherence: guarded rules become permission deny entries the gate
  // enforces before a tool runs; the deny→reason map returns the rule text.
  const ruleDenies = guardsToDeny(rules);
  const gatePermissions = ruleDenies.deny.length
    ? {
        ...settings.permissions,
        deny: [...(settings.permissions?.deny ?? []), ...ruleDenies.deny],
      }
    : settings.permissions;
  // Layer 1: permission gate + Pre/PostToolUse hooks.
  // Layer 2: per-tool timeouts (standard: 60s, bash: 240s) so no single tool
  // call can block the turn indefinitely. Tool timeouts return a string result
  // the model reads — the turn stays alive for the model to explain or adapt.
  const gatedTools = wrapToolsWithGate(availableTools, {
    cwd,
    permissions: gatePermissions,
    hooks: settings.hooks,
    signal: turnSignal,
    onBlocked: opts.onToolBlocked,
    denyReasons: ruleDenies.reasons,
  });
  const tools = wrapToolsWithTimeout(gatedTools, turnSignal);

  try {
  // Capture the underlying stream error ourselves. Supplying onError replaces
  // the AI SDK default (which dumps the whole error object to the console), so
  // gateway failures surface as one clean, actionable line instead of a wall of
  // internal fields.
  let streamError: unknown = null;
  // Per-step timing: the tools in a step ran between the previous step's finish
  // and this one's. Gives each tool event a real (if step-granular) duration.
  let prevStepAt = Date.now();
  const result = streamText({
    model: resolveModelId(opts.model ?? opts.agent?.model),
    system,
    messages,
    tools,
    stopWhen: stepCountIs(opts.maxSteps ?? 32),
    // Pass the turn signal so the AI SDK aborts the in-flight HTTP request when
    // the turn deadline fires or the user presses Esc.
    abortSignal: turnSignal,
    onError: ({ error }) => {
      streamError = error;
    },
    onStepFinish: ({ toolCalls, toolResults }) => {
      const now = Date.now();
      // Index results by call id so each call is paired with what it returned.
      const resultsById = new Map<string, unknown>();
      for (const tr of toolResults ?? []) {
        const r = tr as { toolCallId?: string; output?: unknown; result?: unknown; error?: unknown };
        if (r.toolCallId) resultsById.set(r.toolCallId, r.error ?? r.output ?? r.result);
      }
      for (const tc of toolCalls ?? []) {
        const call = tc as { toolCallId?: string; toolName: string; input?: unknown; args?: unknown };
        const input = call.input ?? call.args;
        opts.onToolCall?.(call.toolName, input);
        void opts.memory?.remember("tool_call", { tool: call.toolName, input });

        if (opts.onToolEvent) {
          const out = call.toolCallId ? resultsById.get(call.toolCallId) : undefined;
          const ok = !isErrorResult(out);
          opts.onToolEvent({
            name: call.toolName,
            input: stringifyCapped(input, 1000),
            result: out === undefined ? undefined : stringifyCapped(out, 2000),
            startedAt: prevStepAt,
            finishedAt: now,
            durationMs: now - prevStepAt,
            ok,
          });
        }
      }
      prevStepAt = now;
    },
  });

  let text = "";
  // Stall detector: if no text delta or streaming progress arrives within
  // TIMEOUTS.llmStallMs, abort the turn. This catches a stalled TCP connection
  // that keeps the socket open but stops delivering bytes — without this, such
  // a connection could hang the turn for minutes. The detector is reset on each
  // delta and stopped when the stream ends (success or error).
  const stall = makeStallDetector(TIMEOUTS.llmStallMs, () => {
    if (!turnController.signal.aborted) {
      turnController.abort(
        new AgentTimeoutError("LLM stream stall", TIMEOUTS.llmStallMs),
      );
    }
  });
  try {
    for await (const delta of result.textStream) {
      stall.reset(); // each delta resets the stall window
      text += delta;
      opts.onText?.(delta);
    }
  } catch (err) {
    streamError ??= err;
  } finally {
    stall.stop(); // always clear the stall timer
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
