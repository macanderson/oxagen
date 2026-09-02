/**
 * debug-frame.ts — pure, deterministic construction of the structured failure
 * frame behind `agent.debug.trace` (debug_with_trace). No I/O, no model calls,
 * no `any` (TS 6).
 *
 * ADR-021 §3: raw tool output never reaches the model. Everything here is the
 * deterministic compressor — parse (stack traces), rank (suspect files by rule),
 * truncate (bounded lists) — that turns a span tree + captured errors + logs
 * into a small, typed frame a model can safely read. The optional model call
 * (diagnosis) lives in the handler, not here.
 */

import type { TraceExecutionNode } from "@oxagen/oxagen/contracts/agent.trace.get";

// ── Bounds (every list the model sees is capped here) ─────────────────────────
export const MAX_TOP_FRAMES = 12;
export const MAX_RELATED_SPANS = 40;
export const MAX_SUSPECT_FILES = 10;
export const MAX_LOG_LINES = 25;
export const MAX_ERROR_EVENTS = 15;
const MESSAGE_CLAMP = 600;
const LOG_MESSAGE_CLAMP = 300;

// File extensions we treat as source/config paths when mining free text for
// suspect files. An allowlist keeps extraction deterministic and stops random
// dotted tokens (e.g. "v1.2.3", "a.b") from being mistaken for files.
const FILE_EXT =
  "ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|rb|php|c|h|cpp|hpp|sql|graphql|gql|json|jsonc|ya?ml|toml|md|mdx|sh|css|scss|html|vue|svelte|prisma|proto";
const FILE_TOKEN_RE = new RegExp(`[\\w./@~-]+\\.(?:${FILE_EXT})\\b`, "g");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StackFrame {
  /** Function/method name, or null for anonymous / bare-location frames. */
  functionName: string | null;
  /** File path, or null when the frame carried none (native/eval). */
  file: string | null;
  line: number | null;
  column: number | null;
  /** True for node-internal (`node:…`) frames — de-prioritised as suspects. */
  internal: boolean;
  /** The original trimmed line, so nothing is lost to a parse miss. */
  raw: string;
}

export interface RelatedSpan {
  kind: "execution" | "step" | "toolCall";
  /** Public id (aex_/aes_/atc_…). */
  id: string;
  /** Human label: step type, tool name, or origin — never a bare UUID. */
  label: string;
  status: string;
  failureReason: string | null;
  latencyMs: number | null;
}

export interface SuspectFile {
  path: string;
  /** Deterministic weighted score; higher = more likely the fix site. */
  score: number;
  /** Why it scored (e.g. "stack-frame ×3", "tool-arg", "failure-reason"). */
  reasons: string[];
}

export interface FailingStep {
  stepId: string | null;
  stepNumber: number | null;
  stepType: string | null;
  /** Set when the failure surfaced inside a tool call within the step. */
  toolName: string | null;
  toolCallId: string | null;
  status: string;
  failureReason: string | null;
  latencyMs: number | null;
}

// ── Stack-frame parser ────────────────────────────────────────────────────────

/**
 * Parse a V8-style stack string into structured frames (top `limit` only).
 * Handles the common shapes:
 *   at fn (/abs/file.ts:12:34)
 *   at async fn (/abs/file.ts:12:34)
 *   at /abs/file.ts:12:34
 *   at Object.<anonymous> (/abs/file.ts:1:1)
 *   at fn (node:internal/process/task_queues:95:5)
 *   at fn (native)
 * The first line of a V8 stack is the "Error: message" header and is skipped.
 * Never throws; a line that doesn't match becomes a frame with null location
 * but a preserved `raw`.
 */
export function parseStackFrames(
  stack: string,
  limit = MAX_TOP_FRAMES,
): StackFrame[] {
  if (typeof stack !== "string" || stack.trim() === "") return [];
  const frames: StackFrame[] = [];
  for (const rawLine of stack.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || !line.startsWith("at ")) continue;
    if (frames.length >= limit) break;

    // Strip "at " and an optional "async " qualifier.
    let body = line.slice(3).trim();
    if (body.startsWith("async ")) body = body.slice(6).trim();

    let functionName: string | null = null;
    let location = body;

    // "fn (location)" — the location is the parenthesised tail.
    const parenStart = body.lastIndexOf(" (");
    if (parenStart !== -1 && body.endsWith(")")) {
      functionName = body.slice(0, parenStart).trim() || null;
      location = body.slice(parenStart + 2, -1).trim();
    }

    const internal = location.startsWith("node:") || location === "native";
    let file: string | null = null;
    let lineNo: number | null = null;
    let colNo: number | null = null;

    const loc = location.match(/^(.*):(\d+):(\d+)$/);
    if (loc) {
      file = loc[1] || null;
      lineNo = Number(loc[2]);
      colNo = Number(loc[3]);
    } else if (location !== "native" && location !== "<anonymous>") {
      file = location || null;
    }

    frames.push({
      functionName,
      file,
      line: lineNo,
      column: colNo,
      internal,
      raw: line,
    });
  }
  return frames;
}

// ── File-path extraction from free text ───────────────────────────────────────

