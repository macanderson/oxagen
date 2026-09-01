/**
 * Pure helpers for the explicit step-driver in {@link runCodingAgent}.
 *
 * The coding loop makes one model call per step (stopWhen stepCountIs(1)),
 * accumulating messages explicitly. Between steps it can compact the transcript
 * and retry a failed step — the logic for BOTH lives here, pure and testable,
 * so `engine.ts` stays a thin driver.
 *
 * Long SWE-bench trajectories (100–200 steps × 30k-char tool outputs) will
 * otherwise blow the context window; a transient 429/5xx mid-turn would
 * otherwise lose the whole turn. These helpers are the fix.
 */
import type { ModelMessage } from "ai";

// ── Loop detection ─────────────────────────────────────────────────────────────

/**
 * Stable signature for a tool call (name + normalized input), used to detect the
 * model repeating an identical FAILING call. A successful call clears its
 * signature; the same failing call N times triggers a corrective nudge. Exported
 * for tests.
 */
export function toolCallSignature(name: string, input: unknown): string {
  let inputKey: string;
  try {
    inputKey = JSON.stringify(input) ?? String(input);
  } catch {
    inputKey = String(input);
  }
  return `${name}::${inputKey}`;
}

/** Repeats of the SAME failing tool call before we nudge the model to change tack. */
export const LOOP_NUDGE_THRESHOLD = 3;

/**
 * Repeats of the SAME SUCCESSFUL bash/tool call before we nudge the model to
 * stop re-running it. The smoke-run analysis showed the agent running identical
 * test commands 8+ times after the fix was already confirmed — each redundant
 * run costs ~60k tokens. Three successful repeats is enough signal that the
 * result won't change; a fourth is waste.
 */
export const SUCCESSFUL_REPEAT_THRESHOLD = 3;

/**
 * The corrective message injected when the model repeats an identical failing
 * call `LOOP_NUDGE_THRESHOLD` times. Exported for tests.
 */
export function loopNudgeMessage(
  name: string,
  count: number,
  lastError: string,
): string {
  return (
    `You have called \`${name}\` with the same arguments ${count} times and it ` +
    `keeps failing: ${lastError.slice(0, 400)}. Stop repeating this exact call — ` +
    `it will not start working. Inspect the current state (re-read the file or run ` +
    `a diagnostic), then take a DIFFERENT approach.`
  );
}

/**
 * The corrective message injected when the model repeats an identical SUCCESSFUL
 * bash/tool call `SUCCESSFUL_REPEAT_THRESHOLD` times. The result will not change;
 * re-running it only burns tokens. Exported for tests.
 */
export function successfulRepeatNudgeMessage(
  name: string,
  count: number,
): string {
  return (
    `You have successfully run \`${name}\` with the same arguments ${count} times ` +
    `and received the same result each time. The result will not change — do not ` +
    `run this command again. If the task is complete, say so and stop. If work ` +
    `remains, take a DIFFERENT action.`
  );
}

// ── Mid-flight side-effect safety ────────────────────────────────────────────

/**
 * Tools that MUTATE the workspace when they execute — running them a second time
 * re-applies their side effects. These are the built-in `buildWorkspaceTools`
 * names (see tools.ts): `bash` (arbitrary shell), `write_file`, and `edit_file`.
 * A step that ran any of these and THEN failed mid-stream must NOT be blindly
 * retried (tools execute during `fullStream`, so a retry re-runs them); instead
 * the loop injects {@link midFlightRetryMessage} and advances so the model
 * re-assesses state. Exported for tests.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  "bash",
  "write_file",
  "edit_file",
  "delete_file",
]);

/** True when `name` is a workspace-mutating tool (see {@link MUTATING_TOOL_NAMES}). Exported for tests. */
export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOL_NAMES.has(name);
}

/**
 * The corrective message injected when a step FAILED mid-stream AFTER it had
 * already executed one or more mutating tools ({@link isMutatingTool}). We do
 * not re-run the step (that would double-apply the side effects); instead we
 * tell the model exactly what happened and continue, so its next step re-reads
 * the current state rather than assuming the failed step's plan still holds.
 * Exported for tests.
 */
export function midFlightRetryMessage(mutatingTools: string[]): string {
  const unique = [...new Set(mutatingTools)].sort();
  const list = unique.length > 0 ? unique.join(", ") : "a state-changing tool";
  return (
    `Your previous step failed part-way through the model stream AFTER it had ` +
    `already run ${list}, so those changes may have partially applied. The step ` +
    `was NOT retried, to avoid running those tools twice. Do not assume the step ` +
    `completed: re-inspect the current state (e.g. \`git diff\`, or re-read the ` +
    `files you were editing) before continuing, then proceed from what you find.`
  );
}

