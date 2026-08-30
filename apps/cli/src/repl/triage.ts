/**
 * triage.ts — the busy-submit triage policy for the interactive REPL.
 *
 * The REPL already has a non-interrupting FIFO prompt queue: a prompt typed
 * while a turn is streaming is enqueued and pumped after the current turn
 * settles (interactive.tsx). That is correct but blunt — a genuinely
 * INDEPENDENT task ("also, bump the changelog") waits behind the current work
 * for no reason, and an AMBIGUOUS prompt is queued with no signal that the user
 * might have meant something else.
 *
 * This module is the v2 the dispatch-mode header anticipated ("An LLM triager
 * remains a possible v2"). When the user submits while busy, a SMALL/cheap model
 * decides where the prompt goes instead of blind FIFO queueing:
 *
 *   - "queue"      — depends on / follows up the current work → run it next.
 *   - "background" — independent → dispatch a detached fleet worker now, so the
 *                    composer and the current turn are both unblocked.
 *   - "clarify"    — ambiguous → queue it, but flag that it may need a nudge.
 *
 * Design contract (the integrator wires the decision; this module only decides):
 *
 *   1. Pure, deterministic core. {@link fallbackTriage} is a total function over
 *      the text alone — no model, no I/O — and it NEVER surprises: the only
 *      route it ever returns other than "queue" is "background", and ONLY for
 *      the explicit shell-familiar trailing ` &`. Slash/shell commands and
 *      short follow-ups queue. Background routing therefore comes from exactly
 *      two places: the LLM path below, or an explicit ` &` the user typed.
 *   2. The async LLM path ({@link triagePrompt}) is bounded by a STRICT timeout
 *      (default 3s) and degrades to {@link fallbackTriage} on ANY error or
 *      timeout. It never throws and never blocks the composer — a busy submit
 *      must always resolve, fast, to a safe route.
 *   3. The model is reached through an injected port ({@link TriageAi}, a subset
 *      of the engine's {@link AgentAi} seam) exactly like plan-turn.ts — never
 *      `generateObject` from `ai` directly — so it meters on the platform and
 *      stays BYOK/unmetered in the CLI without this module knowing which.
 */
import { z } from "zod";
import type { AgentAi } from "@oxagen/agent-engine";
import { modelForTier } from "../agent/model-router.js";
import { parseAmpersandDispatch } from "../sessions/dispatch.js";

/**
 * Where a busy-submit prompt is routed.
 *   - "queue"      run it after the current turn (dependent / follow-up).
 *   - "background" dispatch a detached fleet worker now (independent task).
 *   - "clarify"    queue, but the prompt is ambiguous and may need a nudge.
 * `reason` is a short human-readable rationale for the transcript notice.
 */
export type TriageDecision = {
  route: "queue" | "background" | "clarify";
  reason: string;
};

/**
 * The minimal AI port triage needs — a strict subset of the engine's
 * {@link AgentAi}, so a caller passes the session's own `ai` straight through.
 * Only structured classification is required; the streaming half is not.
 */
export type TriageAi = Pick<AgentAi, "generateObject">;

export interface TriagePromptOptions {
  /** The prompt the user submitted while a turn was streaming. */
  text: string;
  /** A compact digest of what the active turn is doing, for the classifier. */
  activeSummary: string;
  /** How many prompts already wait in the FIFO queue (0 = none). */
  queueDepth: number;
  /** The injected AI port (platform-metered or BYOK — whichever is active). */
  ai: TriageAi;
  /** Strict wall-clock bound in ms; ≤0 disables the bound. Default 3000. */
  timeoutMs?: number;
  /** Model slug for the classifier. Undefined ⇒ the cheap "fast" tier. */
  model?: string;
}

/** Strict wall-clock bound on the triage call — a busy submit resolves fast. */
export const DEFAULT_TRIAGE_TIMEOUT_MS = 3_000;

/** Reason stamped whenever the LLM path is unavailable (timeout/error/no port). */
export const TRIAGE_UNAVAILABLE_REASON = "triage unavailable — queued";

/** Longest reason we surface — a runaway model reason is clipped, never shown raw. */
const MAX_REASON_CHARS = 200;

/** Distinguishes a lost timeout race from a real classification result. */
const TIMEOUT = Symbol("triage-timeout");

const triageSchema = z.object({
  route: z.enum(["queue", "background", "clarify"]),
  reason: z.string(),
});

