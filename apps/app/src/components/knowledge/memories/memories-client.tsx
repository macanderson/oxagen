"use client";

/**
 * MemoriesClient — AgentMemory browser for the Knowledge → Memories tab.
 *
 * Renders the list of :AgentMemory nodes written to Neo4j by agent.memory.write,
 * on the two-axis memory model (see docs/specs/two-axis-memory/DESIGN.md):
 *   - memoryClass: epistemic status — OBSERVATION → RULE → FACT
 *   - memoryKind: content domain (open string; recommended set + free text)
 *   - confidenceScore (0-100): evidence measure, auto-decays
 *   - enforcementScore (1-100 | null): policy strength; null for OBSERVATION,
 *     1-100 for RULE, always 100 for FACT
 *
 * Features:
 * - Filter by class, kind, min-confidence slider, text search
 * - Row: lesson (primary), kind badge, class badge, confidence bar, createdAt, source, nodeRef
 * - "Suggested to promote" panel: top OBSERVATIONs by citation pressure, with a
 *   one-click inline promote flow
 * - Click a row to open a detail sheet with all metadata
 * - Detail sheet: edit lesson/kind/confidence/enforcement/source/status via
 *   updateMemory action; promote OBSERVATION → RULE/FACT via promoteMemory
 * - Detail sheet: delete with a two-step confirm via deleteMemory action
 * - Stats row with per-class counts
 * - Empty state with helpful guidance
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  Bug,
  BrainCircuit,
  ChevronRight,
  Clock,
  Copy,
  Filter,
  FileText,
  Fingerprint,
  Gauge,
  Heart,
  Lock,
  Mic,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  X,
  Zap,
  MessageSquare,
  ArrowUpDown,
  Quote,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { MarkdownCodeEditor } from "@/components/ui/markdown-code-editor";
import { MarkdownContent } from "@/components/ui/markdown-content";
import { TruncatedText } from "@/components/ui/truncated-text";
import { MemoriesBulkImport, type DraftMemory } from "./memories-bulk-import";
import { RationalePicker, type SuggestRationalesFn } from "./rationale-picker";
// Shared kind/weight/class taxonomy lives in its own lightweight module (see
// memory-kinds.ts) so the bulk-import grid can reuse it without importing this
// CodeMirror-laden component. Re-exported here for existing consumers.
export {
  ALL_KINDS,
  KIND_CONFIG,
  WEIGHT_CONFIG,
  ALL_CLASSES,
  CLASS_CONFIG,
  RECOMMENDED_MEMORY_KINDS,
  type MemoryKind,
  type MemoryWeight,
  type MemoryClass,
} from "./memory-kinds";
import {
  ALL_CLASSES,
  CLASS_CONFIG,
  RECOMMENDED_MEMORY_KINDS,
  type MemoryClass,
} from "./memory-kinds";

// ---------------------------------------------------------------------------
// Types — structural mirror of AgentMemoryRecord from
// @oxagen/oxagen/contracts/agent.memory.list (agent.memory.model is the single
// source of truth). Mirrored locally rather than imported so this "use client"
// file never pulls the server contracts/zod bundle in — see agent.memory.model.
// ---------------------------------------------------------------------------

export type MemoryStatus = "ACTIVE" | "SUPERSEDED" | "RETRACTED" | "ARCHIVED";
type ActorKind = "AGENT" | "USER" | "SYSTEM";

export interface AgentMemoryRecord {
  id: string;
  publicId: string;
  nodeRef: string;
  memoryClass: MemoryClass;
  memoryKind: string;
  lesson: string;
  source: string;
  /** 0-100. Evidence measure; auto-decays. */
  confidenceScore: number;
  /** 1-100 for RULE, 100 for FACT, null for OBSERVATION. */
  enforcementScore: number | null;
  status: MemoryStatus;
  subjectHint: string;
  halfLifeDays: number;
  decayFloor: number;
  lastEvidenceAt: string | null;
  citationCount: number;
  influenceCount: number;
  violationCount: number;
  createdByKind: ActorKind;
  createdById: string | null;
  confirmedByKind: ActorKind | null;
  confirmedById: string | null;
  createdAt: string;
  lastReinforcedAt: string | null;
}

/** A promotion candidate from agent.memory.promotion.candidates — a slimmer
 * projection than the full record (id/lesson/kind + the citation-pressure
 * signals that make it a candidate). */
export interface PromotionCandidate {
  id: string;
  publicId: string;
  lesson: string;
  memoryKind: string;
  citationCount: number;
  influenceCount: number;
  confidenceScore: number;
}

// Action result shapes (structural mirror of the server action exports — avoids
// importing "use server" functions into client code; TS checks structurally).
type CreateMemoryResult =
  | { ok: true; memory: AgentMemoryRecord }
  | { ok: false; error: string };

type UpdateMemoryResult =
  | { ok: true; memory: AgentMemoryRecord }
  | { ok: false; error: string };

type DeleteMemoryResult = { ok: true } | { ok: false; error: string };

type PromoteMemoryResult =
  | { ok: true; memory: AgentMemoryRecord }
  | { ok: false; error: string };

type PromoteMemoryInput = {
  orgSlug: string;
  workspaceSlug: string;
  memoryId: string;
  toClass: "RULE" | "FACT";
  enforcementScore?: number;
  rationale?: string;
};

type DismissPromotionResult =
  | { ok: true; memoryId: string; dismissed: boolean }
  | { ok: false; error: string };

type DemoteMemoryResult =
  | { ok: true; memory: AgentMemoryRecord }
  | { ok: false; error: string };

type DemoteMemoryInput = {
  orgSlug: string;
  workspaceSlug: string;
  memoryId: string;
  toClass: "RULE" | "OBSERVATION";
  enforcementScore?: number;
  rationale?: string;
};

type PromotionCandidatesResult =
  | { ok: true; candidates: PromotionCandidate[] }
  | { ok: false; error: string };