// ── Token estimation ─────────────────────────────────────────────────────────

/**
 * Flat token estimates for binary multimodal content parts. A base64 image or
 * video payload is a giant string whose *serialized length* is a meaningless
 * token proxy — one ~1 MB screenshot is ~1.3 M base64 chars ≈ 330 k "tokens" by
 * length/4, which would stampede compaction every single step. Worse, the
 * transcript compactor ({@link truncateContent}) cannot shrink an `image`/`file`
 * part, so that phantom overcount would never abate: the loop would truncate all
 * the *real* text around a static image forever. Instead we price each media
 * part at a flat per-asset constant near what vision models actually bill an
 * image/short clip at. ADR-021 §2 (context/KV-cache discipline). Exported for tests.
 */
export const IMAGE_PART_TOKENS = 1600;
export const FILE_PART_TOKENS = 2000;

/**
 * Per-message memo of {@link contentTokens}, keyed by the message object's
 * identity. The step loop calls {@link estimateMessageTokens} over the WHOLE
 * transcript every step (an O(n²) sweep over the turn), yet each message's
 * content is immutable once appended — compaction produces NEW message objects
 * (`{ ...msg, content }`) for anything it changes, so a cache keyed by object
 * identity is self-invalidating: a rewritten message misses (new key) and a
 * carried-over message hits. WeakMap so retired transcripts are GC'd, never a
 * leak. The estimate is a pure function of `content`, so a memo is exact.
 */
const messageTokenCache = new WeakMap<object, number>();

/**
 * Rough token estimate: ~4 chars per token over serialized content, except
 * binary media parts, which are counted at a flat per-asset constant (see
 * {@link IMAGE_PART_TOKENS}/{@link FILE_PART_TOKENS}). Deliberately a heuristic —
 * no tokenizer dependency, and it only needs to be good enough to decide WHEN to
 * compact (we compact well below the true window). Per-message results are memoed
 * by object identity (see {@link messageTokenCache}) so re-measuring an unchanged
 * transcript every step is O(changed), not O(total). Exported for tests.
 */
export function estimateMessageTokens(messages: ModelMessage[]): number {
  let tokens = 0;
  for (const m of messages) {
    // A message is always an object here; guard defensively so a malformed
    // entry can't wedge the cache lookup, and fall back to a direct measure.
    if (m && typeof m === "object") {
      const cached = messageTokenCache.get(m);
      if (cached !== undefined) {
        tokens += cached;
        continue;
      }
      const measured = contentTokens(m.content);
      messageTokenCache.set(m, measured);
      tokens += measured;
    } else {
      tokens += contentTokens((m as ModelMessage).content);
    }
  }
  return tokens;
}

/** Token estimate for a single message's content, media-part-aware. */
function contentTokens(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === "string") return Math.ceil(content.length / 4);
  if (Array.isArray(content)) {
    let tokens = 0;
    for (const part of content) {
      if (part && typeof part === "object") {
        const type = (part as Record<string, unknown>)["type"];
        // Image/video (AI-SDK `file`) parts carry a base64 payload — count them
        // flat, never by serialized length.
        if (type === "image") {
          tokens += IMAGE_PART_TOKENS;
          continue;
        }
        if (type === "file") {
          tokens += FILE_PART_TOKENS;
          continue;
        }
      }
      // Text / tool-call / tool-result and any other part: size by length/4.
      tokens += Math.ceil(serializedLength(part) / 4);
    }
    return tokens;
  }
  return Math.ceil(serializedLength(content) / 4);
}

/** Serialized character length of a value, falling back gracefully. */
function serializedLength(v: unknown): number {
  if (typeof v === "string") return v.length;
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return String(v).length;
  }
}

/**
 * Conservative context-window sizes (tokens) by gateway model prefix. Used only
 * to pick a compaction threshold; when unknown we assume a safe 128k. Exported
 * for tests.
 */
export function contextWindowFor(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("claude")) return 200_000;
  if (m.includes("gemini")) return 1_000_000;
  if (
    m.includes("gpt-4.1") ||
    m.includes("gpt-5") ||
    m.includes("o3") ||
    m.includes("o4")
  )
    return 400_000;
  if (m.includes("gpt-4o") || m.includes("gpt-4")) return 128_000;
  return 128_000;
}

