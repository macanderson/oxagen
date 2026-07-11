import { stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { buildWorkspaceTools } from "./tools";
import { wrapToolsWithSpeculation } from "./speculate/index";
import { buildCodingCorePrompt } from "./prompt/system-prompt";
import type { RunCodingAgentOptions, RunCodingAgentResult } from "./types";
import {
  backoffMs,
  compactMessages,
  contextWindowFor,
  delay,
  estimateMessageTokens,
  isContextOverflowError,
  isRetryableModelError,
  LOOP_NUDGE_THRESHOLD,
  SUCCESSFUL_REPEAT_THRESHOLD,
  loopNudgeMessage,
  successfulRepeatNudgeMessage,
  toolCallSignature,
} from "./loop-driver";

// The workspace-less chat default. Built from the shared coding core
// (buildCodingCorePrompt) so its wording is a single source of truth the CLI and
// app can converge onto (ADR-021 §7). With no adapters this renders BYTE-FOR-BYTE
// the historical string, keeping the cache prefix stable (§2).
const DEFAULT_SYSTEM = buildCodingCorePrompt();

/**
 * The coding loop's own default model, applied when a caller passes no
 * `model` at all (as opposed to routing through a tier — see
 * `router/model-router.ts`'s `modelForTier`, a separate concept). Exported so
 * a caller that needs to know/label what this default resolves to (e.g. the
 * pipeline's bare-mode accounting in `pipeline/index.ts`) uses this SAME
 * constant instead of a second hardcoded literal that can drift out of sync.
 */
export const DEFAULT_AGENT_MODEL = "anthropic/claude-fable-5";

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
    if (o.isError === true) return true;
    // An `error` field flags failure — EXCEPT an empty/whitespace-only string,
    // which is a "no error" sentinel some tools emit (`{ ok, error: "" }`).
    // Treating `error: ""` as a failure fired a bogus loop-nudge on successful
    // calls; an empty error string is success.
    if (o.error != null && o.error !== false) {
      if (typeof o.error === "string" && o.error.trim() === "") return false;
      return true;
    }
  }
  return false;
}