interface MemoriesClientProps {
  initialRecords: AgentMemoryRecord[];
  total: number;
  orgId: string;
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  /**
   * Server action for adding a manual one-off memory. Passed from
   * MemoriesSection as a server action ref. When absent the "New Memory"
   * affordance is not rendered. `memoryKind`/`memoryClass` are optional —
   * omitting them lets the agent.memory.remember classifier infer them from
   * the lesson. FACT is intentionally not offered here — it requires human
   * confirmation and is reserved for the dedicated promote flow.
   */
  createMemory?: (input: {
    orgSlug: string;
    workspaceSlug: string;
    text: string;
    memoryKind?: string;
    memoryClass?: "OBSERVATION" | "RULE";
    enforcementScore?: number;
  }) => Promise<CreateMemoryResult>;
  /**
   * Server action for editing a memory. Passed from MemoriesSection (server
   * component) so it crosses the RSC → client boundary as a server action ref.
   * When absent the edit affordance is not rendered. Class changes are NOT
   * exposed here — they go through `promoteMemory`.
   */
  updateMemory?: (input: {
    orgSlug: string;
    workspaceSlug: string;
    memoryId: string;
    lesson?: string;
    memoryKind?: string;
    source?: string;
    confidenceScore?: number;
    enforcementScore?: number;
    status?: MemoryStatus;
  }) => Promise<UpdateMemoryResult>;
  /**
   * Server action for deleting a memory. When absent the delete affordance is
   * not rendered.
   */
  deleteMemory?: (input: {
    orgSlug: string;
    workspaceSlug: string;
    memoryId: string;
  }) => Promise<DeleteMemoryResult>;
  /**
   * Server action for promoting a memory up the confidence ladder
   * (OBSERVATION → RULE/FACT, or RULE → FACT). When absent the promote
   * affordance is not rendered.
   */
  promoteMemory?: (input: PromoteMemoryInput) => Promise<PromoteMemoryResult>;
  /**
   * Server action for dismissing (or, with restore:true, restoring) a
   * candidate from the "suggested to promote" panel. When absent no Dismiss
   * affordance is rendered on candidate rows.
   */
  dismissPromotion?: (input: {
    orgSlug: string;
    workspaceSlug: string;
    memoryId: string;
    restore?: boolean;
  }) => Promise<DismissPromotionResult>;
  /**
   * Server action for demoting a memory down the confidence ladder
   * (FACT → RULE/OBSERVATION, RULE → OBSERVATION). When absent the Demote
   * affordance is not rendered in the detail sheet.
   */
  demoteMemory?: (input: DemoteMemoryInput) => Promise<DemoteMemoryResult>;
  /**
   * Server action drafting candidate rationales for the RationalePicker
   * select used by the promote/demote flows. When absent every rationale
   * field falls back to a plain optional textarea.
   */
  suggestRationales?: SuggestRationalesFn;
  /**
   * Server action for the "suggested to promote" panel — the top OBSERVATIONs
   * by citation pressure. When absent the panel is not rendered.
   */
  promotionCandidates?: (input: {
    orgSlug: string;
    workspaceSlug: string;
    limit?: number;
  }) => Promise<PromotionCandidatesResult>;
  /**
   * Server action for stage 1 of bulk import — parse uploaded markdown into
   * editable draft memories (read-only). Paired with `commitImport`; when both
   * are present the "Bulk Import" affordance is rendered.
   */
  parseImport?: (input: {
    orgSlug: string;
    workspaceSlug: string;
    documents: { filename: string; content: string }[];
    defaultNodeRef?: string;
  }) => Promise<
    | {
        ok: true;
        drafts: DraftMemory[];
        documentCount: number;
        skipped: { filename: string; reason: string }[];
      }
    | { ok: false; error: string }
  >;
  /**
   * Server action for stage 2 of bulk import — write the confirmed drafts into
   * the AgentMemory graph with per-item error capture.
   */
  commitImport?: (input: {
    orgSlug: string;
    workspaceSlug: string;
    drafts: DraftMemory[];
  }) => Promise<
    | {
        ok: true;
        results: {
          lesson: string;
          ok: boolean;
          memoryId: string | null;
          error: string | null;
        }[];
        imported: number;
        failed: number;
      }
    | { ok: false; error: string }
  >;
}

// ---------------------------------------------------------------------------
// Kind configuration helper
// ---------------------------------------------------------------------------

const KIND_CONFIG: Record<
  string,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    color: string;
  }