// ── Compaction ────────────────────────────────────────────────────────────────

export interface CompactionOptions {
  /** Tail messages kept verbatim (the recent working set). */
  keepLastN: number;
  /** Max chars a compacted (old) message's content may keep. */
  contentCap: number;
}

const COMPACTION_MARKER =
  "\n… [older content elided to fit context — re-read the file/command if still needed]";

/**
 * Replacement for an EARLIER tool-result whose exact content recurs later in the
 * transcript. The later identical copy is kept full, so this earlier one carries
 * zero additional information — eliding it is lossless. Unlike
 * {@link COMPACTION_MARKER}, it does NOT tell the model to re-read (that would
 * re-inflate the very content we just proved is still present downstream).
 */
const DUP_ELISION_MARKER =
  "[duplicate tool output elided — identical content appears later in the conversation]";

/**
 * Minimum extracted content length (chars) for the content-identity dedup to
 * bother eliding an earlier duplicate. Small outputs (a `Wrote 12 bytes` ack, a
 * one-line grep hit) cost ~nothing to keep and their repetition is often
 * meaningful signal; only large repeated blobs (duplicate file reads, re-run
 * command dumps) are worth collapsing. ~500 chars ≈ 125 tokens.
 */
const DEDUP_MIN_CHARS = 500;

/**
 * Structurally compact a transcript in two passes:
 *
 *   1. Content-identity dedup — an EARLIER tool-result whose exact content
 *      recurs later (e.g. the same file read twice) is replaced by a one-line
 *      marker, keeping the LAST identical copy full. This is lossless (the
 *      content is still present downstream) and, unlike positional truncation,
 *      it reaches even into the protected tail — a duplicate is worth eliding
 *      wherever it sits. The first user message (the task) is never touched.
 *   2. Positional truncation — keep the first user message and the last
 *      `keepLastN` messages verbatim; clip the bulky content of everything in
 *      between (old tool results, large reads) to `contentCap`.
 *
 * Both passes are deterministic and free — no LLM summary call — which is
 * exactly what you want on the recovery path, and (critically) they only ever
 * run at a compaction moment so the prompt-cache prefix is invalidated once,
 * not incrementally. Returns a NEW array; never mutates the input. Exported for
 * tests.
 */
export function compactMessages(
  messages: ModelMessage[],
  opts: CompactionOptions,
): { messages: ModelMessage[]; compacted: boolean } {
  const n = messages.length;
  if (n <= opts.keepLastN + 1) return { messages, compacted: false };

  // Protect the first user message (the task) and the last keepLastN messages.
  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  const protectedFrom = n - opts.keepLastN;

  // Pass 1: dedup identical tool outputs (ignores keepLastN; spares first user).
  const dedup = dedupeToolOutputs(messages, firstUserIdx, DEDUP_MIN_CHARS);

  // Pass 2: positional truncation over the (possibly deduped) messages. A dedup
  // that already shrank a middle message below the cap simply leaves nothing for
  // truncation to do there; protected messages keep whatever pass 1 produced.
  let truncatedAny = false;
  const out = dedup.messages.map((msg, i) => {
    const isProtected = i === firstUserIdx || i >= protectedFrom;
    if (isProtected) return msg;
    const truncated = truncateContent(msg.content, opts.contentCap);
    if (truncated.changed) truncatedAny = true;
    return { ...msg, content: truncated.content } as ModelMessage;
  });

  return { messages: out, compacted: dedup.deduped > 0 || truncatedAny };
}

/**
 * Extract the plain-text payload of a tool-result `output`, across the shapes
 * ai@6 uses: a bare string, `{ type, value }`, or `{ type, text }`. Returns
 * `null` for any non-text output (e.g. a structured JSON blob with neither a
 * `value` nor `text` string). The single source of truth for "what text does
 * this tool output carry" — shared by dedup and {@link truncateToolOutput}.
 */
function toolResultText(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o["value"] === "string") return o["value"];
    if (typeof o["text"] === "string") return o["text"];
  }
  return null;
}

/**
 * Rebuild a tool-result `output` with `replacement` swapped in for its text
 * payload, preserving the original shape (bare string / `{ value }` / `{ text }`).
 * Inverse of {@link toolResultText}.
 */
function replaceToolResultText(output: unknown, replacement: string): unknown {
  if (typeof output === "string") return replacement;
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o["value"] === "string") return { ...o, value: replacement };
    if (typeof o["text"] === "string") return { ...o, text: replacement };
  }
  return output;
}

