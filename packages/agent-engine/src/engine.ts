import { stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { buildWorkspaceTools } from "./tools";
import { wrapToolsWithSpeculation } from "./speculate/index";
import { buildCodingCorePrompt } from "./prompt/system-prompt";
import type {
  RunCodingAgentOptions,
  RunCodingAgentResult,
  TurnStopReason,
} from "./types";
import {
  backoffMs,
  compactMessages,
  contextWindowFor,
  delay,
  estimateMessageTokens,
  isContextOverflowError,
  isMutatingTool,
  isRetryableModelError,
  LOOP_NUDGE_THRESHOLD,
  SUCCESSFUL_REPEAT_THRESHOLD,
  loopNudgeMessage,
  midFlightRetryMessage,
  StreamStallError,
  successfulRepeatNudgeMessage,
  toolCallSignature,
  withSlowWaitBreadcrumb,
} from "./loop-driver";

/** Default stream-inactivity watchdog (ms) — see `RunCodingAgentOptions.streamStallMs`. */
const DEFAULT_STREAM_STALL_MS = 180_000;
/** Threshold (ms) past which an interactive budget-approval wait emits a breadcrumb. */
const BUDGET_WAIT_BREADCRUMB_MS = 60_000;

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

/**
 * Default cap on tool-using steps per turn — a runaway backstop for the agentic
 * loop, NOT a functional limit. A turn ends naturally the moment the model
 * returns a step with no tool call (its final answer); this cap only fires if
 * the model loops on tools without ever settling, bounding billed LLM calls
 * (one per step) before a stuck loop burns unbounded credits. Exported as the
 * single source of truth so every surface (REST chat, A2A bridge, app chat)
 * shares one value instead of hardcoding a literal that can silently drift.
 */
export const DEFAULT_MAX_AGENT_STEPS = 256;

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

/** Outcome of a single stall-guarded `iterator.next()`: a part, stream end, or a stall. */
type StallableRead<T> =
  | { kind: "part"; value: T }
  | { kind: "done" }
  | { kind: "stall" };

/**
 * Await one `iterator.next()`, but if it hasn't settled within `stallMs`, resolve
 * as a `stall` instead of hanging — UNLESS `shouldDefer()` says the silence is
 * expected, in which case the watchdog re-arms and keeps waiting.
 *
 * The critical caller-side reason for `shouldDefer`: tool execution BLOCKS
 * `fullStream`. The SDK emits the `tool-call` part, then this very `next()` stays
 * pending for the WHOLE tool run (a `bash` build/test can legitimately run for
 * minutes — its own per-tool timeout governs it), then the `tool-result` arrives.
 * Without a defer probe the watchdog would false-fire on every long tool call,
 * abort it, and re-run the same slow command until the turn failed. So the engine
 * passes `() => pendingToolCalls > 0`: quiet-while-a-tool-runs is deferred; only
 * quiet-with-no-tool-in-flight (a genuinely dead model stream) trips the stall.
 * Mirrors the CLI's `makeStallDetector` `shouldDefer` escape hatch
 * (apps/cli/src/agent/timeouts.ts).
 *
 * The pending read is NOT consumed on a stall — the caller tears the stream down
 * (by aborting its step signal) and abandons it; we attach a catch to the
 * abandoned read so its eventual (post-abort) rejection is never an unhandled
 * rejection. Every armed timer is cleared as soon as its race settles (including
 * on each re-arm), so nothing leaks. `stallMs <= 0` / non-finite disables the
 * watchdog (a plain awaited read).
 */
async function readPartWithStall<T>(
  next: Promise<IteratorResult<T>>,
  stallMs: number,
  shouldDefer?: () => boolean,
): Promise<StallableRead<T>> {
  const mapped = next.then<StallableRead<T>>((r) =>
    r.done ? { kind: "done" } : { kind: "part", value: r.value },
  );
  if (!(Number.isFinite(stallMs) && stallMs > 0)) return mapped;

  // If a stall ends the wait, `mapped` is abandoned; swallow its later rejection
  // (the aborted read rejects) so it is not an unhandled rejection.
  mapped.catch(() => undefined);

  // Re-arm loop: arm a fresh watchdog each pass and race it against the SAME
  // pending read. A real part/done wins → return it. The timer wins → consult
  // `shouldDefer`: true means expected silence (a tool is executing) so re-arm;
  // false means a dead stream so report the stall.
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stall = new Promise<"stall">((resolve) => {
      timer = setTimeout(() => resolve("stall"), stallMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    let outcome: StallableRead<T> | "stall";
    try {
      outcome = await Promise.race([mapped, stall]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (outcome !== "stall") return outcome;
    if (shouldDefer?.()) continue; // expected silence — a tool is running
    return { kind: "stall" };
  }
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
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_AGENT_STEPS;
  const contextWindow = opts.contextWindow ?? contextWindowFor(model);
  const compactionThreshold = opts.compactionThreshold ?? 0.8;
  const maxRetries = opts.maxRetries ?? 4;
  const maxOverflowRetries = opts.maxOverflowRetries ?? 2;
  const streamStallMs = opts.streamStallMs ?? DEFAULT_STREAM_STALL_MS;

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
  // Set when the turn ends for a reason other than the model finishing — a
  // per-turn budget stop or step-cap exhaustion — surfaced on the result so a
  // caller can tell the user WHY the turn cut off.
  let stopReason: TurnStopReason | undefined;

  while (steps < maxSteps) {
    if (opts.signal?.aborted) break;
    // A nudge queued by the previous step's repeated failure — inject it as the
    // next instruction so the model changes tack.
    let pendingNudge: string | null = null;
    // Per-attempt start times by toolCallId, so tool-result events carry REAL
    // per-tool durations. Scoped to the attempt (not the turn) so a step that
    // fails between a tool-call and its tool-result leaves NO stale entry to
    // skew a later step's duration on retry — the map is simply discarded with
    // the failed attempt.
    const toolStartedAt = new Map<string, number>();
    // Mutating tools this attempt has begun executing (bash/write_file/edit_file).
    // If the attempt then fails mid-stream, a blind retry would re-run them and
    // double-apply side effects — so the catch injects a corrective message and
    // advances instead. Populated at tool-call time (execution is imminent), the
    // earliest safe point to know a side effect may land.
    const attemptMutatingTools = new Set<string>();
    // Tools currently executing in this stream. Tool execution BLOCKS the
    // fullStream read (tool-call → [tool runs] → tool-result), so the stall
    // watchdog must DEFER while this is > 0 — a quiet stream during a legit
    // multi-minute bash is not a dead stream (the tool has its own timeout). A
    // counter (not a boolean) so parallel tool calls all have to settle before
    // the watchdog re-engages.
    let pendingToolCalls = 0;

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
      // Per-step abort surface: compose the caller's turn signal with a private
      // controller the stall watchdog can trip. A stall aborts ONLY this step's
      // stream (via `stepAbort`), so the step re-runs; a genuine user abort flows
      // through `opts.signal` and ends the turn. Composing (not replacing) means
      // the catch still sees `opts.signal.aborted` for a user cancel and never
      // misclassifies it as a stall.
      const stepAbort = new AbortController();
      const abortSignal = opts.signal
        ? AbortSignal.any([opts.signal, stepAbort.signal])
        : stepAbort.signal;
      const result = opts.ai.stream({
        model,
        system,
        messages: conversation,
        tools,
        effort: opts.effort,
        stopWhen: stepCountIs(1),
        abortSignal,
        onError: ({ error }) => {
          streamError = error;
        },
      });

      // Manual iteration (not `for await`) so each read can race a stall
      // watchdog: if no part arrives for `streamStallMs`, the step's stream is
      // torn down and a retryable StreamStallError is raised.
      const iterator = result.fullStream[Symbol.asyncIterator]();
      for (;;) {
        const read = await readPartWithStall(
          iterator.next(),
          streamStallMs,
          // Defer the watchdog while any tool is executing — its silence is
          // expected, not a dead stream (see readPartWithStall).
          () => pendingToolCalls > 0,
        );
        if (read.kind === "done") break;
        if (read.kind === "stall") {
          stepAbort.abort(new StreamStallError(streamStallMs));
          throw new StreamStallError(streamStallMs);
        }
        const part = read.value;
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
          // A tool is now executing — the next fullStream read will block for its
          // whole run, so tell the watchdog to defer until it settles.
          pendingToolCalls++;
          // Record a mutating tool the MOMENT the model commits the call —
          // execution is imminent, so if the stream dies right after, the catch
          // must know a side effect may have landed (see the mid-flight guard).
          if (isMutatingTool(part.toolName))
            attemptMutatingTools.add(part.toolName);
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
            // The tool finished — re-engage the watchdog once no tool is in
            // flight. Floored at 0 so a stray/duplicate result can't drive it
            // negative and wedge the defer probe below zero.
            pendingToolCalls = Math.max(0, pendingToolCalls - 1);
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
          // The tool settled (with an error) — re-engage the watchdog once no
          // tool is in flight. Floored at 0, same as the success path.
          pendingToolCalls = Math.max(0, pendingToolCalls - 1);
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
        const guard = opts.budgetGuard;
        // The guard MAY block indefinitely in "prompt" mode (waiting on a human
        // to approve raising the ceiling). We never auto-deny — the human's
        // decision is the only thing that ends the wait — but we DO make a long
        // wait observable: a breadcrumb through `onError` after 60s so a stuck
        // approval isn't silent. Timer cleared the moment the guard resolves.
        const verdict = await withSlowWaitBreadcrumb(
          () =>
            guard({
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
              cachedInputTokens: usage.cachedInputTokens,
            }),
          BUDGET_WAIT_BREADCRUMB_MS,
          () =>
            opts.onError?.({
              phase: "budget-wait-slow",
              error: new Error(
                `Budget approval has been pending for over ${Math.round(
                  BUDGET_WAIT_BREADCRUMB_MS / 1000,
                )}s.`,
              ),
            }),
        );
        if (verdict === "stop") {
          stopReason = "budget";
          break;
        }
      }

      // `tool-calls` means the model wants to act again — keep looping. Any other
      // finish reason (stop / length / content-filter / error) ends the turn.
      if (finishReason !== "tool-calls") break;

      // The model wants another step, but we've reached the step cap: the while
      // condition will now end the loop. That is EXHAUSTION, not a finish — mark
      // it so the caller can tell "ran out of steps" apart from a clean stop.
      // (A budget stop `break`s above with its own reason and never reaches here.)
      if (steps >= maxSteps) {
        stopReason = "max-steps";
        break;
      }

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

      // A retryable error AFTER this attempt already began a MUTATING tool
      // (bash/write_file/edit_file): the tools ran DURING the stream, so a blind
      // retry would re-execute them and double-apply side effects. Do NOT re-run
      // the step — inject a corrective message so the model re-inspects state,
      // and ADVANCE. Bounded by the same retry budget so a step that always
      // mutates-then-fails can't spin. Read-only steps fall through to the plain
      // retry below (re-running them is safe and cheaper than losing the turn).
      if (
        isRetryableModelError(err) &&
        attemptMutatingTools.size > 0 &&
        retriesUsed < maxRetries
      ) {
        retriesUsed++;
        conversation = [
          ...conversation,
          {
            role: "user",
            content: midFlightRetryMessage([...attemptMutatingTools]),
          },
        ];
        continue;
      }

      // Transient 429/5xx/network/stream error on a read-only (or budget-exhausted
      // mutating) step: back off and retry the SAME step (nothing was committed),
      // up to the per-turn budget.
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

  // Both are best-effort side effects that must NEVER fail the turn — but a
  // failure is no longer swallowed blind: it is routed to `onError` so a
  // consumer can log/telemeter it (a platform-wide memory/trace outage should be
  // visible, not silent). The turn still completes regardless.
  if (opts.memory)
    void Promise.resolve(
      opts.memory.remember("coding_turn", {
        instruction: opts.instruction,
        changedFiles,
      }),
    ).catch((error: unknown) =>
      opts.onError?.({ phase: "memory-remember", error }),
    );
  if (opts.trace)
    void Promise.resolve(
      opts.trace.record({
        instruction: opts.instruction,
        changedFiles,
        steps,
        text,
        usage,
      }),
    ).catch((error: unknown) =>
      opts.onError?.({ phase: "trace-record", error }),
    );

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
