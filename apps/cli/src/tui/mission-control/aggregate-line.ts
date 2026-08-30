/**
 * aggregate-line.ts — the editorial voice of Mission Control's merged
 * timeline (ADR-023, spec §5).
 *
 * N agents streaming raw text into one pane is noise; an aggregate view earns
 * its keep by showing only what a fleet operator scans for: what each agent
 * was ASKED, what it DID (tools, edits, commands), what it CONCLUDED, and how
 * it ENDED. Full prose lives in the Focus view and on disk — never here.
 *
 * Pure event → line mapping (no Ink, no color codes): the renderer owns
 * layout, session color, and the timestamp/sid gutter; tests own every rule
 * below. Returning `null` means "not salient for the aggregate".
 *
 * Salience rules (verbose=false):
 *   session.start   ▶ title                       message(user)  › text
 *   stage           only execute/judge/revise/plan (dim, label)
 *   tool.end        ok: "name · 1.2s" (dim) · failed: "name failed" (error)
 *   diff            ±N lines across M files
 *   message.end     ⏺ first line of the assistant's answer
 *   turn.end        ✓ turn n · s steps (dim)      error          ✗ message
 *   session.state   only "waiting" (dim)          session.end    ✔/✖/◼ + summary
 * Verbose adds: every stage, tool.start, and message.delta chunks.
 */
import type { SessionEvent } from "../../sessions/events.js";

export type AggregateEmphasis = "dim" | "normal" | "success" | "error";

export interface AggregateLine {
  sid: string;
  ts: number;
  /** Pre-formatted line WITHOUT the sid/time gutter (renderer adds those). */
  text: string;
  emphasis: AggregateEmphasis;
}

/** Stages worth a line when not verbose — the ones that mark real phase shifts. */
const SALIENT_STAGES = new Set(["plan", "execute", "judge", "revise"]);

const clip = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
};

const firstLine = (s: string): string => {
  const line = s.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim();
};

/**
 * A short, human duration: `12ms` / `1.2s` / `2m31s`. The minute component
 * FLOORS (rounding it would report 119_999ms as `2m60s`); the second component
 * is the floored remainder, so the two parts always agree.
 *
 * This is the single implementation — Mission Control's `lib.ts` re-exports it
 * as `formatDurationMs` so a tool chip reads the same in the Focus and
 * Aggregate views. Kept here because this module is the leaf (no theme, no
 * Ink), so the dependency points the safe way.
 */
export const formatDurationMs = (ms: number): string => {
  if (ms >= 60_000) {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}m${total % 60}s`;
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
};

/**
 * Map one session event to its aggregate-timeline line, or `null` when the
 * event is not salient at this verbosity.
 */
export function toAggregateLine(
  event: SessionEvent,
  opts: { verbose?: boolean } = {},
): AggregateLine | null {
  const verbose = opts.verbose === true;
  const line = (text: string, emphasis: AggregateEmphasis): AggregateLine => ({
    sid: event.sid,
    ts: event.ts,
    text,
    emphasis,
  });

  switch (event.type) {
    case "session.start":
      return line(`▶ ${clip(event.title, 100)}`, "normal");
    case "message":
      return line(`› ${clip(event.text, 120)}`, "normal");
    case "stage":
      if (!verbose && !SALIENT_STAGES.has(event.kind)) return null;
      return line(
        event.detail
          ? `${event.label} — ${clip(event.detail, 80)}`
          : event.label,
        "dim",
      );
    case "message.delta":
      return verbose ? line(clip(event.text, 120), "dim") : null;
    case "message.end": {
      const head = firstLine(event.text);
      return head === "" ? null : line(`⏺ ${clip(head, 160)}`, "normal");
    }
    case "reasoning.delta":
      return null;
    case "tool.start":
      return verbose ? line(`· ${event.name} …`, "dim") : null;
    case "tool.end":
      return event.ok
        ? line(`· ${event.name} ${formatDurationMs(event.durationMs)}`, "dim")
        : line(
            `✗ ${event.name} failed after ${formatDurationMs(event.durationMs)}`,
            "error",
          );
    case "diff": {
      const files = event.changedFiles.length;
      if (files === 0) return null;
      const shown = event.changedFiles.slice(0, 3).join(", ");
      const more = files > 3 ? ` +${files - 3}` : "";
      return line(`± ${event.changedLines} lines · ${shown}${more}`, "success");
    }
    case "turn.end":
      return line(`✓ turn ${event.turn} · ${event.steps} steps`, "dim");
    case "usage":
      return null;
    case "session.state":
      return event.state === "waiting"
        ? line("◇ waiting for input", "dim")
        : null;
    case "error":
      return line(`✗ ${clip(event.message, 160)}`, "error");
    case "session.end":
      switch (event.state) {
        case "done":
          return line(
            event.summary === ""
              ? "✔ done"
              : `✔ done — ${clip(event.summary, 120)}`,
            "success",
          );
        case "failed":
          return line(
            event.summary === ""
              ? "✖ failed"
              : `✖ failed — ${clip(event.summary, 120)}`,
            "error",
          );
        case "cancelled":
          return line("◼ cancelled", "dim");
      }
  }
  /* c8 ignore next 2 -- exhaustive switch; future event types land here */
  return null;
}
