"use client";

/**
 * MemoriesClient — AgentMemory browser for the Knowledge → Memories tab.
 *
 * Renders the list of :AgentMemory nodes written to Neo4j by agent.memory.write.
 * Features:
 * - Filter by memory kind (5 kinds), min-confidence slider, text search
 * - Row: lesson (primary), kind badge, weight badge, confidence bar, createdAt, source, nodeRef
 * - Click a row to open a detail sheet with all metadata
 * - Detail sheet: edit lesson/kind/salience (weight+confidence)/source via updateMemory action
 * - Detail sheet: delete with a two-step confirm via deleteMemory action
 * - Stats row with per-kind counts
 * - Empty state with helpful guidance
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import {
  BrainCircuit,
  Filter,
  RefreshCw,
  Lock,
  Bug,
  AlertTriangle,
  Zap,
  Clock,
  Fingerprint,
  ChevronRight,
  Search,
  X,
  Copy,
  Pencil,
  Trash2,
  Plus,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  MemoriesBulkImport,
  type DraftMemory,
} from "./memories-bulk-import";

// ---------------------------------------------------------------------------
// Types — mirrors AgentMemoryRecord from @oxagen/oxagen/contracts/agent.memory.list
// ---------------------------------------------------------------------------

// Exported so the bulk-import grid shares the exact kind/weight taxonomy,
// labels, and colors — one source of truth for the Memories surface.
export type MemoryWeight = "low" | "high" | "critical";
export type MemoryKind =
  | "routine-change"
  | "constraint"
  | "bug-root-cause"
  | "convention-deviation"
  | "gotcha";

interface AgentMemoryRecord {
  id: string;
  publicId: string;
  nodeRef: string;
  weight: MemoryWeight;
  kind: string;
  lesson: string;
  source: string;
  confidence: number;
  createdAt: string;
  lastReinforcedAt: string | null;
}

// Action result shapes (structural mirror of the server action exports — avoids
// importing "use server" functions into client code; TS checks structurally).
type CreateMemoryResult =
  | { ok: true; memory: AgentMemoryRecord }
  | { ok: false; error: string };

type UpdateMemoryResult =
  | { ok: true; memory: AgentMemoryRecord }
  | { ok: false; error: string };

type DeleteMemoryResult =
  | { ok: true }
  | { ok: false; error: string };

interface MemoriesClientProps {
  initialRecords: AgentMemoryRecord[];
  total: number;
  orgId: string;
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  /**
   * Server action for adding a manual one-off memory of any kind. Passed from
   * MemoriesSection as a server action ref. When absent the "New Memory"
   * affordance is not rendered. `kind`/`weight` are optional — omitting them
   * lets the agent.memory.remember classifier infer them from the lesson.
   */
  createMemory?: (input: {
    orgSlug: string;
    workspaceSlug: string;
    text: string;
    kind?: MemoryKind;
    weight?: MemoryWeight;
  }) => Promise<CreateMemoryResult>;
  /**
   * Server action for editing a memory. Passed from MemoriesSection (server
   * component) so it crosses the RSC → client boundary as a server action ref.
   * When absent the edit affordance is not rendered.
   */
  updateMemory?: (input: {
    orgSlug: string;
    workspaceSlug: string;
    memoryId: string;
    lesson?: string;
    weight?: MemoryWeight;
    kind?: MemoryKind;
    source?: string;
    confidence?: number;
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
// Kind configuration
// ---------------------------------------------------------------------------

export const KIND_CONFIG: Record<
  MemoryKind,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
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
    color: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
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

function getKindConfig(kind: string): (typeof KIND_CONFIG)[MemoryKind] {
  return (
    KIND_CONFIG[kind as MemoryKind] ?? {
      label: kind,
      icon: BrainCircuit,
      color: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
    }
  );
}

// ---------------------------------------------------------------------------
// Weight configuration
// ---------------------------------------------------------------------------

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

function ConfidenceBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(1, value));
  const pct = Math.round(clamped * 100);
  const barColor =
    clamped >= 0.7
      ? "bg-emerald-500"
      : clamped >= 0.4
        ? "bg-amber-500"
        : "bg-zinc-400";
  return (
    <div className="flex items-center gap-1.5">
      <div
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Confidence ${pct}%`}
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

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function FilterBar({
  activeKinds,
  toggleKind,
  searchQuery,
  setSearchQuery,
  minConfidence,
  setMinConfidence,
}: {
  activeKinds: Set<string>;
  toggleKind: (k: MemoryKind) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  minConfidence: number;
  setMinConfidence: (v: number) => void;
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
            value={Math.round(minConfidence * 100)}
            onChange={(e) => setMinConfidence(Number(e.target.value) / 100)}
            className="h-1 w-20 cursor-pointer accent-primary"
          />
          <span className="text-[10px] tabular-nums text-muted-foreground w-7">
            {Math.round(minConfidence * 100)}%
          </span>
        </div>
      </div>

      {/* Kind filter chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {ALL_KINDS.map((kind) => {
          const cfg = KIND_CONFIG[kind];
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
        {activeKinds.size > 0 && activeKinds.size < ALL_KINDS.length && (
          <button
            type="button"
            onClick={() => {
              for (const k of ALL_KINDS) {
                if (activeKinds.has(k)) toggleKind(k);
              }
            }}
            className="text-[10px] text-muted-foreground hover:text-foreground ml-1"
          >
            Clear filters
          </button>
        )}
      </div>
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
  const kindCfg = getKindConfig(record.kind);
  const weightCfg =
    WEIGHT_CONFIG[record.weight] ?? WEIGHT_CONFIG["low"];
  const KindIcon = kindCfg.icon;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-3 border-b border-border/30 px-4 py-3 text-left transition-colors hover:bg-muted/40 last:border-b-0 group"
    >
      {/* Kind icon */}
      <div className={`mt-0.5 flex-shrink-0 rounded-md p-1.5 ${kindCfg.color}`}>
        <KindIcon className="h-3.5 w-3.5" />
      </div>

      {/* Content */}
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        {/* Lesson (primary text) */}
        <p className="text-sm text-foreground line-clamp-2 leading-snug">
          {record.lesson}
        </p>

        {/* Badges row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge
            className={`${kindCfg.color} text-[10px] px-1.5 py-0 border-0 font-medium`}
          >
            {kindCfg.label}
          </Badge>
          <Badge
            className={`${weightCfg.color} text-[10px] px-1.5 py-0 border-0 font-medium`}
          >
            {weightCfg.label}
          </Badge>
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
        <ConfidenceBar value={record.confidence} />
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </button>
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
}: {
  record: AgentMemoryRecord;
  orgSlug: string;
  workspaceSlug: string;
  onClose: () => void;
  /** Called after a successful update with the new record shape. */
  onUpdated: (updated: AgentMemoryRecord) => void;
  /** Called after a successful delete with the deleted memory's id. */
  onDeleted: (memoryId: string) => void;
  updateMemory?: (input: {
    orgSlug: string;
    workspaceSlug: string;
    memoryId: string;
    lesson?: string;
    weight?: MemoryWeight;
    kind?: MemoryKind;
    source?: string;
    confidence?: number;
  }) => Promise<UpdateMemoryResult>;
  deleteMemory?: (input: {
    orgSlug: string;
    workspaceSlug: string;
    memoryId: string;
  }) => Promise<DeleteMemoryResult>;
}) {
  // Local record state — updated optimistically on a successful save.
  const [record, setRecord] = React.useState(initialRecord);
  const [mode, setMode] = React.useState<"view" | "edit">("view");
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  // Edit form state — reset to current record when entering edit mode.
  const [editLesson, setEditLesson] = React.useState(record.lesson);
  const [editKind, setEditKind] = React.useState(record.kind);
  const [editWeight, setEditWeight] = React.useState<MemoryWeight>(record.weight);
  const [editConfidence, setEditConfidence] = React.useState(record.confidence);
  const [editSource, setEditSource] = React.useState(record.source);

  const kindCfg = getKindConfig(record.kind);
  const weightCfg = WEIGHT_CONFIG[record.weight] ?? WEIGHT_CONFIG["low"];

  function enterEdit() {
    // Sync form fields to the current (potentially already-updated) record.
    setEditLesson(record.lesson);
    setEditKind(record.kind);
    setEditWeight(record.weight);
    setEditConfidence(record.confidence);
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
      kind?: MemoryKind;
      weight?: MemoryWeight;
      confidence?: number;
      source?: string;
    } = {};

    const trimmedLesson = editLesson.trim();
    if (trimmedLesson !== record.lesson && trimmedLesson.length > 0) {
      updates.lesson = trimmedLesson;
    }
    if (editKind !== record.kind) {
      updates.kind = editKind as MemoryKind;
    }
    if (editWeight !== record.weight) {
      updates.weight = editWeight;
    }
    if (Math.abs(editConfidence - record.confidence) > 0.001) {
      updates.confidence = editConfidence;
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
            <Badge className={weightCfg.color}>{weightCfg.label}</Badge>
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
              <p className="text-sm text-foreground leading-relaxed">
                {record.lesson}
              </p>
            </div>

            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-3">
              <MetaField label="Kind" value={kindCfg.label} />
              <MetaField label="Weight" value={weightCfg.label} />
              <MetaField
                label="Confidence"
                value={`${Math.round(Math.max(0, Math.min(1, record.confidence)) * 100)}%`}
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
            </div>

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
              <textarea
                id="edit-memory-lesson"
                rows={4}
                value={editLesson}
                onChange={(e) => setEditLesson(e.target.value)}
                maxLength={2000}
                placeholder="What should the agent remember?"
                aria-label="Lesson text"
                disabled={isPending}
                className={`${FIELD_INPUT_CLS} resize-y`}
              />
            </div>

            {/* Kind */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="edit-memory-kind" className={SECTION_LABEL_CLS}>
                Kind
              </label>
              <select
                id="edit-memory-kind"
                value={editKind}
                onChange={(e) => setEditKind(e.target.value)}
                disabled={isPending}
                aria-label="Memory kind"
                className={FIELD_INPUT_CLS}
              >
                {ALL_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_CONFIG[k].label}
                  </option>
                ))}
              </select>
            </div>

            {/* Salience: weight + confidence */}
            <div className="flex flex-col gap-3">
              <h3 className={SECTION_LABEL_CLS}>Salience</h3>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="edit-memory-weight"
                  className="text-[11px] text-muted-foreground"
                >
                  Weight
                </label>
                <select
                  id="edit-memory-weight"
                  value={editWeight}
                  onChange={(e) => setEditWeight(e.target.value as MemoryWeight)}
                  disabled={isPending}
                  aria-label="Memory weight"
                  className={FIELD_INPUT_CLS}
                >
                  {(["low", "high", "critical"] as const).map((w) => (
                    <option key={w} value={w}>
                      {WEIGHT_CONFIG[w].label}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-muted-foreground">
                  Low sinks below recall; Critical never decays.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="edit-memory-confidence"
                  className="text-[11px] text-muted-foreground"
                >
                  Confidence:{" "}
                  <span className="tabular-nums">
                    {Math.round(editConfidence * 100)}%
                  </span>
                </label>
                <input
                  id="edit-memory-confidence"
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round(editConfidence * 100)}
                  onChange={(e) =>
                    setEditConfidence(Number(e.target.value) / 100)
                  }
                  disabled={isPending}
                  aria-label="Confidence level"
                  className="h-1 w-full cursor-pointer accent-primary disabled:cursor-not-allowed"
                />
              </div>
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
// New memory sheet — manual one-off capture, any kind
// ---------------------------------------------------------------------------

// Sentinel for the "let the classifier decide" option in the kind/weight
// selects. The empty string is falsy, so it maps cleanly to "omit the field"
// when building the action payload, and agent.memory.remember then infers it.
const INFER = "" as const;

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
  createMemory: (input: {
    orgSlug: string;
    workspaceSlug: string;
    text: string;
    kind?: MemoryKind;
    weight?: MemoryWeight;
  }) => Promise<CreateMemoryResult>;
}) {
  const [text, setText] = React.useState("");
  const [kind, setKind] = React.useState<MemoryKind | typeof INFER>(INFER);
  const [weight, setWeight] = React.useState<MemoryWeight | typeof INFER>(INFER);
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function handleCreate() {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setError(null);
    startTransition(async () => {
      const result = await createMemory({
        orgSlug,
        workspaceSlug,
        text: trimmed,
        // Only send a pinned kind/weight; the empty sentinel is omitted so the
        // handler classifier infers it.
        ...(kind ? { kind } : {}),
        ...(weight ? { weight } : {}),
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
            workspace. Leave Kind or Weight on &ldquo;Auto-detect&rdquo; to let
            the assistant classify it.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4">
          {/* Lesson */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-memory-lesson" className={SECTION_LABEL_CLS}>
              Lesson
            </label>
            <textarea
              id="create-memory-lesson"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={2000}
              placeholder="What should the agent remember?"
              aria-label="Lesson text"
              disabled={isPending}
              className={`${FIELD_INPUT_CLS} resize-y`}
            />
          </div>

          {/* Kind — any of the five types, or Auto-detect */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-memory-kind" className={SECTION_LABEL_CLS}>
              Kind
            </label>
            <select
              id="create-memory-kind"
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as MemoryKind | typeof INFER)
              }
              disabled={isPending}
              aria-label="Memory kind"
              className={FIELD_INPUT_CLS}
            >
              <option value={INFER}>Auto-detect</option>
              {ALL_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_CONFIG[k].label}
                </option>
              ))}
            </select>
          </div>

          {/* Weight */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-memory-weight" className={SECTION_LABEL_CLS}>
              Weight
            </label>
            <select
              id="create-memory-weight"
              value={weight}
              onChange={(e) =>
                setWeight(e.target.value as MemoryWeight | typeof INFER)
              }
              disabled={isPending}
              aria-label="Memory weight"
              className={FIELD_INPUT_CLS}
            >
              <option value={INFER}>Auto-detect</option>
              {(["low", "high", "critical"] as const).map((w) => (
                <option key={w} value={w}>
                  {WEIGHT_CONFIG[w].label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-muted-foreground">
              Low sinks below recall; Critical never decays.
            </p>
          </div>

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
  parseImport,
  commitImport,
}: MemoriesClientProps) {
  const router = useRouter();
  const [records, setRecords] = React.useState<AgentMemoryRecord[]>(initialRecords);
  const [selectedRecord, setSelectedRecord] =
    React.useState<AgentMemoryRecord | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);
  const [showBulkImport, setShowBulkImport] = React.useState(false);
  const [activeKinds, setActiveKinds] = React.useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = React.useState("");
  const [minConfidence, setMinConfidence] = React.useState(0);

  // Sync records when the server re-renders with fresh data after router.refresh().
  React.useEffect(() => {
    setRecords(initialRecords);
  }, [initialRecords]);

  const toggleKind = React.useCallback((kind: MemoryKind) => {
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

  /** Prepend a newly created record (newest first), then re-sync from server. */
  function handleMemoryCreated(created: AgentMemoryRecord) {
    setRecords((prev) => [
      created,
      ...prev.filter((r) => r.id !== created.id),
    ]);
    router.refresh();
  }

  /** Optimistically apply an updated record to the list, then re-sync from server. */
  function handleMemoryUpdated(updated: AgentMemoryRecord) {
    setRecords((prev) =>
      prev.map((r) => (r.id === updated.id ? updated : r)),
    );
    router.refresh();
  }

  /** Optimistically remove a deleted record from the list, then re-sync from server. */
  function handleMemoryDeleted(memoryId: string) {
    setRecords((prev) => prev.filter((r) => r.id !== memoryId));
    router.refresh();
  }

  // Client-side filtering
  const filtered = React.useMemo(() => {
    return records.filter((r) => {
      // Kind filter
      if (activeKinds.size > 0 && !activeKinds.has(r.kind)) return false;
      // Confidence filter
      if (r.confidence < minConfidence) return false;
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
  }, [records, activeKinds, minConfidence, searchQuery]);

  // Kind distribution for stats row
  const kindCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const k of ALL_KINDS) counts[k] = 0;
    for (const r of records) {
      if (r.kind in counts) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    }
    return counts;
  }, [records]);

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
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

      {/* Stats row */}
      <div className="grid grid-cols-5 gap-2">
        {ALL_KINDS.map((kind) => {
          const cfg = KIND_CONFIG[kind];
          const Icon = cfg.icon;
          return (
            <div
              key={kind}
              className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2"
            >
              <Icon
                className={`h-3.5 w-3.5 flex-shrink-0 ${cfg.color.split(" ").slice(1).join(" ")}`}
              />
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {kindCounts[kind] ?? 0}
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
        activeKinds={activeKinds}
        toggleKind={toggleKind}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        minConfidence={minConfidence}
        setMinConfidence={setMinConfidence}
      />

      {/* Record list */}
      {filtered.length > 0 ? (
        <div className="rounded-lg border border-border/60 overflow-hidden">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5 bg-muted/30">
            <span className="text-[11px] font-medium text-muted-foreground">
              {filtered.length} memor{filtered.length !== 1 ? "ies" : "y"}
              {activeKinds.size > 0 || minConfidence > 0 || searchQuery
                ? " (filtered)"
                : ""}
            </span>
            <span className="text-[10px] text-muted-foreground">
              Newest first
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
                : "Try adjusting your kind filters, confidence threshold, or search query."}
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