/** Extract file-looking tokens from arbitrary text (bounded by the regex). */
export function extractFilePaths(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(FILE_TOKEN_RE)) {
    const path = m[0];
    if (!seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

// ── Suspect-file ranking ──────────────────────────────────────────────────────

interface SuspectSignal {
  path: string;
  /** Weight added per occurrence. */
  weight: number;
  reason: string;
}

const NODE_MODULES_RE = /(^|\/)node_modules\//;

/**
 * Rank suspect files by summing deterministic signal weights, highest first.
 * Weights encode "how likely is THIS file the fix site":
 *   - a project file named in the error stack          → 4 (strongest)
 *   - a node_modules file named in the error stack      → 1 (rarely the fix)
 *   - a file passed as a tool-call argument             → 2
 *   - a file named in a failure reason / log message    → 2
 * Ties break by first-seen order (stable). Paths are compared verbatim (already
 * absolute in stacks); no normalisation guessing.
 */
export function rankSuspectFiles(
  signals: SuspectSignal[],
  limit = MAX_SUSPECT_FILES,
): SuspectFile[] {
  const byPath = new Map<
    string,
    { score: number; reasons: Map<string, number>; order: number }
  >();
  let order = 0;
  for (const sig of signals) {
    if (!sig.path) continue;
    let entry = byPath.get(sig.path);
    if (!entry) {
      entry = { score: 0, reasons: new Map(), order: order++ };
      byPath.set(sig.path, entry);
    }
    entry.score += sig.weight;
    entry.reasons.set(sig.reason, (entry.reasons.get(sig.reason) ?? 0) + 1);
  }

  return [...byPath.entries()]
    .map(([path, e]) => ({
      path,
      score: e.score,
      order: e.order,
      reasons: [...e.reasons.entries()].map(([r, n]) =>
        n > 1 ? `${r} ×${n}` : r,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ path, score, reasons }) => ({ path, score, reasons }));
}

/**
 * Build the ranked suspect-file list from the deterministic inputs: parsed
 * stack frames (primary), tool-argument file paths, and failure-reason/log text.
 */
export function suspectFilesFrom(inputs: {
  stackFrames: StackFrame[];
  toolArgPaths: string[];
  failureText: string[];
}): SuspectFile[] {
  const signals: SuspectSignal[] = [];
  for (const f of inputs.stackFrames) {
    if (!f.file || f.internal) continue;
    signals.push({
      path: f.file,
      weight: NODE_MODULES_RE.test(f.file) ? 1 : 4,
      reason: "stack-frame",
    });
  }
  for (const p of inputs.toolArgPaths) {
    signals.push({ path: p, weight: 2, reason: "tool-arg" });
  }
  for (const text of inputs.failureText) {
    for (const p of extractFilePaths(text)) {
      signals.push({ path: p, weight: 2, reason: "failure-reason" });
    }
  }
  return rankSuspectFiles(signals);
}

// ── Span-tree flatten + failing-step detection ────────────────────────────────

/**
 * Flatten a trace subtree into a bounded, failure-first list of spans. Failed
 * spans sort ahead of the rest so the model reads the relevant ones even under
 * the cap; within each group, tree pre-order is preserved.
 */
export function flattenSpans(
  root: TraceExecutionNode,
  limit = MAX_RELATED_SPANS,
): RelatedSpan[] {
  const all: RelatedSpan[] = [];
  const walk = (node: TraceExecutionNode): void => {
    all.push({
      kind: "execution",
      id: node.executionId,
      label: node.originType
        ? `${node.originType}:${node.originId}`
        : node.executionId,
      status: node.status,
      failureReason: node.failureReason,
      latencyMs: node.latencyMs,
    });
    for (const step of node.steps) {
      all.push({
        kind: "step",
        id: step.stepId,
        label: `step ${step.stepNumber} (${step.stepType})`,
        status: step.status,
        failureReason: step.failureReason,
        latencyMs: step.latencyMs,
      });
      for (const call of step.toolCalls) {
        all.push({
          kind: "toolCall",
          id: call.toolCallId,
          label: call.toolName,
          status: call.status,
          failureReason: null,
          latencyMs: call.latencyMs,
        });
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);

  const failed = (s: RelatedSpan): boolean =>
    s.status === "failed" || s.status === "cancelled";
  const ordered = [...all.filter(failed), ...all.filter((s) => !failed(s))];
  return ordered.slice(0, limit);
}

/**
 * Find the failing step: the first failed step in tree pre-order (root before
 * children). Attaches the first failed tool call's name when the step's failure
 * coincides with a tool-call failure. Returns null when nothing failed.
 */
export function findFailingStep(root: TraceExecutionNode): FailingStep | null {
  const queue: TraceExecutionNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift() as TraceExecutionNode;
    for (const step of node.steps) {
      if (step.status === "failed" || step.status === "cancelled") {
        const failedCall =
          step.toolCalls.find((c) => c.status === "failed") ?? null;
        return {
          stepId: step.stepId,
          stepNumber: step.stepNumber,
          stepType: step.stepType,
          toolName: failedCall?.toolName ?? null,
          toolCallId: failedCall?.toolCallId ?? null,
          status: step.status,
          failureReason: step.failureReason,
          latencyMs: step.latencyMs,
        };
      }
    }
    queue.push(...node.children);
  }
  return null;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

export function clampMessage(
  s: string | null | undefined,
  max = MESSAGE_CLAMP,
): string | null {
  if (s === null || s === undefined) return null;
  return s.length > max ? `${s.slice(0, max)}… [truncated]` : s;
}

export function clampLogMessage(s: string): string {
  return s.length > LOG_MESSAGE_CLAMP
    ? `${s.slice(0, LOG_MESSAGE_CLAMP)}… [truncated]`
    : s;
}
