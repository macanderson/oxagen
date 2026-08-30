/**
 * activity.ts — the shared activity-event vocabulary.
 *
 * Several surfaces show "what's running right now": the REPL's `/hud`, the
 * fleet roster, and the best-of-N lane view, plus one-shot mode's plain-text
 * progress lines. This module is their one canonical status→glyph/color
 * mapping, so a task finishing looks the same on every screen. Each surface's
 * own narrower status type (HUD's `AgentStatus`, the fleet's `TaskStatus`,
 * best-of-N's lane status) is a literal subset of {@link ActivityStatus}, so
 * they all resolve through {@link activityGlyph} with no translation layer.
 *
 * {@link formatActivityLine} is the matching text formatter for surfaces
 * without a renderer (one-shot's stderr / stream-json output).
 */
import { theme } from "./theme.js";

/**
 * Canonical lifecycle states across every activity surface. Each surface's
 * own status type — HUD's `AgentStatus`, the fleet's `TaskStatus`, best-of-N's
 * lane status — is a literal subset of this union, so callers pass their
 * native status straight through with no translation layer.
 */
export type ActivityStatus =
  | "queued"
  | "running"
  | "verifying"
  | "blocked"
  | "cancelled"
  | "done"
  | "failed"
  | "killed";

/** A minimal activity update: what's happening, and how it's going. */
export interface ActivityEvent {
  status: ActivityStatus;
  /** One-line human label — "editing…", "running tests…", "add rate limiting". */
  label: string;
  /** Optional extra context — a model slug, a file count, an error message. */
  detail?: string;
}

/** Braille spinner frames — shared by every animated "running" glyph. */
export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

export interface ActivityGlyph {
  glyph: string;
  color: string;
}

/**
 * Glyph + color for a status, shared by every activity surface. `frame` — an
 * incrementing tick counter — animates "running"/"verifying" as a braille
 * spinner; omit it for a static bullet (the HUD's non-animated style, which
 * ticks its own clock only for elapsed-time display).
 */
export function activityGlyph(
  status: ActivityStatus,
  frame?: number,
): ActivityGlyph {
  switch (status) {
    case "queued":
      return { glyph: "⧗", color: theme.amber };
    case "running":
    case "verifying":
      return {
        glyph:
          frame === undefined
            ? "●"
            : (SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "⠋"),
        color: theme.cyan,
      };
    case "blocked":
      return { glyph: "⊘", color: theme.red };
    case "cancelled":
      return { glyph: "⊘", color: theme.dim };
    case "done":
      return { glyph: "✓", color: theme.green };
    case "failed":
      return { glyph: "✗", color: theme.red };
    case "killed":
      // A deliberate user kill (Ctrl-X twice on a swarm row) — a red stop
      // square, distinct from "failed" (the work errored on its own) and
      // "cancelled" (a soft dim ⊘: the turn was cancelled around it).
      return { glyph: "◼", color: theme.red };
  }
}

/**
 * Render a `{ label, detail? }` pair as one plain-text line: `label · detail`
 * when detail is present, `label` alone otherwise. No glyph, indent, or
 * trailing newline — callers compose those (an Ink `<Text>`, a `stderr.write`
 * with its own leading spaces) so this stays usable in any surface.
 *
 * Takes just the label/detail shape (not the full {@link ActivityEvent}) so it
 * composes directly with anything that already carries those two fields —
 * a `StageEvent`, a `ToolEvent`-ish record — with no adapter object needed.
 */
export function formatActivityLine(
  event: Pick<ActivityEvent, "label" | "detail">,
): string {
  return event.detail ? `${event.label} · ${event.detail}` : event.label;
}
