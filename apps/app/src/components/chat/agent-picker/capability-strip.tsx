"use client";
import * as React from "react";
import { Puzzle, Server, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentToolRef } from "./agent-picker-types";

/**
 * capability-strip.tsx — a compact, human-readable summary of an agent's tool
 * allowlist for a picker row. Renders a "2 MCP · 5 tools" count summary plus up
 * to a few named chips (prettified refs) with a "+N" overflow, so a user can
 * tell at a glance what an agent may call without ever seeing a raw slug or
 * UUID.
 *
 * `AgentToolRef.type` is an open string (ADR-041 retired the `skill` and
 * `agent` kinds but a legacy definition may still carry one), so an unknown
 * kind falls back to the generic tool icon and noun rather than crashing.
 */

/** Max named chips shown before collapsing the rest into a "+N" overflow chip. */
const MAX_NAMED_CHIPS = 4;

/** chat_ux_v2 cap — a tighter row asks for fewer named chips than the legacy strip. */
export const MAX_NAMED_CHIPS_V2 = 3;

type ToolKind = AgentToolRef["type"];

// Display order — MCP servers lead (a whole server is the coarser, more
// meaningful unit when scanning agents); individual capabilities trail. An
// unrecognised kind sorts last.
const KIND_ORDER: readonly ToolKind[] = ["mcp_server", "function"];

/**
 * Fold an unrecognised kind onto `function`. ADR-041 retired the `skill` and
 * `agent` kinds, but a legacy agent definition can still carry one; without
 * this the summary would emit two separate "N tools" segments (one per unknown
 * kind) for what the user reads as a single bucket.
 */
function normalizeKind(kind: ToolKind): ToolKind {
  return KIND_ORDER.includes(kind) ? kind : "function";
}

function kindIndex(kind: ToolKind): number {
  const i = KIND_ORDER.indexOf(normalizeKind(kind));
  return i === -1 ? KIND_ORDER.length : i;
}

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  mcp_server: Server,
  function: Wrench,
};

/** Singular/plural noun for a kind's count in the summary line. */
function kindNoun(kind: ToolKind, count: number): string {
  if (kind === "mcp_server") return "MCP";
  return count === 1 ? "tool" : "tools";
}

/**
 * Prettify a raw tool ref into a readable label: drop any namespace prefix
 * (`skills/foo`, `oxagen.repo.edit`), swap separators for spaces, and title-case
 * short slugs. Never returns an empty string.
 */
export function prettifyRef(ref: string): string {
  const tail = ref.split(/[/.:]/).filter(Boolean).pop() ?? ref;
  const words = tail
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  if (!words) return ref;
  return words
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface ToolRefSummary {
  /** Count per kind, in display order; kinds with zero are omitted. */
  counts: Array<{ kind: ToolKind; count: number }>;
  /** The summary line text, e.g. "2 MCP · 5 tools". */
  label: string;
  /** Total number of refs. */
  total: number;
}

/** Group + count tool refs into an ordered, human-readable summary. */
export function summarizeToolRefs(
  toolRefs: readonly AgentToolRef[],
): ToolRefSummary {
  const byKind = new Map<ToolKind, number>();
  for (const t of toolRefs) {
    const kind = normalizeKind(t.type);
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  const counts = [...byKind.entries()]
    .sort(([a], [b]) => kindIndex(a) - kindIndex(b))
    .map(([kind, count]) => ({ kind, count }));
  const label = counts
    .map(({ kind, count }) => `${count} ${kindNoun(kind, count)}`)
    .join(" · ");
  return { counts, label, total: toolRefs.length };
}

/** Ordered list of refs (MCP servers first) for the named-chip row. */
function orderedRefs(toolRefs: readonly AgentToolRef[]): AgentToolRef[] {
  return [...toolRefs].sort((a, b) => kindIndex(a.type) - kindIndex(b.type));
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_RE = /^[0-9A-Z]{26}$/;

/**
 * True when a raw ref reads as an opaque id (UUID, ULID, or a long
 * separator-free alphanumeric token like a nanoid) rather than a
 * human-readable slug. A chip built from one of these would leak a raw
 * id/UUID to the user, so chat_ux_v2 folds it into the overflow count
 * instead of ever rendering it as a named chip (see `CapabilityStrip`).
 */
export function looksLikeOpaqueId(ref: string): boolean {
  const tail = ref.split(/[/.:]/).filter(Boolean).pop() ?? ref;
  if (UUID_RE.test(tail) || ULID_RE.test(tail)) return true;
  return (
    tail.length >= 16 &&
    !/[-_\s]/.test(tail) &&
    /[0-9]/.test(tail) &&
    /[a-zA-Z]/.test(tail)
  );
}

export interface CapabilityStripProps {
  toolRefs: AgentToolRef[];
  /**
   * chat_ux_v2: caps named chips at `MAX_NAMED_CHIPS_V2` (vs. the legacy
   * `MAX_NAMED_CHIPS`), never surfaces a chip that looks like a raw id/UUID
   * (folded into the overflow count instead), and labels the overflow chip
   * "+N tools" rather than a bare "+N". Defaults to false — legacy render
   * stays byte-identical.
   */
  v2?: boolean;
  className?: string;
}

export function CapabilityStrip({
  toolRefs,
  v2 = false,
  className,
}: CapabilityStripProps) {
  if (toolRefs.length === 0) return null;

  const summary = summarizeToolRefs(toolRefs);
  const ordered = orderedRefs(toolRefs);
  const maxNamed = v2 ? MAX_NAMED_CHIPS_V2 : MAX_NAMED_CHIPS;
  // v2 never lets an opaque-id-looking ref become a named chip — it's
  // excluded from the eligible pool up front and simply counted in overflow.
  const eligible = v2
    ? ordered.filter((t) => !looksLikeOpaqueId(t.ref))
    : ordered;
  const named = eligible.slice(0, maxNamed);
  const overflow = ordered.length - named.length;

  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      <span className="text-[11px] leading-none text-muted-foreground">
        {summary.label}
      </span>
      {named.map((t, i) => {
        const Icon = KIND_ICON[t.type] ?? Wrench;
        return (
          <span
            key={`${t.type}:${t.ref}:${i}`}
            className="inline-flex max-w-[9rem] items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
            title={prettifyRef(t.ref)}
          >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{prettifyRef(t.ref)}</span>
          </span>
        );
      })}
      {overflow > 0 && (
        <span className="inline-flex items-center rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
          <Puzzle className="mr-1 size-3 shrink-0" />+{overflow}
          {v2 ? " tools" : ""}
        </span>
      )}
    </div>
  );
}