> = {
  FEEDBACK: {
    label: "Feedback",
    icon: MessageSquare,
    color: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
  },
  PERFORMANCE: {
    label: "Performance",
    icon: Gauge,
    color: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400",
  },
  STYLE: {
    label: "Style",
    icon: Palette,
    color: "bg-pink-500/15 text-pink-700 dark:text-pink-400",
  },
  PREFERENCE: {
    label: "Preference",
    icon: Heart,
    color: "bg-rose-500/15 text-rose-700 dark:text-rose-400",
  },
  VOICE: {
    label: "Voice",
    icon: Mic,
    color: "bg-violet-500/15 text-violet-700 dark:text-violet-400",
  },
  PROSE: {
    label: "Prose",
    icon: FileText,
    color: "bg-teal-500/15 text-teal-700 dark:text-teal-400",
  },
  "routine-change": {
    label: "Routine Change",
    icon: RefreshCw,
    color: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  },
  constraint: {
    label: "Constraint",
    icon: Lock,
    color: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
  },
  "bug-root-cause": {
    label: "Bug Root Cause",
    icon: Bug,
    color: "bg-red-500/15 text-red-700 dark:text-red-400",
  },
  "convention-deviation": {
    label: "Convention Deviation",
    icon: ShieldAlert,
    color: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  gotcha: {
    label: "Gotcha",
    icon: Zap,
    color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
};

export function getKindConfig(kind: string): (typeof KIND_CONFIG)[string] {
  return (
    KIND_CONFIG[kind] ?? {
      label: kind,
      icon: BrainCircuit,
      color: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
    }
  );
}

/** The next rung(s) up the confidence ladder a memory can be promoted to. */
function nextClassTargets(current: MemoryClass): Array<"RULE" | "FACT"> {
  if (current === "OBSERVATION") return ["RULE", "FACT"];
  if (current === "RULE") return ["FACT"];
  return [];
}

/** The rung(s) down the confidence ladder a memory can be demoted to. */
function nextDemoteTargets(
  current: MemoryClass,
): Array<"RULE" | "OBSERVATION"> {
  if (current === "FACT") return ["RULE", "OBSERVATION"];
  if (current === "RULE") return ["OBSERVATION"];
  return [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function truncateId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** A 0-100 score meter — used for both confidenceScore and enforcementScore. */
function ScoreMeter({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  const pct = Math.round(clamped);
  const barColor =
    clamped >= 70
      ? "bg-emerald-500"
      : clamped >= 40
        ? "bg-amber-500"
        : "bg-zinc-400";
  return (
    <div className="flex items-center gap-1.5">
      <div
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} ${pct}%`}
        className="h-1.5 w-16 rounded-full bg-muted overflow-hidden"
      >
        <div
          className={`h-full rounded-full ${barColor} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground">
        {pct}%
      </span>
    </div>
  );
}

function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = React.useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={id}
      className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground hover:text-foreground transition-colors"
    >
      <Fingerprint className="h-2.5 w-2.5" />
      {copied ? "copied!" : truncateId(id)}
      <Copy className="h-2.5 w-2.5 opacity-50" />
    </button>
  );
}

/** Datalist-backed free-text input for the open-string memoryKind field —
 * surfaces the recommended kinds as suggestions without closing the taxonomy. */
function KindInput({
  id,
  value,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const listId = `${id}-options`;
  return (
    <>
      <input
        id={id}
        type="text"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={64}
        disabled={disabled}
        aria-label="Memory kind"
        placeholder="e.g. constraint, gotcha, PREFERENCE…"
        className={FIELD_INPUT_CLS}
      />
      <datalist id={listId}>
        {RECOMMENDED_MEMORY_KINDS.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </>
  );
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

/** Ordering axes offered by the memories browser (mirrors agent.memory.list). */
type MemorySort = "createdAt" | "citationCount";

const SORT_LABELS: Record<MemorySort, string> = {
  createdAt: "Newest first",
  citationCount: "Most cited",
};

function FilterBar({
  availableKinds,
  activeKinds,
  toggleKind,
  activeClasses,
  toggleClass,
  searchQuery,
  setSearchQuery,
  minConfidence,
  setMinConfidence,
  minCitations,
  setMinCitations,
  sortBy,
  setSortBy,
}: {
  availableKinds: string[];
  activeKinds: Set<string>;
  toggleKind: (k: string) => void;
  activeClasses: Set<MemoryClass>;
  toggleClass: (c: MemoryClass) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  minConfidence: number;
  setMinConfidence: (v: number) => void;
  minCitations: number;
  setMinCitations: (v: number) => void;
  sortBy: MemorySort;
  setSortBy: (v: MemorySort) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {/* Search + confidence slider */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search lesson, source, or node ref..."
            aria-label="Search memories"
            className="w-full rounded-md border border-border/60 bg-background py-1.5 pl-8 pr-8 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {searchQuery && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <label
            htmlFor="min-confidence"
            className="text-[11px] text-muted-foreground whitespace-nowrap"
          >
            Min confidence
          </label>
          <input
            id="min-confidence"
            type="range"
            min="0"
            max="100"
            value={minConfidence}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
            className="h-1 w-20 cursor-pointer accent-primary"
          />
          <span className="text-[10px] tabular-nums text-muted-foreground w-7">
            {minConfidence}%
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Quote className="h-3.5 w-3.5 text-muted-foreground" />
          <label
            htmlFor="min-citations"
            className="text-[11px] text-muted-foreground whitespace-nowrap"
          >
            Min citations
          </label>
          <input
            id="min-citations"
            type="number"
            min="0"
            step="1"
            value={minCitations}
            onChange={(e) =>
              setMinCitations(
                Math.max(0, Math.floor(Number(e.target.value) || 0)),
              )
            }
            aria-label="Minimum number of citations"
            className="h-6 w-14 rounded-md border border-border/60 bg-background px-1.5 text-[11px] tabular-nums focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="flex items-center gap-2">
          <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          <label
            htmlFor="sort-by"
            className="text-[11px] text-muted-foreground whitespace-nowrap"
          >
            Sort
          </label>
          <select
            id="sort-by"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as MemorySort)}
            aria-label="Sort memories"
            className="h-6 rounded-md border border-border/60 bg-background px-1.5 text-[11px] focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {(Object.keys(SORT_LABELS) as MemorySort[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Class filter chips — the primary epistemic axis */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {ALL_CLASSES.map((cls) => {
          const cfg = CLASS_CONFIG[cls];
          const active = activeClasses.has(cls);
          const Icon = cfg.icon;
          return (
            <button
              key={cls}
              type="button"
              aria-pressed={active}
              aria-label={`Filter by ${cfg.label}`}
              onClick={() => toggleClass(cls)}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all border ${
                active
                  ? `${cfg.color} border-current/20`
                  : "bg-muted/40 text-muted-foreground border-transparent hover:bg-muted"
              }`}
            >
              <Icon className="h-3 w-3" />
              {cfg.label}
            </button>
          );
        })}
      </div>

      {/* Kind filter chips — dynamic, since memoryKind is an open string */}
      {availableKinds.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {availableKinds.map((kind) => {
            const cfg = getKindConfig(kind);
            const active = activeKinds.has(kind);
            const Icon = cfg.icon;
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={active}
                aria-label={`Filter by ${cfg.label}`}
                onClick={() => toggleKind(kind)}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all border ${
                  active
                    ? `${cfg.color} border-current/20`
                    : "bg-muted/40 text-muted-foreground border-transparent hover:bg-muted"
                }`}
              >
                <Icon className="h-3 w-3" />
                {cfg.label}
              </button>
            );
          })}
          {activeKinds.size > 0 && (
            <button
              type="button"
              onClick={() => {
                for (const k of availableKinds) {
                  if (activeKinds.has(k)) toggleKind(k);
                }
              }}
              className="text-[10px] text-muted-foreground hover:text-foreground ml-1"
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory row
// ---------------------------------------------------------------------------

function MemoryRow({
  record,
  onSelect,
}: {
  record: AgentMemoryRecord;
  onSelect: () => void;
}) {
  const kindCfg = getKindConfig(record.memoryKind);
  const classCfg = CLASS_CONFIG[record.memoryClass];
  const KindIcon = kindCfg.icon;

  function handleRowKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  }

  return (
    // NOTE: this row used to be a native <button>, but the lesson preview
    // below (TruncatedText) renders its own popover-trigger <button> when the
    // text overflows — a <button> inside a <button> is invalid HTML and
    // breaks a11y semantics. Instead the row is a role="button" div (click +
    // Enter/Space still open the detail sheet), and the lesson preview's
    // wrapper stops click propagation so clicking the "…" reveal doesn't also
    // select the row underneath it.
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleRowKeyDown}
      className="flex w-full items-start gap-3 border-b border-border/30 px-4 py-3 text-left transition-colors hover:bg-muted/40 last:border-b-0 group cursor-pointer"
    >
      {/* Kind icon */}
      <div className={`mt-0.5 flex-shrink-0 rounded-md p-1.5 ${kindCfg.color}`}>
        <KindIcon className="h-3.5 w-3.5" />
      </div>

      {/* Content */}
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        {/* Lesson (primary text) — stop propagation so the reveal popover's
            trigger button doesn't also fire the row's onSelect. */}
        <div onClick={(event) => event.stopPropagation()} className="min-w-0">
          <TruncatedText
            text={record.lesson}
            lines={2}
            className="text-sm text-foreground leading-snug"
          />
        </div>

        {/* Badges row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge
            className={`${kindCfg.color} text-[10px] px-1.5 py-0 border-0 font-medium`}
          >
            {kindCfg.label}
          </Badge>
          <Badge
            className={`${classCfg.color} text-[10px] px-1.5 py-0 border-0 font-medium`}
          >
            {classCfg.label}
          </Badge>
          {record.enforcementScore != null && (
            <span className="text-[10px] text-muted-foreground">
              enforcement {record.enforcementScore}
            </span>
          )}
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" />
            {formatRelativeTime(record.createdAt)}
          </span>
          <span className="truncate max-w-[160px]" title={record.source}>
            {record.source}
          </span>
          {record.nodeRef && (
            <span
              className="font-mono truncate max-w-[120px]"
              title={record.nodeRef}
            >
              {record.nodeRef}
            </span>
          )}
        </div>
      </div>

      {/* Confidence + arrow */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <ScoreMeter value={record.confidenceScore} label="Confidence" />
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Promote flow — shared between the detail sheet and the candidates panel
// ---------------------------------------------------------------------------

function PromoteFlow({
  memoryId,
  currentClass,
  orgSlug,
  workspaceSlug,
  promoteMemory,
  suggestRationales,
  onPromoted,
  onCancelAll,
}: {
  memoryId: string;
  currentClass: MemoryClass;
  orgSlug: string;
  workspaceSlug: string;
  promoteMemory: (input: PromoteMemoryInput) => Promise<PromoteMemoryResult>;
  suggestRationales?: SuggestRationalesFn;
  onPromoted: (updated: AgentMemoryRecord) => void;
  /** Called when the whole flow is dismissed without promoting (candidates panel removes its inline form). */
  onCancelAll?: () => void;
}) {
  const targets = nextClassTargets(currentClass);
  const [target, setTarget] = React.useState<"RULE" | "FACT" | null>(null);
  const [enforcementScore, setEnforcementScore] = React.useState(50);
  const [rationale, setRationale] = React.useState("");
  const [factConfirmed, setFactConfirmed] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  if (targets.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        FACT is the top of the confidence ladder — nothing left to promote to.
      </p>
    );
  }

  function cancel() {
    setTarget(null);
    setFactConfirmed(false);
    setError(null);
    onCancelAll?.();
  }

  function confirmPromote() {
    if (!target) return;
    if (target === "FACT" && !factConfirmed) {
      setError("Confirm this is a durable, org-wide fact before promoting.");
      return;
    }
    setError(null);
    const trimmedRationale = rationale.trim();
    startTransition(async () => {
      const result = await promoteMemory({
        orgSlug,
        workspaceSlug,
        memoryId,
        toClass: target,
        ...(target === "RULE" ? { enforcementScore } : {}),
        ...(trimmedRationale ? { rationale: trimmedRationale } : {}),
      });
      if (result.ok) {
        onPromoted(result.memory);
      } else {
        setError(result.error);
      }
    });
  }

  if (!target) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        {targets.map((t) => (
          <Button
            key={t}
            size="sm"
            variant="outline"
            onClick={() => {
              setTarget(t);
              setEnforcementScore(50);
              setRationale("");
              setFactConfirmed(false);
              setError(null);
            }}
          >
            <ArrowUpCircle className="h-3 w-3 mr-1.5" aria-hidden="true" />
            Promote to {CLASS_CONFIG[t].label}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border/60 p-3">
      <p className="text-xs font-medium text-foreground">
        Promote to {CLASS_CONFIG[target].label}
      </p>

      {target === "RULE" ? (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`promote-enforcement-${memoryId}`}
            className="text-[11px] text-muted-foreground"
          >
            Enforcement:{" "}
            <span className="tabular-nums">{enforcementScore}</span>
          </label>
          <input
            id={`promote-enforcement-${memoryId}`}
            type="range"
            min="1"
            max="100"
            value={enforcementScore}
            onChange={(e) => setEnforcementScore(Number(e.target.value))}
            disabled={isPending}
            aria-label="Enforcement score"
            className="h-1 w-full cursor-pointer accent-primary"
          />
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
          <input
            id={`promote-fact-confirm-${memoryId}`}
            type="checkbox"
            checked={factConfirmed}
            onChange={(e) => setFactConfirmed(e.target.checked)}
            disabled={isPending}
            className="mt-0.5"
          />
          <label
            htmlFor={`promote-fact-confirm-${memoryId}`}
            className="text-[11px] text-foreground"
          >
            I confirm this is a durable, org-wide fact — always fully enforced
            (100) and human-confirmed, not just policy. This cannot be casually
            undone.
          </label>
        </div>
      )}

      <RationalePicker
        idPrefix={`promote-${memoryId}`}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        memoryId={memoryId}
        toClass={target}
        value={rationale}
        onChange={setRationale}
        disabled={isPending}
        suggestRationales={suggestRationales}
      />

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="gradient"
          onClick={confirmPromote}
          disabled={isPending || (target === "FACT" && !factConfirmed)}
        >
          {isPending
            ? "Promoting…"
            : `Confirm promote to ${CLASS_CONFIG[target].label}`}
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Demote flow — the inverse of PromoteFlow. Lives only in the detail sheet
// (FACT/RULE memories), so unlike PromoteFlow it doesn't need an
// onCancelAll — there's no inline candidates-panel equivalent for demotion.
// ---------------------------------------------------------------------------

function DemoteFlow({
  memoryId,
  currentClass,
  orgSlug,
  workspaceSlug,
  demoteMemory,
  suggestRationales,
  onDemoted,
}: {
  memoryId: string;
  currentClass: MemoryClass;
  orgSlug: string;
  workspaceSlug: string;
  demoteMemory: (input: DemoteMemoryInput) => Promise<DemoteMemoryResult>;
  suggestRationales?: SuggestRationalesFn;
  onDemoted: (updated: AgentMemoryRecord) => void;
}) {
  const targets = nextDemoteTargets(currentClass);
  const [target, setTarget] = React.useState<"RULE" | "OBSERVATION" | null>(
    null,
  );
  const [enforcementScore, setEnforcementScore] = React.useState(50);
  const [rationale, setRationale] = React.useState("");
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  if (targets.length === 0) return null;

  function cancel() {
    setTarget(null);
    setError(null);
  }

  function confirmDemote() {
    if (!target) return;
    setError(null);
    const trimmedRationale = rationale.trim();
    startTransition(async () => {
      const result = await demoteMemory({
        orgSlug,
        workspaceSlug,
        memoryId,
        toClass: target,
        ...(target === "RULE" ? { enforcementScore } : {}),
        ...(trimmedRationale ? { rationale: trimmedRationale } : {}),
      });
      if (result.ok) {
        setTarget(null);
        onDemoted(result.memory);
      } else {
        setError(result.error);
      }
    });
  }

  if (!target) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        {targets.map((t) => (
          <Button
            key={t}
            size="sm"
            variant="outline"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => {
              setTarget(t);
              setEnforcementScore(50);
              setRationale("");
              setError(null);
            }}
          >
            <ArrowDownCircle className="h-3 w-3 mr-1.5" aria-hidden="true" />
            Demote to {CLASS_CONFIG[t].label}
          </Button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
      <p className="text-xs font-medium text-foreground">
        Demote to {CLASS_CONFIG[target].label}
      </p>

      {target === "RULE" && (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`demote-enforcement-${memoryId}`}
            className="text-[11px] text-muted-foreground"
          >
            Enforcement:{" "}
            <span className="tabular-nums">{enforcementScore}</span>
          </label>
          <input
            id={`demote-enforcement-${memoryId}`}
            type="range"
            min="1"
            max="100"
            value={enforcementScore}
            onChange={(e) => setEnforcementScore(Number(e.target.value))}
            disabled={isPending}
            aria-label="Enforcement score"
            className="h-1 w-full cursor-pointer accent-primary"
          />
        </div>
      )}

      <RationalePicker
        idPrefix={`demote-${memoryId}`}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        memoryId={memoryId}
        toClass={target}
        value={rationale}
        onChange={setRationale}
        disabled={isPending}
        suggestRationales={suggestRationales}
      />

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="destructive"
          onClick={confirmDemote}
          disabled={isPending}
        >
          {isPending
            ? "Demoting…"
            : `Confirm demote to ${CLASS_CONFIG[target].label}`}
        </Button>
        <Button size="sm" variant="ghost" onClick={cancel} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Suggested-to-promote panel — top OBSERVATIONs by citation pressure
// ---------------------------------------------------------------------------

function PromotionCandidatesPanel({
  candidates,
  orgSlug,
  workspaceSlug,
  promoteMemory,
  dismissPromotion,
  suggestRationales,
  onPromoted,
  onDismissed,
}: {
  candidates: PromotionCandidate[];
  orgSlug: string;
  workspaceSlug: string;
  promoteMemory: (input: PromoteMemoryInput) => Promise<PromoteMemoryResult>;
  dismissPromotion?: MemoriesClientProps["dismissPromotion"];
  suggestRationales?: SuggestRationalesFn;
  onPromoted: (updated: AgentMemoryRecord) => void;
  /** Bubble a dismiss up to MemoriesClient, which owns candidate state + the undo toast. */
  onDismissed?: (candidate: PromotionCandidate) => void;
}) {
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  if (candidates.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="flex items-center gap-1.5">
        <Sparkles
          className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
          Suggested to promote
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {candidates.map((c) => (
          <li
            key={c.id}
            className="flex flex-col gap-1.5 rounded-md bg-background/60 p-2"
          >
            <div className="flex items-center justify-between gap-2">
              <TruncatedText
                text={c.lesson}
                lines={1}
                className="text-xs text-foreground flex-1"
              />
              {expandedId !== c.id && (
                <div className="flex flex-shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setExpandedId(c.id)}
                    aria-label={`Promote candidate: ${c.lesson}`}
                  >
                    <ArrowUpCircle
                      className="h-3 w-3 mr-1.5"
                      aria-hidden="true"
                    />
                    Promote
                  </Button>
                  {dismissPromotion && onDismissed && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onDismissed(c)}
                      aria-label={`Dismiss candidate: ${c.lesson}`}
                    >
                      Dismiss
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <Badge
                className={`${getKindConfig(c.memoryKind).color} text-[10px] px-1.5 py-0 border-0 font-medium`}
              >
                {getKindConfig(c.memoryKind).label}
              </Badge>
              <span>
                {c.citationCount} citation{c.citationCount === 1 ? "" : "s"}
              </span>
              <span>{c.influenceCount} influential</span>
              <span>{Math.round(c.confidenceScore)}% confidence</span>
            </div>
            {expandedId === c.id && (
              <PromoteFlow
                memoryId={c.id}
                currentClass="OBSERVATION"
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                promoteMemory={promoteMemory}
                suggestRationales={suggestRationales}
                onPromoted={(updated) => {
                  setExpandedId(null);
                  onPromoted(updated);
                }}
                onCancelAll={() => setExpandedId(null)}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory detail sheet (view + edit + delete-confirm modes)
// ---------------------------------------------------------------------------

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium text-muted-foreground">
        {label}
      </span>
      <span className="text-xs text-foreground break-all">{value}</span>
    </div>
  );
}

const SECTION_LABEL_CLS =
  "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground";

const FIELD_INPUT_CLS =
  "w-full rounded-md border border-border/60 bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50";

function MemoryDetail({
  record: initialRecord,
  orgSlug,
  workspaceSlug,
  onClose,
  onUpdated,
  onDeleted,
  updateMemory,
  deleteMemory,
  promoteMemory,
  demoteMemory,
  suggestRationales,
}: {
  record: AgentMemoryRecord;
  orgSlug: string;
  workspaceSlug: string;
  onClose: () => void;
  /** Called after a successful update with the new record shape. */
  onUpdated: (updated: AgentMemoryRecord) => void;
  /** Called after a successful delete with the deleted memory's id. */
  onDeleted: (memoryId: string) => void;
  updateMemory?: MemoriesClientProps["updateMemory"];
  deleteMemory?: MemoriesClientProps["deleteMemory"];
  promoteMemory?: MemoriesClientProps["promoteMemory"];
  demoteMemory?: MemoriesClientProps["demoteMemory"];
  suggestRationales?: SuggestRationalesFn;
}) {
  // Local record state — updated optimistically on a successful save.
  const [record, setRecord] = React.useState(initialRecord);
  const [mode, setMode] = React.useState<"view" | "edit">("view");
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  // Edit form state — reset to current record when entering edit mode.
  const [editLesson, setEditLesson] = React.useState(record.lesson);
  const [editKind, setEditKind] = React.useState(record.memoryKind);
  const [editConfidence, setEditConfidence] = React.useState(
    record.confidenceScore,
  );
  const [editEnforcement, setEditEnforcement] = React.useState(
    record.enforcementScore ?? 50,
  );
  const [editSource, setEditSource] = React.useState(record.source);

  const kindCfg = getKindConfig(record.memoryKind);
  const classCfg = CLASS_CONFIG[record.memoryClass];

  function enterEdit() {
    // Sync form fields to the current (potentially already-updated) record.
    setEditLesson(record.lesson);
    setEditKind(record.memoryKind);
    setEditConfidence(record.confidenceScore);
    setEditEnforcement(record.enforcementScore ?? 50);
    setEditSource(record.source);
    setError(null);
    setConfirmDelete(false);
    setMode("edit");
  }

  function cancelEdit() {
    setMode("view");
    setError(null);
  }

  function handleSave() {
    if (!updateMemory) return;

    // Collect only changed fields so we don't send no-op patches.
    const updates: {
      lesson?: string;
      memoryKind?: string;
      confidenceScore?: number;
      enforcementScore?: number;
      source?: string;
    } = {};

    const trimmedLesson = editLesson.trim();
    if (trimmedLesson !== record.lesson && trimmedLesson.length > 0) {
      updates.lesson = trimmedLesson;
    }
    const trimmedKind = editKind.trim();
    if (trimmedKind !== record.memoryKind && trimmedKind.length > 0) {
      updates.memoryKind = trimmedKind;
    }
    if (Math.abs(editConfidence - record.confidenceScore) > 0.5) {
      updates.confidenceScore = editConfidence;
    }
    // Enforcement is only editable for RULE — OBSERVATION has none, FACT is
    // always forced to 100 by the class invariant.
    if (
      record.memoryClass === "RULE" &&
      editEnforcement !== (record.enforcementScore ?? 50)
    ) {
      updates.enforcementScore = editEnforcement;
    }
    const trimmedSource = editSource.trim();
    if (trimmedSource !== record.source && trimmedSource.length > 0) {
      updates.source = trimmedSource;
    }

    if (Object.keys(updates).length === 0) {
      // Nothing changed — exit edit mode silently.
      setMode("view");
      return;
    }

    setError(null);
    startTransition(async () => {
      const result = await updateMemory({
        orgSlug,
        workspaceSlug,
        memoryId: record.id,
        ...updates,
      });

      if (result.ok) {
        // Optimistic update: show new values immediately.
        setRecord(result.memory);
        setMode("view");
        onUpdated(result.memory);
      } else {
        setError(result.error);
      }
    });
  }

  function handleDelete() {
    if (!deleteMemory) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteMemory({
        orgSlug,
        workspaceSlug,
        memoryId: record.id,
      });

      if (result.ok) {
        onDeleted(record.id);
        onClose();
      } else {
        setConfirmDelete(false);
        setError(result.error);
      }
    });
  }

  function handlePromoted(updated: AgentMemoryRecord) {
    setRecord(updated);
    onUpdated(updated);
  }

  function handleDemoted(updated: AgentMemoryRecord) {
    setRecord(updated);
    onUpdated(updated);
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full max-w-lg overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2">
            <Badge className={kindCfg.color}>{kindCfg.label}</Badge>
            <Badge className={classCfg.color}>{classCfg.label}</Badge>
          </SheetTitle>
          <SheetDescription className="text-xs font-mono break-all text-muted-foreground">
            {record.publicId}
          </SheetDescription>
        </SheetHeader>

        {mode === "view" ? (
          /* ── View mode ─────────────────────────────────────────────────── */
          <div className="flex flex-col gap-5">
            {/* Lesson */}
            <div className="flex flex-col gap-1.5">
              <h3 className={SECTION_LABEL_CLS}>Lesson</h3>
              <MarkdownContent>{record.lesson}</MarkdownContent>
            </div>

            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-3">
              <MetaField label="Kind" value={kindCfg.label} />
              <MetaField label="Class" value={classCfg.label} />
              <MetaField
                label="Confidence"
                value={`${Math.round(record.confidenceScore)}%`}
              />
              <MetaField
                label="Enforcement"
                value={
                  record.enforcementScore == null
                    ? "—"
                    : `${record.enforcementScore}`
                }
              />
              <MetaField
                label="Created"
                value={new Date(record.createdAt).toLocaleString()}
              />
              {record.lastReinforcedAt && (
                <MetaField
                  label="Last Reinforced"
                  value={new Date(record.lastReinforcedAt).toLocaleString()}
                />
              )}
              <MetaField label="Source" value={record.source} />
              {record.nodeRef && (
                <MetaField label="Node Ref" value={record.nodeRef} />
              )}
              <MetaField
                label="Citations"
                value={`${record.citationCount} (${record.influenceCount} influential, ${record.violationCount} violations)`}
              />
            </div>

            {/* Promote */}
            {promoteMemory && (
              <div className="flex flex-col gap-2">
                <h3 className={SECTION_LABEL_CLS}>Promote</h3>
                <PromoteFlow
                  memoryId={record.id}
                  currentClass={record.memoryClass}
                  orgSlug={orgSlug}
                  workspaceSlug={workspaceSlug}
                  promoteMemory={promoteMemory}
                  suggestRationales={suggestRationales}
                  onPromoted={handlePromoted}
                />
              </div>
            )}

            {/* Demote — RULE and FACT only; OBSERVATION is the bottom rung */}
            {demoteMemory && record.memoryClass !== "OBSERVATION" && (
              <div className="flex flex-col gap-2">
                <h3 className={SECTION_LABEL_CLS}>Demote</h3>
                <DemoteFlow
                  memoryId={record.id}
                  currentClass={record.memoryClass}
                  orgSlug={orgSlug}
                  workspaceSlug={workspaceSlug}
                  demoteMemory={demoteMemory}
                  suggestRationales={suggestRationales}
                  onDemoted={handleDemoted}
                />
              </div>
            )}

            {/* IDs */}
            <div className="flex flex-col gap-2">
              <h3 className={SECTION_LABEL_CLS}>Identifiers</h3>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-16 flex-shrink-0">
                    Public ID
                  </span>
                  <CopyableId id={record.publicId} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground w-16 flex-shrink-0">
                    Internal
                  </span>
                  <CopyableId id={record.id} />
                </div>
              </div>
            </div>

            {/* Error feedback from a failed mutation */}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}

            {/* Action footer — only rendered when at least one action is available */}
            {(updateMemory ?? deleteMemory) && (
              <div className="flex items-center justify-between gap-2 pt-3 border-t border-border/40">
                {/* Edit */}
                <div>
                  {updateMemory && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={enterEdit}
                      disabled={isPending}
                      aria-label="Edit memory"
                    >
                      <Pencil className="h-3 w-3 mr-1.5" aria-hidden="true" />
                      Edit
                    </Button>
                  )}
                </div>

                {/* Delete (two-step confirm) */}
                {deleteMemory && (
                  <div className="flex items-center gap-2">
                    {confirmDelete ? (
                      <>
                        <span className="text-xs text-muted-foreground">
                          Delete permanently?
                        </span>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={handleDelete}
                          disabled={isPending}
                          aria-label="Confirm delete memory"
                        >
                          {isPending ? "Deleting…" : "Confirm"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setConfirmDelete(false);
                            setError(null);
                          }}
                          disabled={isPending}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmDelete(true)}
                        aria-label="Delete memory"
                      >
                        <Trash2 className="h-3 w-3 mr-1.5" aria-hidden="true" />
                        Delete
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          /* ── Edit mode ─────────────────────────────────────────────────── */
          <div className="flex flex-col gap-4">
            {/* Lesson */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="edit-memory-lesson" className={SECTION_LABEL_CLS}>
                Lesson
              </label>
              <MarkdownCodeEditor
                id="edit-memory-lesson"
                value={editLesson}
                onChange={setEditLesson}
                maxLength={2000}
                placeholder="What should the agent remember? Markdown supported."
                ariaLabel="Lesson text"
                disabled={isPending}
                minHeight="8rem"
              />
            </div>

            {/* Kind — open string, recommended values suggested */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="edit-memory-kind" className={SECTION_LABEL_CLS}>
                Kind
              </label>
              <KindInput
                id="edit-memory-kind"
                value={editKind}
                onChange={setEditKind}
                disabled={isPending}
              />
            </div>

            {/* Salience: class (read-only, promote to change) + confidence + enforcement */}
            <div className="flex flex-col gap-3">
              <h3 className={SECTION_LABEL_CLS}>Salience</h3>

              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">Class</span>
                <div className="flex items-center gap-2">
                  <Badge className={classCfg.color}>{classCfg.label}</Badge>
                  <span className="text-[10px] text-muted-foreground">
                    Use Promote (in view mode) to move up the confidence ladder.
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="edit-memory-confidence"
                  className="text-[11px] text-muted-foreground"
                >
                  Confidence:{" "}
                  <span className="tabular-nums">
                    {Math.round(editConfidence)}%
                  </span>
                </label>
                <input
                  id="edit-memory-confidence"
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round(editConfidence)}
                  onChange={(e) => setEditConfidence(Number(e.target.value))}
                  disabled={isPending}
                  aria-label="Confidence level"
                  className="h-1 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
                />
              </div>

              {record.memoryClass === "RULE" && (
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="edit-memory-enforcement"
                    className="text-[11px] text-muted-foreground"
                  >
                    Enforcement:{" "}
                    <span className="tabular-nums">{editEnforcement}</span>
                  </label>
                  <input
                    id="edit-memory-enforcement"
                    type="range"
                    min="1"
                    max="100"
                    value={editEnforcement}
                    onChange={(e) => setEditEnforcement(Number(e.target.value))}
                    disabled={isPending}
                    aria-label="Enforcement level"
                    className="h-1 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
                  />
                </div>
              )}
              {record.memoryClass === "FACT" && (
                <p className="text-[10px] text-muted-foreground">
                  Enforcement is fixed at 100 for a FACT.
                </p>
              )}
              {record.memoryClass === "OBSERVATION" && (
                <p className="text-[10px] text-muted-foreground">
                  An OBSERVATION has no enforcement — promote it to a RULE to
                  set one.
                </p>
              )}
            </div>

            {/* Source */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="edit-memory-source" className={SECTION_LABEL_CLS}>
                Source
              </label>
              <input
                id="edit-memory-source"
                type="text"
                value={editSource}
                onChange={(e) => setEditSource(e.target.value)}
                maxLength={64}
                placeholder="Provenance label (e.g. user, feature, fix)"
                aria-label="Source"
                disabled={isPending}
                className={FIELD_INPUT_CLS}
              />
            </div>

            {/* Error */}
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}

            {/* Edit actions */}
            <div className="flex items-center gap-2 pt-3 border-t border-border/40">
              <Button
                size="sm"
                variant="gradient"
                onClick={handleSave}
                disabled={isPending || editLesson.trim().length === 0}
                startIcon={undefined}
              >
                {isPending ? "Saving…" : "Save changes"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={cancelEdit}
                disabled={isPending}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// New memory sheet — manual one-off capture
// ---------------------------------------------------------------------------

// Sentinel for the "let the classifier decide" option in the kind/class
// selects. The empty string is falsy, so it maps cleanly to "omit the field"
// when building the action payload, and agent.memory.remember then infers it.
const INFER = "" as const;

// FACT is intentionally excluded: it requires human confirmation and forces
// enforcement to 100, so it is reserved for the dedicated promote flow rather
// than one-off creation.
const CREATABLE_CLASSES: Array<"OBSERVATION" | "RULE"> = [
  "OBSERVATION",
  "RULE",
];

function MemoryCreate({
  orgSlug,
  workspaceSlug,
  onClose,
  onCreated,
  createMemory,
}: {
  orgSlug: string;
  workspaceSlug: string;
  onClose: () => void;
  /** Called after a successful create with the new record shape. */
  onCreated: (created: AgentMemoryRecord) => void;
  createMemory: NonNullable<MemoriesClientProps["createMemory"]>;
}) {
  const [text, setText] = React.useState("");
  const [kind, setKind] = React.useState("");
  const [memoryClass, setMemoryClass] = React.useState<
    "OBSERVATION" | "RULE" | typeof INFER
  >(INFER);
  const [enforcementScore, setEnforcementScore] = React.useState(50);
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function handleCreate() {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setError(null);
    const trimmedKind = kind.trim();
    startTransition(async () => {
      const result = await createMemory({
        orgSlug,
        workspaceSlug,
        text: trimmed,
        // Only send pinned fields; the empty sentinel is omitted so the
        // handler classifier infers it.
        ...(trimmedKind ? { memoryKind: trimmedKind } : {}),
        ...(memoryClass ? { memoryClass } : {}),
        ...(memoryClass === "RULE" ? { enforcementScore } : {}),
      });

      if (result.ok) {
        onCreated(result.memory);
        onClose();
      } else {
        setError(result.error);
      }
    });
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full max-w-lg overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2">
            <BrainCircuit className="h-4 w-4" aria-hidden="true" />
            New memory
          </SheetTitle>
          <SheetDescription className="text-xs text-muted-foreground">
            Capture a lesson, constraint, or gotcha for agents in this
            workspace. Leave Kind or Class on &ldquo;Auto-detect&rdquo; to let
            the assistant classify it. Facts require human confirmation — use
            Promote on an existing memory instead.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4">
          {/* Lesson */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-memory-lesson" className={SECTION_LABEL_CLS}>
              Lesson
            </label>
            <MarkdownCodeEditor
              value={text}
              onChange={setText}
              id="create-memory-lesson"
              maxLength={2000}
              placeholder="What should the agent remember? Markdown supported."
              ariaLabel="Lesson text"
              disabled={isPending}
              minHeight="8rem"
            />
          </div>

          {/* Kind — open string, Auto-detect or free text */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-memory-kind" className={SECTION_LABEL_CLS}>
              Kind
            </label>
            <input
              id="create-memory-kind"
              type="text"
              list="create-memory-kind-options"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              disabled={isPending}
              aria-label="Memory kind"
              placeholder="Auto-detect"
              maxLength={64}
              className={FIELD_INPUT_CLS}
            />
            <datalist id="create-memory-kind-options">
              {RECOMMENDED_MEMORY_KINDS.map((k) => (
                <option key={k} value={k} />
              ))}
            </datalist>
          </div>

          {/* Class */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-memory-class" className={SECTION_LABEL_CLS}>
              Class
            </label>
            <select
              id="create-memory-class"
              value={memoryClass}
              onChange={(e) =>
                setMemoryClass(
                  e.target.value as "OBSERVATION" | "RULE" | typeof INFER,
                )
              }
              disabled={isPending}
              aria-label="Memory class"
              className={FIELD_INPUT_CLS}
            >
              <option value={INFER}>Auto-detect</option>
              {CREATABLE_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {CLASS_CONFIG[c].label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-muted-foreground">
              Observation sinks below recall as confidence decays; Rule sets a
              policy that agents must weigh against enforcement.
            </p>
          </div>

          {memoryClass === "RULE" && (
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="create-memory-enforcement"
                className="text-[11px] text-muted-foreground"
              >
                Enforcement:{" "}
                <span className="tabular-nums">{enforcementScore}</span>
              </label>
              <input
                id="create-memory-enforcement"
                type="range"
                min="1"
                max="100"
                value={enforcementScore}
                onChange={(e) => setEnforcementScore(Number(e.target.value))}
                disabled={isPending}
                aria-label="Enforcement level"
                className="h-1 w-full cursor-pointer accent-primary"
              />
            </div>
          )}

          {/* Error */}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-3 border-t border-border/40">
            <Button
              size="sm"
              variant="gradient"
              onClick={handleCreate}
              disabled={isPending || text.trim().length === 0}
            >
              {isPending ? "Adding…" : "Add memory"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onClose}
              disabled={isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MemoriesClient({
  initialRecords,
  total,
  orgId: _orgId,
  workspaceId: _workspaceId,
  orgSlug,
  workspaceSlug,
  createMemory,
  updateMemory,
  deleteMemory,
  promoteMemory,
  dismissPromotion,
  demoteMemory,
  suggestRationales,
  promotionCandidates,
  parseImport,
  commitImport,
}: MemoriesClientProps) {
  const router = useRouter();
  const toast = useToast();
  const [records, setRecords] =
    React.useState<AgentMemoryRecord[]>(initialRecords);
  const [candidates, setCandidates] = React.useState<PromotionCandidate[]>([]);
  const [selectedRecord, setSelectedRecord] =
    React.useState<AgentMemoryRecord | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);
  const [showBulkImport, setShowBulkImport] = React.useState(false);
  const [activeKinds, setActiveKinds] = React.useState<Set<string>>(new Set());
  const [activeClasses, setActiveClasses] = React.useState<Set<MemoryClass>>(
    new Set(),
  );
  const [searchQuery, setSearchQuery] = React.useState("");
  const [minConfidence, setMinConfidence] = React.useState(0);
  const [minCitations, setMinCitations] = React.useState(0);
  const [sortBy, setSortBy] = React.useState<MemorySort>("createdAt");

  // Sync records when the server re-renders with fresh data after router.refresh().
  React.useEffect(() => {
    setRecords(initialRecords);
  }, [initialRecords]);

  const loadCandidates = React.useCallback(() => {
    if (!promotionCandidates) return;
    void promotionCandidates({ orgSlug, workspaceSlug, limit: 3 }).then(
      (result) => {
        if (result.ok) setCandidates(result.candidates);
      },
    );
  }, [promotionCandidates, orgSlug, workspaceSlug]);

  React.useEffect(() => {
    loadCandidates();
  }, [loadCandidates]);

  const toggleKind = React.useCallback((kind: string) => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) {
        next.delete(kind);
      } else {
        next.add(kind);
      }
      return next;
    });
  }, []);

  const toggleClass = React.useCallback((cls: MemoryClass) => {
    setActiveClasses((prev) => {
      const next = new Set(prev);
      if (next.has(cls)) {
        next.delete(cls);
      } else {
        next.add(cls);
      }
      return next;
    });
  }, []);

  /** Prepend a newly created record (newest first), then re-sync from server. */
  function handleMemoryCreated(created: AgentMemoryRecord) {
    setRecords((prev) => [created, ...prev.filter((r) => r.id !== created.id)]);
    router.refresh();
  }

  /** Optimistically apply an updated record to the list, then re-sync from server. */
  function handleMemoryUpdated(updated: AgentMemoryRecord) {
    setRecords((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
    // A promotion or edit can change candidate eligibility (e.g. it's no
    // longer an OBSERVATION) — refresh the suggestions too.
    loadCandidates();
    router.refresh();
  }

  /** Optimistically remove a deleted record from the list, then re-sync from server. */
  function handleMemoryDeleted(memoryId: string) {
    setRecords((prev) => prev.filter((r) => r.id !== memoryId));
    router.refresh();
  }

  // Optimistic removal + durable dismiss for the inline "suggested to
  // promote" panel, with an Undo toast that restores the candidate (calling
  // dismiss again with restore:true). On a failed dismiss the card returns.
  function handleCandidateDismissed(candidate: PromotionCandidate) {
    if (!dismissPromotion) return;
    setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));

    void dismissPromotion({
      orgSlug,
      workspaceSlug,
      memoryId: candidate.id,
    }).then((result) => {
      if (!result.ok) {
        setCandidates((prev) =>
          prev.some((c) => c.id === candidate.id) ? prev : [candidate, ...prev],
        );
        toast.add({
          title: "Couldn't dismiss",
          description: result.error,
          type: "error",
        });
        return;
      }
      toast.add({
        title: "Dismissed from promotion queue",
        description: candidate.lesson,
        type: "success",
        actionProps: {
          children: "Undo",
          onClick: () => {
            void dismissPromotion({
              orgSlug,
              workspaceSlug,
              memoryId: candidate.id,
              restore: true,
            }).then((restoreResult) => {
              if (restoreResult.ok) {
                setCandidates((prev) =>
                  prev.some((c) => c.id === candidate.id)
                    ? prev
                    : [candidate, ...prev],
                );
              } else {
                toast.add({
                  title: "Couldn't restore",
                  description: restoreResult.error,
                  type: "error",
                });
              }
            });
          },
        },
      });
    });
  }

  // Client-side filtering + sorting
  const filtered = React.useMemo(() => {
    const matched = records.filter((r) => {
      // Class filter
      if (activeClasses.size > 0 && !activeClasses.has(r.memoryClass))
        return false;
      // Kind filter
      if (activeKinds.size > 0 && !activeKinds.has(r.memoryKind)) return false;
      // Confidence filter
      if (r.confidenceScore < minConfidence) return false;
      // Citation-count floor
      if (r.citationCount < minCitations) return false;
      // Text search over lesson, source, nodeRef
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (
          !r.lesson.toLowerCase().includes(q) &&
          !r.source.toLowerCase().includes(q) &&
          !r.nodeRef.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
    if (sortBy === "citationCount") {
      // Descending by citations; tie-break on recency so equal counts stay
      // deterministic (mirrors the listMemories ORDER BY on the server).
      return [...matched].sort(
        (a, b) =>
          b.citationCount - a.citationCount ||
          b.createdAt.localeCompare(a.createdAt),
      );
    }
    // Records arrive newest-first from the server; keep that order.
    return matched;
  }, [
    records,
    activeClasses,
    activeKinds,
    minConfidence,
    minCitations,
    searchQuery,
    sortBy,
  ]);

  // Kinds present in the current record set, for the dynamic filter chips.
  const availableKinds = React.useMemo(() => {
    const seen = new Set<string>();
    for (const r of records) seen.add(r.memoryKind);
    return Array.from(seen).sort((a, b) => {
      const aKnown = a in KIND_CONFIG;
      const bKnown = b in KIND_CONFIG;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.localeCompare(b);
    });
  }, [records]);

  // Class distribution for stats row — the primary epistemic axis.
  const classCounts = React.useMemo(() => {
    const counts: Record<MemoryClass, number> = {
      OBSERVATION: 0,
      RULE: 0,
      FACT: 0,
    };
    for (const r of records)
      counts[r.memoryClass] = (counts[r.memoryClass] ?? 0) + 1;
    return counts;
  }, [records]);

  return (
    <div className="flex flex-col gap-5">
      {/* Header — stacks below `sm` so the action buttons never crush the
          title/description column into a one-word-per-line sliver. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <BrainCircuit
            className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-semibold text-foreground">
              Agent Memories
            </p>
            <p className="text-xs text-muted-foreground">
              Lessons, constraints, and gotchas written by agents during this
              workspace&apos;s sessions.
            </p>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {parseImport && commitImport && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowBulkImport(true)}
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              Bulk Import
            </Button>
          )}
          {createMemory && (
            <Button
              size="sm"
              variant="gradient"
              onClick={() => setShowCreate(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              New Memory
            </Button>
          )}
        </div>
      </div>

      {/* Suggested to promote */}
      {promoteMemory && candidates.length > 0 && (
        <PromotionCandidatesPanel
          candidates={candidates}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          promoteMemory={promoteMemory}
          dismissPromotion={dismissPromotion}
          suggestRationales={suggestRationales}
          onPromoted={handleMemoryUpdated}
          onDismissed={handleCandidateDismissed}
        />
      )}

      {/* Stats + filters — only meaningful once at least one memory exists, so
          they stay hidden on an empty workspace (the empty state then sits
          directly under the header, not below a full but inert control bar). */}
      {records.length > 0 && (
        <>
          {/* Stats row — per-class counts, the primary epistemic axis */}
          <div
            className="grid grid-cols-3 gap-2"
            data-testid="memory-stats-row"
          >
            {ALL_CLASSES.map((cls) => {
              const cfg = CLASS_CONFIG[cls];
              const Icon = cfg.icon;
              return (
                <div
                  key={cls}
                  className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2"
                >
                  <Icon
                    className={`h-3.5 w-3.5 flex-shrink-0 ${cfg.color.split(" ").slice(1).join(" ")}`}
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-semibold tabular-nums text-foreground">
                      {classCounts[cls]}
                    </span>
                    <span className="text-[10px] text-muted-foreground truncate">
                      {cfg.label}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Filters */}
          <FilterBar
            availableKinds={availableKinds}
            activeKinds={activeKinds}
            toggleKind={toggleKind}
            activeClasses={activeClasses}
            toggleClass={toggleClass}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            minConfidence={minConfidence}
            setMinConfidence={setMinConfidence}
            minCitations={minCitations}
            setMinCitations={setMinCitations}
            sortBy={sortBy}
            setSortBy={setSortBy}
          />
        </>
      )}

      {/* Record list */}
      {filtered.length > 0 ? (
        <div className="rounded-lg border border-border/60 overflow-hidden">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5 bg-muted/30">
            <span className="text-[11px] font-medium text-muted-foreground">
              {filtered.length} memor{filtered.length !== 1 ? "ies" : "y"}
              {activeClasses.size > 0 ||
              activeKinds.size > 0 ||
              minConfidence > 0 ||
              minCitations > 0 ||
              searchQuery
                ? " (filtered)"
                : ""}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {SORT_LABELS[sortBy]}
            </span>
          </div>
          <div className="max-h-[600px] overflow-y-auto">
            {filtered.map((record) => (
              <MemoryRow
                key={record.id}
                record={record}
                onSelect={() => setSelectedRecord(record)}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/60 py-16">
          <BrainCircuit className="h-8 w-8 text-muted-foreground/50" />
          <div className="text-center">
            <p className="text-sm font-medium text-muted-foreground">
              {records.length === 0
                ? "No memories yet"
                : "No memories match your filters"}
            </p>
            <p className="text-xs text-muted-foreground/70 mt-1 max-w-xs">
              {records.length === 0
                ? "Memories appear here as agents learn during this workspace's sessions, when you ask the assistant to remember something, or when you add one with “New Memory”."
                : "Try adjusting your class/kind filters, confidence threshold, or search query."}
            </p>
          </div>
        </div>
      )}

      {/* Footer */}
      <p className="text-[11px] text-muted-foreground">
        Showing {records.length}
        {total > records.length ? ` of ${total}` : ""} memor
        {records.length !== 1 ? "ies" : "y"} in this workspace.
      </p>

      {/* Detail sheet */}
      {selectedRecord && (
        <MemoryDetail
          record={selectedRecord}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          onClose={() => setSelectedRecord(null)}
          onUpdated={handleMemoryUpdated}
          onDeleted={handleMemoryDeleted}
          updateMemory={updateMemory}
          deleteMemory={deleteMemory}
          promoteMemory={promoteMemory}
          demoteMemory={demoteMemory}
          suggestRationales={suggestRationales}
        />
      )}

      {/* Create sheet */}
      {showCreate && createMemory && (
        <MemoryCreate
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          onClose={() => setShowCreate(false)}
          onCreated={handleMemoryCreated}
          createMemory={createMemory}
        />
      )}

      {/* Bulk import sheet */}
      {showBulkImport && parseImport && commitImport && (
        <MemoriesBulkImport
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          onClose={() => setShowBulkImport(false)}
          onImported={() => router.refresh()}
          parseImport={parseImport}
          commitImport={commitImport}
        />
      )}
    </div>
  );
}