const TRIAGE_SYSTEM = [
  "You are the triage step of a terminal coding agent. A turn is already",
  "streaming when the user submits a NEW prompt. Decide where the new prompt",
  "goes, returning JSON with `route` and a one-sentence `reason`.",
  "",
  "route:",
  '  "queue"      the prompt depends on, corrects, or follows up the active',
  "               work (e.g. 'also add a test for that', 'undo the last edit',",
  "               'now do the same for the API'). Run it after the current turn.",
  '  "background" the prompt is an INDEPENDENT task that shares no state with the',
  "               active work (e.g. 'meanwhile, bump the changelog'). It can run",
  "               in parallel as a detached worker.",
  '  "clarify"    the prompt is ambiguous — it could be a follow-up or a new',
  "               task and you cannot tell. Prefer this over guessing wrong.",
  "",
  "Bias toward `queue` when unsure between queue and background — serial is",
  "always safe; parallel work on shared state is not.",
].join("\n");

/** Trim a reason to a sane length and fall back to a route-specific default. */
function cleanReason(raw: string, route: TriageDecision["route"]): string {
  const trimmed = raw.trim();
  if (trimmed === "") return defaultReason(route);
  return trimmed.length > MAX_REASON_CHARS
    ? trimmed.slice(0, MAX_REASON_CHARS - 1) + "…"
    : trimmed;
}

function defaultReason(route: TriageDecision["route"]): string {
  switch (route) {
    case "background":
      return "independent task — dispatched in the background";
    case "clarify":
      return "ambiguous — queued, may need a nudge";
    case "queue":
      return "queued to run after the current turn";
  }
}

function buildTriagePrompt(
  text: string,
  activeSummary: string,
  queueDepth: number,
): string {
  const active = activeSummary.trim() || "(no summary of the active turn)";
  return [
    `Active turn: ${active}`,
    `Prompts already queued: ${queueDepth}`,
    "",
    "New prompt the user just submitted:",
    text.trim(),
  ].join("\n");
}

/**
 * The deterministic short-circuit: the two cases we route WITHOUT a model.
 * An explicit trailing ` &` is the user asking for background out loud; a
 * slash/shell command is handled by the REPL itself and must never background.
 * Everything else returns null — the caller either queues (fallback) or asks
 * the model (triagePrompt).
 */
function deterministicRoute(text: string): TriageDecision | null {
  // Explicit trailing " &" — the shell-familiar background primitive. This
  // already refuses slash/shell commands and bare "&".
  if (parseAmpersandDispatch(text) !== null) {
    return { route: "background", reason: "explicit background dispatch ( &)" };
  }
  const lead = text.trimStart();
  if (lead.startsWith("/") || lead.startsWith("!")) {
    return { route: "queue", reason: "command — queued to run in order" };
  }
  return null;
}

/**
 * The deterministic fallback — a total function over the text alone. Returns
 * "background" ONLY for an explicit trailing ` &`; every other prompt
 * (slash/shell command, short follow-up, or an independent-looking task)
 * queues. This is the safe default the model path degrades to, so it must
 * never surprise the user with an unrequested background dispatch.
 */
export function fallbackTriage(text: string): TriageDecision {
  return (
    deterministicRoute(text) ?? {
      route: "queue",
      reason: defaultReason("queue"),
    }
  );
}

/**
 * Triage a busy-submit prompt. Short-circuits the deterministic cases without a
 * model call; otherwise asks the injected cheap model, bounded by a strict
 * timeout. ANY error, timeout, or malformed model output degrades to a safe
 * "queue" ({@link TRIAGE_UNAVAILABLE_REASON}). Never throws; never blocks.
 */
export async function triagePrompt(
  opts: TriagePromptOptions,
): Promise<TriageDecision> {
  const deterministic = deterministicRoute(opts.text);
  if (deterministic) return deterministic;

  const unavailable: TriageDecision = {
    route: "queue",
    reason: TRIAGE_UNAVAILABLE_REASON,
  };

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TRIAGE_TIMEOUT_MS;
  const model = opts.model ?? modelForTier("fast");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const call = opts.ai.generateObject({
      model,
      schema: triageSchema,
      system: TRIAGE_SYSTEM,
      prompt: buildTriagePrompt(opts.text, opts.activeSummary, opts.queueDepth),
      abortSignal: controller.signal,
    });
    // Pre-handle the call's rejection so a post-race failure (after a timeout
    // already resolved the turn) can never surface as an unhandled rejection.
    call.catch(() => {});

    const raced =
      timeoutMs > 0
        ? await Promise.race([
            call,
            new Promise<typeof TIMEOUT>((resolve) => {
              timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
            }),
          ])
        : await call;

    if (raced === TIMEOUT) {
      controller.abort();
      return unavailable;
    }

    // Defensive parse: an injected/mocked port may hand back off-schema data,
    // and a real model can drift. Off-schema output degrades to the safe route.
    const parsed = triageSchema.safeParse(raced.object);
    if (!parsed.success) return unavailable;
    return {
      route: parsed.data.route,
      reason: cleanReason(parsed.data.reason, parsed.data.route),
    };
  } catch {
    return unavailable;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