/**
 * Content-identity dedup: replace every EARLIER tool-result whose extracted text
 * (≥ `minChars`) exactly equals a LATER tool-result's text with
 * {@link DUP_ELISION_MARKER}, keeping the last identical copy full. Reaches into
 * the protected tail (a duplicate is lossless to elide anywhere) but never
 * touches the message at `firstUserIdx`. Returns a NEW array; never mutates the
 * input. `deduped` counts the tool-results elided.
 */
function dedupeToolOutputs(
  messages: ModelMessage[],
  firstUserIdx: number,
  minChars: number,
): { messages: ModelMessage[]; deduped: number } {
  // Pass A: record, for each qualifying extracted text, the LAST (message,part)
  // location it appears at. That location is the copy we keep full.
  const lastLocation = new Map<string, { mi: number; pi: number }>();
  messages.forEach((msg, mi) => {
    if (mi === firstUserIdx || !Array.isArray(msg.content)) return;
    msg.content.forEach((part: unknown, pi: number) => {
      if (!part || typeof part !== "object" || !("output" in part)) return;
      const text = toolResultText((part as Record<string, unknown>)["output"]);
      if (text != null && text.length >= minChars)
        lastLocation.set(text, { mi, pi });
    });
  });

  // Nothing recurs? Return the input untouched (identity preserved).
  let deduped = 0;
  const out = messages.map((msg, mi) => {
    if (mi === firstUserIdx || !Array.isArray(msg.content)) return msg;
    let changed = false;
    const parts = msg.content.map((part: unknown, pi: number) => {
      if (!part || typeof part !== "object" || !("output" in part)) return part;
      const p = part as Record<string, unknown>;
      const text = toolResultText(p["output"]);
      if (text == null || text.length < minChars) return part;
      const last = lastLocation.get(text)!;
      if (last.mi === mi && last.pi === pi) return part; // the kept copy
      changed = true;
      deduped++;
      return {
        ...p,
        output: replaceToolResultText(p["output"], DUP_ELISION_MARKER),
      };
    });
    return changed ? ({ ...msg, content: parts } as ModelMessage) : msg;
  });

  return { messages: out, deduped };
}

/** Truncate the textual payload of a message's content to `cap` chars. */
function truncateContent(
  content: unknown,
  cap: number,
): { content: unknown; changed: boolean } {
  if (typeof content === "string") {
    if (content.length <= cap) return { content, changed: false };
    return {
      content: content.slice(0, cap) + COMPACTION_MARKER,
      changed: true,
    };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const parts = content.map((part: unknown) => {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        // Assistant text part: { type: "text", text }
        if (
          typeof p["text"] === "string" &&
          (p["text"] as string).length > cap
        ) {
          changed = true;
          return {
            ...p,
            text: (p["text"] as string).slice(0, cap) + COMPACTION_MARKER,
          };
        }
        // Tool-result part: { type: "tool-result", output } — output may be a
        // string, or { type: "text"|"json", value } in ai@6.
        if ("output" in p) {
          const t = truncateToolOutput(p["output"], cap);
          if (t.changed) {
            changed = true;
            return { ...p, output: t.output };
          }
        }
      }
      return part;
    });
    return { content: parts, changed };
  }
  return { content, changed: false };
}

function truncateToolOutput(
  output: unknown,
  cap: number,
): { output: unknown; changed: boolean } {
  const text = toolResultText(output);
  if (text == null || text.length <= cap) return { output, changed: false };
  return {
    output: replaceToolResultText(
      output,
      text.slice(0, cap) + COMPACTION_MARKER,
    ),
    changed: true,
  };
}

// ── Error classification ───────────────────────────────────────────────────────

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
}

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: unknown; status?: unknown } | null;
  const s = (e?.statusCode ?? e?.status) as unknown;
  return typeof s === "number" ? s : undefined;
}

/**
 * Is this a fatal auth/billing error (no credits, bad key, unauthorized)? These
 * NEVER succeed on retry, and every other model call in the turn is doomed to
 * fail identically — so callers that would otherwise swallow an LLM error into
 * a "keep going" heuristic fallback (the evaluator, the completeness judge, the
 * best-of-N selector) must re-throw instead, failing the turn fast with the
 * real message rather than burning time on doomed calls before it resurfaces.
 * Exported for tests and for those fallback sites.
 */
export function isFatalAuthOrBillingError(err: unknown): boolean {
  const msg = errorText(err);
  return /insufficient_funds|positive credit balance|invalid.*api.?key|unauthorized|\b401\b|\b403\b/.test(
    msg,
  );
}

