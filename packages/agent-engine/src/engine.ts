import { stepCountIs, type ModelMessage } from "ai";
import { buildWorkspaceTools } from "./tools";
import type { RunCodingAgentOptions, RunCodingAgentResult } from "./types";

const DEFAULT_SYSTEM =
  "You are an expert software engineer working in a checked-out repository. " +
  "Use the provided tools to read, search, and edit files and run commands. " +
  "Make the smallest correct change that satisfies the request, run the repo's " +
  "tests or build when relevant, and stop when the task is complete.";

/** Parse `git diff` output for the set of changed file paths (`+++ b/<path>` headers). */
export function changedFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    const path = /^\+\+\+ b\/(.+)$/.exec(line)?.[1];
    if (path && path !== "/dev/null") files.add(path);
  }
  return [...files].sort();
}

/** Heuristic: did a tool result represent an error? Sets `ToolEvent.ok`. Exported for tests. */
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

/**
 * The coding loop. Runs a tool-using model turn against a `Workspace` until the
 * model stops or the step cap is hit, then returns the resulting diff + summary.
 *
 * The model call goes through the injected `AgentAi` port — never `streamText`
 * directly — so the same loop meters correctly on the platform and stays
 * BYOK/unmetered in the CLI (ADR-019).
 */
export async function runCodingAgent(opts: RunCodingAgentOptions): Promise<RunCodingAgentResult> {
  const onEvent = opts.onEvent ?? (() => undefined);
  const tools = buildWorkspaceTools(opts.workspace, {
    readOnly: opts.readOnly,
    codeGraph: opts.codeGraph,
    codeMap: opts.codeMap,
    onEvent,
  });

  const recalled = opts.memory ? await opts.memory.recallContext().catch(() => "") : "";

  // Keep `system` STABLE across turns so Anthropic prompt caching keeps its
  // ephemeral breakpoint (set on the system block in @oxagen/ai's streamAgentReply)
  // warm — a warm prefix re-bills at ~1/10th the input price. Recalled memory
  // changes every turn, so folding it into `system` (as this used to) busted the
  // cached prefix on every single turn. Instead it rides as a volatile user
  // message placed right before the instruction: the model still sees it, but it
  // sits AFTER the cached system block, and it is a `user` (not `system`) message
  // so the platform's /v1/agent/llm route does not hoist it back into the cached
  // system string.
  const system = opts.system ?? DEFAULT_SYSTEM;
  const messages: ModelMessage[] = [
    ...(opts.history ?? []),
    ...(recalled
      ? [
          {
            role: "user",
            content: "## Recalled context (from prior sessions)\n" + recalled,
          } as ModelMessage,
        ]
      : []),
    { role: "user", content: opts.instruction },
  ];

  let streamError: unknown = null;
  // Per-step timing: the tools in a step ran between the previous step's finish
  // and this one's. Gives each tool event a real (if step-granular) duration.
  let prevStepAt = Date.now();
  const result = opts.ai.stream({
    model: opts.model ?? "anthropic/claude-opus-4-8",
    system,
    messages,
    tools,
    effort: opts.effort,
    stopWhen: stepCountIs(opts.maxSteps ?? 32),
    abortSignal: opts.signal,
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
        const call = tc as {
          toolCallId?: string;
          toolName: string;
          input?: unknown;
          args?: unknown;
        };
        const input = call.input ?? call.args;
        onEvent({ type: "tool-call", name: call.toolName, input });
        const out = call.toolCallId ? resultsById.get(call.toolCallId) : undefined;
        onEvent({
          type: "tool-result",
          name: call.toolName,
          input: stringifyCapped(input, 1000),
          result: stringifyCapped(out, 2000),
          durationMs: now - prevStepAt,
          ok: !isErrorResult(out),
        });
      }
      prevStepAt = now;
    },
  });

  let text = "";
  try {
    // Consume the FULL stream (not just textStream) so the model's reasoning /
    // chain-of-thought is surfaced alongside its answer — the CLI renders it dim
    // and inline so the user sees everything the agent is thinking, not only the
    // final prose. `text-delta` carries answer text; `reasoning-delta` carries
    // the thinking trace. Both parts expose their content on `.text` in ai@6.
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        text += part.text;
        onEvent({ type: "text", delta: part.text });
      } else if (part.type === "reasoning-delta") {
        onEvent({ type: "reasoning", delta: part.text });
      }
    }
  } catch (err) {
    streamError ??= err;
  }
  if (streamError) throw streamError instanceof Error ? streamError : new Error(String(streamError));

  // A user cancel (Esc/Ctrl-C) or timeout aborts the signal, but some transports
  // end the stream cleanly instead of throwing an AbortError. Detect that here
  // and throw, so callers (the pipeline's judge/revise loop, the bare path, the
  // named-agent loop) stop IMMEDIATELY on abort rather than spending another
  // model call summarizing/judging a turn the user already stopped.
  if (opts.signal?.aborted) {
    // `AbortSignal.reason` is typed `any` in lib.dom; funnel it through an
    // explicit `unknown` local so downstream narrowing stays type-safe.
    const reason: unknown = opts.signal.reason;
    throw reason instanceof Error
      ? reason
      : new DOMException("The agent turn was aborted.", "AbortError");
  }

  const steps = (await result.steps).length;
  const usage = await result.usage;
  const response = await result.response;

  const diff = await opts.workspace.diff();
  const changedFiles = changedFilesFromDiff(diff);
  onEvent({ type: "final-diff", diff, changedFiles });

  if (opts.memory)
    void Promise.resolve(
      opts.memory.remember("coding_turn", { instruction: opts.instruction, changedFiles }),
    ).catch(() => {});
  if (opts.trace)
    void Promise.resolve(
      opts.trace.record({ instruction: opts.instruction, changedFiles, steps, text, usage }),
    ).catch(() => {});

  return {
    text,
    steps,
    diff,
    changedFiles,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cachedInputTokens: (usage as { cachedInputTokens?: number }).cachedInputTokens,
    },
    messages: [...messages, ...response.messages],
  };
}