/** JSON-stringify a value, falling back to String(), capped to `max` chars. Exported for tests. */
export function stringifyCapped(v: unknown, max: number): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
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
export async function runCodingAgent(
  opts: RunCodingAgentOptions,
): Promise<RunCodingAgentResult> {
  const onEvent = opts.onEvent ?? (() => undefined);
  // Filesystem tools exist ONLY when a workspace is injected. A surface with no
  // repository (the in-app chat agent) starts with an empty tool set and relies
  // entirely on `extraTools` — it must never advertise `read_file`…`bash`.
  let tools: ToolSet = opts.workspace
    ? buildWorkspaceTools(opts.workspace, {
        readOnly: opts.readOnly,
        codeGraph: opts.codeGraph,
        onEvent,
        // Forward the turn signal so an aborted turn kills any in-flight bash subtree.
        signal: opts.signal,
        // Agent file locking (docs/specs/agent-file-locking/plan.md) — the
        // SINGLE wiring point: write_file/edit_file acquire before the real
        // write and release after, for every caller of runCodingAgent (chat,
        // CLI, agent.repo.edit fleet dispatch) alike. Undefined ⇒ unlocked
        // (the CLI's default).
        fileLock: opts.fileLock,
        lockContext: opts.lockContext,
        // Optional project-diagnostics provider — the edit-integrity gate unions
        // its before/after output with the built-in syntax check. Undefined ⇒
        // built-in check only (the CLI's default).
        diagnostics: opts.diagnostics,
        // Interactive clarification: register `ask_user` only when a surface
        // with a human supplied the callback (mirrors codeGraph gating).
        askUser: opts.askUser,
      })
    : ({} as ToolSet);
  // Merge caller-supplied extra tools (e.g. MCP), then apply the caller's final
  // wrapper (e.g. the CLI's permission-gate + hooks + per-tool-timeout). This is
  // what lets a SINGLE loop replace the old duplicate legacy loop: every entry
  // point injects its safety wiring here instead of maintaining a second engine.
  if (opts.extraTools) tools = { ...tools, ...opts.extraTools };
  // Speculative tool execution (ADR-030): prefetch likely next reads into a
  // per-turn cache. Wrapped AFTER extraTools so a mutating MCP tool also
  // invalidates the cache, and BEFORE wrapTools so the caller's permission
  // gate still sees every real call. Workspace-gated: no filesystem, nothing
  // to speculate. Default ON; option wins over the env kill switch.
  const speculativeEnabled =
    opts.speculativeTools ??
    (process.env["OXAGEN_SPECULATIVE_TOOLS"] !== "0" &&
      process.env["OXAGEN_SPECULATIVE_TOOLS"] !== "false");
  if (opts.workspace && speculativeEnabled) {
    tools = wrapToolsWithSpeculation(tools, {
      onStats: opts.onSpeculationStats,
    });
  }
  if (opts.wrapTools) tools = opts.wrapTools(tools);

  // A recall failure must NEVER kill the turn — but silently losing all recalled
  // memory (platform-wide, if the memory store is down) must be visible. Surface
  // it through the injected `onError` sink instead of swallowing it blind; the
  // turn still degrades gracefully to empty recalled context.
  let recalled = "";
  if (opts.memory) {
    try {
      recalled = await opts.memory.recallContext();
    } catch (error) {
      opts.onError?.({ phase: "memory-recall", error });
    }
  }

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
  // Pasted images (REPL Ctrl-V) and attached videos ride alongside the
  // instruction text as multimodal content parts — images as `image` parts,
  // videos as AI-SDK `file` parts (only ever passed for a video-capable model;
  // the caller downgrades to keyframe `images` otherwise). Text-only (the
  // common case, and every retry step after the first — see the pipeline)
  // keeps the plain-string content shape, unchanged from before these options
  // existed.
  const attachedImages = opts.images ?? [];
  const attachedVideos = opts.videos ?? [];
  const instructionMessage: ModelMessage =
    attachedImages.length > 0 || attachedVideos.length > 0
      ? {
          role: "user",
          content: [
            { type: "text", text: opts.instruction },
            ...attachedImages.map((img) => ({
              type: "image" as const,
              image: img.data,
              mediaType: img.mediaType,
            })),
            ...attachedVideos.map((vid) => ({
              type: "file" as const,
              data: vid.data,
              mediaType: vid.mediaType,
              ...(vid.filename ? { filename: vid.filename } : {}),
            })),
          ],
        }
      : { role: "user", content: opts.instruction };
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
    instructionMessage,
  ];

  const model = opts.model ?? DEFAULT_AGENT_MODEL;
  const maxSteps = opts.maxSteps ?? 256;
  const contextWindow = opts.contextWindow ?? contextWindowFor(model);
  const compactionThreshold = opts.compactionThreshold ?? 0.8;
  const maxRetries = opts.maxRetries ?? 4;
  const maxOverflowRetries = opts.maxOverflowRetries ?? 2;

  // The EXPLICIT STEP LOOP. Instead of one `streamText(stopWhen: stepCountIs(256))`
  // call — which loses the whole turn to a transient error and can only grow the
  // transcript until it overflows the context window — we drive one model call
  // per step (`stepCountIs(1)`: the SDK generates one assistant message, executes
  // its tool calls, then stops), accumulating messages ourselves. That gives us a
  // boundary at every step to (a) compact the transcript before it overflows and
  // (b) retry a transient failure by re-running the step, since nothing is
  // committed until the step fully succeeds. Same number of round-trips as the
  // SDK's internal multi-step loop; the prompt cache keeps each resend cheap.
  let conversation: ModelMessage[] = messages;
  let text = "";
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
  };
  let steps = 0;
  let retriesUsed = 0;
  let overflowRetries = 0;
  // Start times by toolCallId, so tool-result events carry REAL per-tool
  // durations, and are emitted as parts stream (tool-call the moment the model
  // commits, tool-result/tool-error when execution settles) — live progress for
  // the UI and for callers' inactivity guards, not step-granular after-the-fact.
  const toolStartedAt = new Map<string, number>();
  // Loop detection: count consecutive failures of the SAME tool call (by
  // signature). A success clears it; N identical failures inject a corrective
  // nudge so the model stops re-issuing a doomed call (a common way agents burn
  // the step budget on SWE-bench).
  const failingCounts = new Map<string, number>();
  const nudged = new Set<string>();
  // Successful-repeat detection: count consecutive SUCCESSFUL runs of the SAME
  // tool call. The smoke-run analysis showed the agent running identical test
  // commands 8+ times post-fix — each repeat costs ~60k tokens for zero gain.
  // After SUCCESSFUL_REPEAT_THRESHOLD identical successes, inject a nudge so the
  // model stops re-running the same command and either declares done or acts.
  const successCounts = new Map<string, number>();
  const successNudged = new Set<string>();
  // Set when the per-turn budget guard stops the turn — surfaced on the result
  // so a caller can tell the user the turn cut off on its dollar ceiling.
  let stopReason: "budget" | undefined;

  while (steps < maxSteps) {
    if (opts.signal?.aborted) break;
    // A nudge queued by the previous step's repeated failure — inject it as the
    // next instruction so the model changes tack.
    let pendingNudge: string | null = null;

    // Compact BEFORE the call so the request itself fits. Keep the task + recent
    // working set verbatim; truncate the bulky content of older tool results.
    if (
      estimateMessageTokens(conversation) >
      contextWindow * compactionThreshold
    ) {
      conversation = compactMessages(conversation, {
        keepLastN: 8,
        contentCap: 2000,
      }).messages;
    }

    let streamError: unknown = null;
    let stepText = "";
    // Per-attempt emit buffer. Every side effect the stream produces — the raw
    // `onStreamPart` tap, the translated `CodingEvent`s, AND the loop-detection
    // counter mutations — is captured here as an ordered closure and flushed
    // ONLY after the step commits (past the streamError check below). A step
    // that fails mid-stream and gets retried therefore emits NOTHING on the
    // doomed attempt, so the retried attempt cannot replay a duplicated
    // transcript (text deltas, tool events) to the CLI/SSE consumer — there is
    // no retraction event in the wire protocol, so buffer-then-flush is the
    // correct fix. Steps almost always succeed on the first attempt, so this
    // adds a flush at the step boundary, not a per-token stall.
    const deferred: Array<() => void> = [];
    try {
      const result = opts.ai.stream({
        model,
        system,
        messages: conversation,
        tools,
        effort: opts.effort,
        stopWhen: stepCountIs(1),
        abortSignal: opts.signal,
        onError: ({ error }) => {
          streamError = error;
        },
      });

      for await (const part of result.fullStream) {
        // Raw part tap: forward EVERY part verbatim before the engine's own
        // subset translation below. The in-app SSE translator consumes this to
        // reproduce the client wire protocol byte-for-byte. Must not throw.
        // Buffered (not called inline) so a retried step does not replay it.
        deferred.push(() => opts.onStreamPart?.(part));
        if (part.type === "text-delta") {
          const delta = part.text;
          stepText += delta;
          deferred.push(() => onEvent({ type: "text", delta }));
        } else if (part.type === "reasoning-delta") {
          const delta = part.text;
          deferred.push(() => onEvent({ type: "reasoning", delta }));
        } else if (part.type === "tool-call") {
          toolStartedAt.set(part.toolCallId, Date.now());
          const toolName = part.toolName;
          const input: unknown = part.input;
          deferred.push(() =>
            onEvent({ type: "tool-call", name: toolName, input }),
          );
        } else if (part.type === "tool-result") {
          // `preliminary` results (streamed partial output) are progress, not
          // completion — the final result for the same call follows.
          if (!part.preliminary) {
            const started = toolStartedAt.get(part.toolCallId);
            toolStartedAt.delete(part.toolCallId);
            const durationMs = started ? Date.now() - started : 0;
            const ok = !isErrorResult(part.output);
            const sig = toolCallSignature(part.toolName, part.input);
            const toolName = part.toolName;
            const input: unknown = part.input;
            const output: unknown = part.output;
            // Counter mutations + nudge decisions run at flush time (commit),
            // in stream order, so a discarded attempt never double-counts.
            deferred.push(() => {
              if (ok) {
                failingCounts.delete(sig); // progress — reset the failing loop counter
                // Successful-repeat detection: count identical successful calls.
                // Only applies to bash (the expensive repeated-test-run pattern);
                // read_file/code_graph repeats are cheap and sometimes intentional.
                if (toolName === "bash") {
                  const succCount = (successCounts.get(sig) ?? 0) + 1;
                  successCounts.set(sig, succCount);
                  if (
                    succCount >= SUCCESSFUL_REPEAT_THRESHOLD &&
                    !successNudged.has(sig)
                  ) {
                    pendingNudge = successfulRepeatNudgeMessage(
                      toolName,
                      succCount,
                    );
                    successNudged.add(sig);
                  }
                }
              } else {
                successCounts.delete(sig); // a failure resets the success counter
                const count = (failingCounts.get(sig) ?? 0) + 1;
                failingCounts.set(sig, count);
                if (count >= LOOP_NUDGE_THRESHOLD && !nudged.has(sig)) {
                  pendingNudge = loopNudgeMessage(
                    toolName,
                    count,
                    stringifyCapped(output, 400),
                  );
                  nudged.add(sig);
                }
              }
              onEvent({
                type: "tool-result",
                name: toolName,
                input: stringifyCapped(input, 1000),
                result: stringifyCapped(output, 2000),
                durationMs,
                ok,
              });
            });
          }
        } else if (part.type === "tool-error") {
          const started = toolStartedAt.get(part.toolCallId);
          toolStartedAt.delete(part.toolCallId);
          const durationMs = started ? Date.now() - started : 0;
          const sig = toolCallSignature(part.toolName, part.input);
          const toolName = part.toolName;
          const input: unknown = part.input;
          const error: unknown = part.error;
          deferred.push(() => {
            successCounts.delete(sig); // a tool-error resets the success counter
            const count = (failingCounts.get(sig) ?? 0) + 1;
            failingCounts.set(sig, count);
            if (count >= LOOP_NUDGE_THRESHOLD && !nudged.has(sig)) {
              pendingNudge = loopNudgeMessage(
                toolName,
                count,
                stringifyCapped(error, 400),
              );
              nudged.add(sig);
            }
            onEvent({
              type: "tool-result",
              name: toolName,
              input: stringifyCapped(input, 1000),
              result: stringifyCapped(error, 2000),
              durationMs,
              ok: false,
            });
          });
        }
      }

      if (streamError) {
        throw streamError instanceof Error
          ? streamError
          : new Error(String(streamError));
      }
      if (opts.signal?.aborted) break;

      const finishReason = await result.finishReason;
      const stepUsage = await result.usage;
      const response = await result.response;

      // Commit the step: nothing above this line mutated turn state, so a throw
      // before here leaves the step safely retryable. Flush the buffered emits
      // and counter updates now — exactly once, only for the attempt that stuck.
      for (const emit of deferred) emit();
      text += stepText;
      usage.inputTokens += stepUsage.inputTokens ?? 0;
      usage.outputTokens += stepUsage.outputTokens ?? 0;
      usage.totalTokens += stepUsage.totalTokens ?? 0;
      // AI SDK v7 nests cache reads under `inputTokenDetails`; our aggregate keeps
      // the flat `cachedInputTokens` field. Optional-chained: BYOK/mock streams may
      // omit the details object.
      usage.cachedInputTokens +=
        stepUsage.inputTokenDetails?.cacheReadTokens ?? 0;
      conversation = [...conversation, ...response.messages];
      steps += (await result.steps).length || 1;

      // Per-turn budget gate. The cumulative `usage` was just updated for this
      // step, so check the dollar ceiling at every step boundary — BEFORE the
      // next (billable) model call. The guard prices the usage and applies the
      // policy; a "prompt"-mode breach blocks for approval inside the guard and
      // resolves to continue/stop. "stop" ends the turn here with a `budget`
      // stopReason — the same graceful exit as a natural finish, so the diff,
      // memory, and trace below still run on the partial turn.
      if (opts.budgetGuard) {
        const verdict = await opts.budgetGuard({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cachedInputTokens: usage.cachedInputTokens,
        });
        if (verdict === "stop") {
          stopReason = "budget";
          break;
        }
      }

      // `tool-calls` means the model wants to act again — keep looping. Any other
      // finish reason (stop / length / content-filter / error) ends the turn.
      if (finishReason !== "tool-calls") break;

      // The model just repeated an identical failing call past the threshold —
      // inject a corrective instruction so the next step changes approach.
      if (pendingNudge) {
        conversation = [
          ...conversation,
          { role: "user", content: pendingNudge },
        ];
      }
    } catch (err) {
      // User cancel — never retry; fall through to the post-loop abort throw.
      if (opts.signal?.aborted) break;
      if (err instanceof Error && err.name === "AbortError") break;

      // Context overflow despite pre-call compaction: compact harder and retry
      // the step (bounded), rather than losing the turn.
      if (isContextOverflowError(err) && overflowRetries < maxOverflowRetries) {
        overflowRetries++;
        const before = estimateMessageTokens(conversation);
        conversation = compactMessages(conversation, {
          keepLastN: 4,
          contentCap: 800,
        }).messages;
        if (estimateMessageTokens(conversation) < before) continue;
        throw err; // couldn't shrink — give up rather than spin
      }

      // Transient 429/5xx/network/stream error: back off and retry the SAME step
      // (nothing was committed), up to the per-turn budget.
      if (isRetryableModelError(err) && retriesUsed < maxRetries) {
        retriesUsed++;
        try {
          await delay(backoffMs(retriesUsed), opts.signal);
        } catch {
          break; // aborted during backoff
        }
        if (opts.signal?.aborted) break;
        continue;
      }
      throw err;
    }
  }

  // A user cancel (Esc/Ctrl-C) or timeout aborts the signal, but some transports
  // end the stream cleanly instead of throwing an AbortError. Detect that here
  // and throw, so callers (the pipeline's judge/revise loop, the bare path, the
  // named-agent loop) stop IMMEDIATELY on abort rather than spending another
  // model call summarizing/judging a turn the user already stopped.
  if (opts.signal?.aborted) {
    // `AbortSignal.reason` is typed `any` in lib.dom; funnel it through an
    // explicit `unknown` local so downstream narrowing stays type-safe
    // (the intersection cast collapses to `any` and trips no-unsafe-assignment).
    const reason: unknown = opts.signal.reason;
    throw reason instanceof Error
      ? reason
      : new DOMException("The agent turn was aborted.", "AbortError");
  }

  // No workspace ⇒ no repository to diff. The chat surface takes this path: it
  // returns an empty diff / no changed files and emits no `final-diff` event.
  const diff = opts.workspace ? await opts.workspace.diff() : "";
  const changedFiles = opts.workspace ? changedFilesFromDiff(diff) : [];
  if (opts.workspace) onEvent({ type: "final-diff", diff, changedFiles });

  if (opts.memory)
    void Promise.resolve(
      opts.memory.remember("coding_turn", {
        instruction: opts.instruction,
        changedFiles,
      }),
    ).catch(() => {});
  if (opts.trace)
    void Promise.resolve(
      opts.trace.record({
        instruction: opts.instruction,
        changedFiles,
        steps,
        text,
        usage,
      }),
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
      cachedInputTokens: usage.cachedInputTokens,
    },
    // The final transcript is `conversation` — it started as `messages` and grew
    // (and may have been compacted) across steps, so it already includes every
    // assistant/tool message from this turn.
    messages: conversation,
    ...(stopReason ? { stopReason } : {}),
  };
}
