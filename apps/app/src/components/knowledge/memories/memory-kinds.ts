/**
 * memory-kinds.ts — the shared AgentMemory taxonomy (kinds, weights, labels,
 * colours, icons).
 *
 * Kept in its own lightweight module so both the memories browser
 * (memories-client) and the bulk-import grid (memories-bulk-import) share ONE
 * source of truth without importing each other. memories-client renders the
 * CodeMirror-backed MarkdownCodeEditor and the Streamdown MarkdownContent; if
 * memories-bulk-import reached back into memories-client just for these
 * constants it would drag that entire heavy graph (and a circular import) into
 * its own module load — which is exactly what destabilised the bulk-import test
 * timing. Constants live here; components stay in their own files.
 */
import type { ComponentType } from "react";
import {
  RefreshCw,
  Lock,
  Bug,
  AlertTriangle,
  Zap,
  BadgeCheck,
  Eye,
  ShieldAlert,
} from "lucide-react";

export type MemoryWeight = "low" | "high" | "critical";
export type MemoryKind =
  | "routine-change"
  | "constraint"
  | "bug-root-cause"
  | "convention-deviation"
  | "gotcha";

export const KIND_CONFIG: Record<
  MemoryKind,
  {
    label: string;
    icon: ComponentType<{ className?: string }>;
    color: string;
  }
> = {
  "routine-change": {
    label: "Routine Change",
    icon: RefreshCw,
    color: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  },
  constraint: {
    label: "Constraint",
    icon: Lock,
    color: "bg-orange-500/15 text-orange-700 dark:text-orange-400",
  },
  "bug-root-cause": {
    label: "Bug Root Cause",
    icon: Bug,
    color: "bg-red-500/15 text-red-700 dark:text-red-400",
  },
  "convention-deviation": {
    label: "Convention Deviation",
    icon: AlertTriangle,
    color: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  gotcha: {
    label: "Gotcha",
    icon: Zap,
    color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
};

export const ALL_KINDS: MemoryKind[] = [
  "routine-change",
  "constraint",
  "bug-root-cause",
  "convention-deviation",
  "gotcha",
];

export const WEIGHT_CONFIG: Record<
  MemoryWeight,
  { label: string; color: string }
> = {
  low: {
    label: "Low",
    color: "bg-zinc-400/20 text-zinc-600 dark:text-zinc-400",
  },
  high: {
    label: "High",
    color: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  critical: {
    label: "Critical",
    color: "bg-red-500/15 text-red-700 dark:text-red-400",
  },
};

// ---------------------------------------------------------------------------
// Class (epistemic status) taxonomy — the primary axis of the memory model.
// Lives here (not in memories-client) for the same reason as the kinds above:
// memories-bulk-import needs it, and reaching back into memories-client for
// constants made the two components a circular import.
// ---------------------------------------------------------------------------

export type MemoryClass = "OBSERVATION" | "RULE" | "FACT";

export const ALL_CLASSES: MemoryClass[] = ["OBSERVATION", "RULE", "FACT"];

export const CLASS_CONFIG: Record<
  MemoryClass,
  { label: string; icon: ComponentType<{ className?: string }>; color: string }
> = {
  OBSERVATION: {
    label: "Observation",
    icon: Eye,
    color: "bg-zinc-400/20 text-zinc-600 dark:text-zinc-400",
  },
  RULE: {
    label: "Rule",
    icon: ShieldAlert,
    color: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  FACT: {
    label: "Fact",
    icon: BadgeCheck,
    color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
};

// Canonical content-domain kinds (agent.memory.model#RECOMMENDED_MEMORY_KINDS).
// memoryKind is an open string — these are suggestions, not a closed enum.
export const RECOMMENDED_MEMORY_KINDS = [
  "FEEDBACK",
  "PERFORMANCE",
  "STYLE",
  "PREFERENCE",
  "VOICE",
  "PROSE",
  "routine-change",
  "constraint",
  "bug-root-cause",
  "convention-deviation",
  "gotcha",
] as const;