/**
 * Raised by the step-driver's stream-inactivity watchdog: the model stream went
 * quiet — no `fullStream` part for `stallMs` — without erroring or finishing, so
 * the step is abandoned and (being retryable) re-run. This is DISTINCT from an
 * `AbortError` (a user cancel), which the loop must never retry: a stall is the
 * transport wedging, a cancel is the human stopping. Named so `instanceof` works
 * across module/realm boundaries via {@link isRetryableModelError}. Exported for tests.
 */
export class StreamStallError extends Error {
  /** The inactivity deadline (ms) that elapsed with no stream part. */
  readonly stallMs: number;
  constructor(stallMs: number) {
    super(
      `Model stream stalled: no stream part received for ${stallMs}ms — abandoning the step.`,
    );
    this.name = "StreamStallError";
    this.stallMs = stallMs;
  }
}

/**
 * Is this a retryable transient model/transport error? 429, 5xx, the
 * network/overload/stream family, and a {@link StreamStallError} — but NOT user
 * aborts, 4xx-other (bad request/auth), insufficient funds, or context-overflow
 * (handled separately). Exported for tests.
 */
export function isRetryableModelError(err: unknown): boolean {
  // A stalled stream is transient — retry it. Checked FIRST so its distinct
  // class is never confused with the AbortError (user cancel) branch below.
  if (err instanceof StreamStallError) return true;
  if (err instanceof Error && err.name === "AbortError") return false;
  if (isContextOverflowError(err)) return false;
  if (isFatalAuthOrBillingError(err)) return false;
  const status = statusOf(err);
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status < 600) return true;
  if (status !== undefined && status >= 400 && status < 500) return false; // other 4xx: not retryable
  const msg = errorText(err);
  return /\b429\b|rate.?limit|overloaded|\b5\d\d\b|service unavailable|bad gateway|gateway timeout|timeout|timed out|econnreset|etimedout|enotfound|eai_again|econnrefused|enetunreach|fetch failed|network|socket hang up|stream (error|closed|interrupted)|premature close/.test(
    msg,
  );
}

/** Is this the provider's "prompt too long / context length exceeded" error? Exported for tests. */
export function isContextOverflowError(err: unknown): boolean {
  const msg = errorText(err);
  return /context.?length|maximum context|context window|too many tokens|prompt is too long|reduce the (length|number of)|input is too long|too many input tokens/.test(
    msg,
  );
}

// ── Backoff ──────────────────────────────────────────────────────────────────

/**
 * Exponential backoff with full jitter, capped. attempt is 1-based.
 * `rand` is injectable for deterministic tests (defaults to Math.random).
 * Exported for tests.
 */
export function backoffMs(
  attempt: number,
  opts: { baseMs?: number; capMs?: number; rand?: () => number } = {},
): number {
  const base = opts.baseMs ?? 500;
  const cap = opts.capMs ?? 8_000;
  const rand = opts.rand ?? Math.random;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  // Full jitter: uniform in [0, exp].
  return Math.floor(rand() * exp);
}

/**
 * Await `fn()`, and if it hasn't settled within `thresholdMs`, fire `onSlow`
 * exactly once as a breadcrumb — WITHOUT ever cancelling or auto-resolving the
 * wait. Used to make an unbounded interactive wait (the budget guard's
 * approval-mode block) observable: the caller learns "this has been pending a
 * long time" but the human's decision is still the only thing that ends it. The
 * timer is cleared the moment `fn` settles (resolve OR reject), so a fast wait
 * costs one `setTimeout`/`clearTimeout` and never leaks. Exported for tests.
 */
export async function withSlowWaitBreadcrumb<T>(
  fn: () => Promise<T>,
  thresholdMs: number,
  onSlow: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    onSlow();
  }, thresholdMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    return await fn();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolve after `ms`, rejecting early with an AbortError if `signal` fires. */
export function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  // An ALREADY-aborted signal must reject immediately — `addEventListener("abort")`
  // never fires for an abort that has already been dispatched, so without this
  // guard an already-aborted turn would sit through the full backoff before its
  // caller's catch/break could fire. Both callers (engine.ts retry backoff,
  // tools.ts file-lock acquire retry) already break on this rejection.
  if (signal?.aborted) {
    return Promise.reject(
      new DOMException("Aborted before backoff.", "AbortError"),
    );
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted during backoff.", "AbortError"));
      },
      { once: true },
    );
  });
}
