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
 * The corrective message injected when the model repeats an identical failing
 * call `LOOP_NUDGE_THRESHOLD` times. Exported for tests.
 */
export function loopNudgeMessage(name: string, count: number, lastError: string): string {
  return (
    `You have called \`${name}\` with the same arguments ${count} times and it ` +
    `keeps failing: ${lastError.slice(0, 400)}. Stop repeating this exact call — ` +
    `it will not start working. Inspect the current state (re-read the file or run ` +
    `a diagnostic), then take a DIFFERENT approach.`
  );
}

// ── Token estimation ─────────────────────────────────────────────────────────

/**
 * Rough token estimate: ~4 chars per token over serialized content. Deliberately
 * a heuristic — no tokenizer dependency, and it only needs to be good enough to
 * decide WHEN to compact (we compact well below the true window). Exported for tests.
 */
export function estimateMessageTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += contentLength(m.content);
  return Math.ceil(chars / 4);
}

function contentLength(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  try {
    return JSON.stringify(content)?.length ?? 0;
  } catch {
    return String(content).length;
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
  if (m.includes("gpt-4.1") || m.includes("gpt-5") || m.includes("o3") || m.includes("o4")) return 400_000;
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

const COMPACTION_MARKER = "\n… [older content elided to fit context — re-read the file/command if still needed]";

/**
 * Structurally compact a transcript: keep the first user message (the task) and
 * the last `keepLastN` messages verbatim; truncate the bulky content of
 * everything in between (old tool results, large reads). Deterministic and
 * free — no LLM summary call — which is exactly what you want on the recovery
 * path. Returns a NEW array; never mutates the input. Exported for tests.
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
  let compacted = false;

  const out = messages.map((msg, i) => {
    const isProtected = i === firstUserIdx || i >= protectedFrom;
    if (isProtected) return msg;
    const truncated = truncateContent(msg.content, opts.contentCap);
    if (truncated.changed) compacted = true;
    return { ...msg, content: truncated.content } as ModelMessage;
  });

  return { messages: out, compacted };
}

/** Truncate the textual payload of a message's content to `cap` chars. */
function truncateContent(
  content: unknown,
  cap: number,
): { content: unknown; changed: boolean } {
  if (typeof content === "string") {
    if (content.length <= cap) return { content, changed: false };
    return { content: content.slice(0, cap) + COMPACTION_MARKER, changed: true };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const parts = content.map((part) => {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        // Assistant text part: { type: "text", text }
        if (typeof p["text"] === "string" && (p["text"] as string).length > cap) {
          changed = true;
          return { ...p, text: (p["text"] as string).slice(0, cap) + COMPACTION_MARKER };
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

function truncateToolOutput(output: unknown, cap: number): { output: unknown; changed: boolean } {
  if (typeof output === "string") {
    if (output.length <= cap) return { output, changed: false };
    return { output: output.slice(0, cap) + COMPACTION_MARKER, changed: true };
  }
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o["value"] === "string" && (o["value"] as string).length > cap) {
      return {
        output: { ...o, value: (o["value"] as string).slice(0, cap) + COMPACTION_MARKER },
        changed: true,
      };
    }
    if (typeof o["text"] === "string" && (o["text"] as string).length > cap) {
      return {
        output: { ...o, text: (o["text"] as string).slice(0, cap) + COMPACTION_MARKER },
        changed: true,
      };
    }
  }
  return { output, changed: false };
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
 * Is this a retryable transient model/transport error? 429, 5xx, and the
 * network/overload/stream family — but NOT user aborts, 4xx-other (bad
 * request/auth), insufficient funds, or context-overflow (handled separately).
 * Exported for tests.
 */
export function isRetryableModelError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false;
  if (isContextOverflowError(err)) return false;
  const msg = errorText(err);
  if (/insufficient_funds|positive credit balance|invalid.*api.?key|unauthorized|\b401\b|\b403\b/.test(msg)) {
    return false;
  }
  const status = statusOf(err);
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status < 600) return true;
  if (status !== undefined && status >= 400 && status < 500) return false; // other 4xx: not retryable
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

/** Resolve after `ms`, rejecting early with an AbortError if `signal` fires. */
export function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
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
