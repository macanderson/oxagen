// diff: the tool surface diff a sync PR or an import PR shows (lane M4;
// mcp-studio-spec, Sync).
//
// diff() compares the lock and manifest entry the gateway serves now with
// the ones a steering PR proposes, and lists every tool the source offers
// that is not imported. A breaking change keeps the tool withheld until the
// steering PR merges.
import type { McpToolsLock } from "../contract/lock";
import type { ManifestServer } from "../contract/manifest";
import type { UpstreamTool } from "../model/upstream-tool";
import { notBuilt } from "../not-built";

/**
 * Why a change breaks an agent that already calls the tool:
 *
 * - removed_tool: the source no longer offers it.
 * - new_required_input: the input schema requires a property it did not.
 * - narrowed_type: an input accepts fewer values, such as a smaller enum or
 *   a tighter type.
 * - removed_selected_field: the result no longer has a field that
 *   tools.toml's select names.
 */
export const BREAKING_REASONS = [
  "removed_tool",
  "new_required_input",
  "narrowed_type",
  "removed_selected_field",
] as const;
export type BreakingReason = (typeof BREAKING_REASONS)[number];

export interface BreakingChange {
  reason: BreakingReason;
  /** One line for the steering PR: "new required input: currency (string, ISO 4217)". */
  detail: string;
}

/** One side of the diff: a lock and the manifest entry compiled from it. */
export interface DiffSide {
  lock: McpToolsLock;
  server: ManifestServer;
}

export interface DiffInput {
  /** What the gateway serves now, from the production branch. */
  served: DiffSide;
  /** What the steering PR proposes. A tool the source no longer offers is absent from it. */
  proposed: DiffSide;
  /** Every tool the source offers now, imported or not. */
  offered: readonly UpstreamTool[];
}

/**
 * One line of the diff:
 *
 * - offered: the source has a tool nobody imported.
 * - changed: an imported tool whose upstream or definition changed.
 * - removed: an imported tool the proposed lock drops.
 */
export type ToolSurfaceDiffEntry =
  | {
      change: "offered";
      /** The upstream name: list_disputes. */
      upstream: string;
    }
  | {
      change: "changed";
      /** The tools.toml key. */
      key: string;
      /** The full name: billing__create_refund. */
      tool: string;
      /** The served version and the proposed one. They are equal when only the upstream changed. */
      version: { served: number; proposed: number };
      breaking: BreakingChange[];
      /** The upstream description, when it changed and the served definition still carries the locked one. */
      description: { served: string | undefined; proposed: string | undefined } | undefined;
      /** Changes that break nothing: "response field data[].fee added (not in select, not returned)". */
      notes: string[];
    }
  | {
      change: "removed";
      key: string;
      tool: string;
      breaking: BreakingChange[];
      notes: string[];
    };

export interface ToolSurfaceDiff {
  server: string;
  entries: ToolSurfaceDiffEntry[];
  /** Definition tokens per request, served and proposed, against the server's definition_budget. */
  tokens: { served: number; proposed: number; budget: number };
  /** True when any entry is breaking. */
  breaking: boolean;
}

/** The tool surface diff between the served and proposed sides. */
export function diff(input: DiffInput): ToolSurfaceDiff {
  return notBuilt("diff", input);
}
