"use client";

/**
 * MemoriesClient — full-featured Engram memory explorer.
 *
 * Features:
 * - Filter by record kind (episodic, semantic, procedural, entity, edge)
 * - Filter by minimum salience threshold
 * - Live record list with kind badges, salience bars, timestamps
 * - Click-to-inspect detail panel (sheet) showing full body, provenance, causality
 * - Content-addressed ID display for debugging
 * - Graph sync status indicators
 */
import * as React from "react";
import {
  BrainCircuit,
  Filter,
  Activity,
  BookOpen,
  Cog,
  Box,
  Link2,
  Clock,
  Fingerprint,
  User,
  ChevronRight,
  Search,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RecordKind = "episodic" | "semantic" | "procedural" | "entity" | "edge";

interface Provenance {
  author: string;
  derivedFrom: string[];
  tool?: string;
  model?: string;
  timestamp: number;
}

interface SerializedRecord {
  id: string;
  kind: RecordKind;
  namespace: {
    org: string;
    workspace: string;
    session?: string;
    agent?: string;
  };
  body: Record<string, unknown>;
  salience: number;
  confidence: number;
  provenance: Provenance;
  causality: string[];
  ttl?: number;
  createdAt: number;
}

interface MemoriesClientProps {
  initialRecords: SerializedRecord[];
  orgId: string;
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
}

// ---------------------------------------------------------------------------
// Kind configuration
// ---------------------------------------------------------------------------

const KIND_CONFIG: Record<
  RecordKind,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    color: string;
  }
> = {
  episodic: {
    label: "Episodic",
    icon: Activity,
    color: "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  },
  semantic: {
    label: "Semantic",
    icon: BookOpen,
    color: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  },
  procedural: {
    label: "Procedural",
    icon: Cog,
    color: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  },
  entity: {
    label: "Entity",
    icon: Box,
    color: "bg-purple-500/15 text-purple-700 dark:text-purple-400",
  },
  edge: {
    label: "Edge",
    icon: Link2,
    color: "bg-pink-500/15 text-pink-700 dark:text-pink-400",
  },
};

const ALL_KINDS: RecordKind[] = [
  "episodic",
  "semantic",
  "procedural",
  "entity",
  "edge",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

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
  return `${id.slice(0, 8)}...${id.slice(-6)}`;
}

function extractBodySummary(
  kind: RecordKind,
  body: Record<string, unknown>,
): string {
  switch (kind) {
    case "episodic": {
      const event = body.event as string | undefined;
      const outcome = body.outcome as string | undefined;
      return outcome ? `${event} (${outcome})` : (event ?? "event");
    }
    case "semantic":
      return (body.fact as string) ?? "fact";
    case "procedural":
      return (body.rule as string) ?? "rule";
    case "entity":
      return `${body.entityType ?? "entity"}: ${body.name ?? "unnamed"}`;
    case "edge":
      return `${body.edgeType ?? "edge"}: ${truncateId(String(body.sourceId ?? ""))} → ${truncateId(String(body.targetId ?? ""))}`;
    default:
      return JSON.stringify(body).slice(0, 80);
  }
}

function SalienceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color =
    value >= 0.7
      ? "bg-emerald-500"
      : value >= 0.4
        ? "bg-amber-500"
        : "bg-zinc-400";
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground">
        {pct}%
      </span>
    </div>
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
  minSalience,
  setMinSalience,
}: {
  activeKinds: Set<RecordKind>;
  toggleKind: (k: RecordKind) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  minSalience: number;
  setMinSalience: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {/* Search + salience */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search memories..."
            className="w-full rounded-md border border-border/60 bg-background py-1.5 pl-8 pr-8 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <label className="text-[11px] text-muted-foreground whitespace-nowrap">
            Min salience
          </label>
          <input
            type="range"
            min="0"
            max="100"
            value={Math.round(minSalience * 100)}
            onChange={(e) => setMinSalience(Number(e.target.value) / 100)}
            className="h-1 w-20 cursor-pointer accent-primary"
          />
          <span className="text-[10px] tabular-nums text-muted-foreground w-7">
            {Math.round(minSalience * 100)}%
          </span>
        </div>
      </div>

      {/* Kind chips */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {ALL_KINDS.map((kind) => {
          const cfg = KIND_CONFIG[kind];
          const active = activeKinds.has(kind);
          const Icon = cfg.icon;
          return (
            <button
              key={kind}
              type="button"
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
            onClick={() => ALL_KINDS.forEach(toggleKind)}
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
// Record row
// ---------------------------------------------------------------------------

function MemoryRecordRow({
  record,
  onSelect,
}: {
  record: SerializedRecord;
  onSelect: () => void;
}) {
  const cfg = KIND_CONFIG[record.kind];
  const Icon = cfg.icon;
  const summary = extractBodySummary(record.kind, record.body);

  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 border-b border-border/30 px-4 py-3 text-left transition-colors hover:bg-muted/40 last:border-b-0 group"
    >
      {/* Kind icon */}
      <div className={`flex-shrink-0 rounded-md p-1.5 ${cfg.color}`}>
        <Icon className="h-3.5 w-3.5" />
      </div>

      {/* Content */}
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <p className="text-sm text-foreground truncate">{summary}</p>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" />
            {formatTimestamp(record.createdAt)}
          </span>
          <span className="flex items-center gap-1">
            <Fingerprint className="h-2.5 w-2.5" />
            {truncateId(record.id)}
          </span>
          <span className="flex items-center gap-1">
            <User className="h-2.5 w-2.5" />
            {record.provenance.author}
          </span>
          {record.confidence < 1 && (
            <span>conf {Math.round(record.confidence * 100)}%</span>
          )}
        </div>
      </div>

      {/* Salience + arrow */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <SalienceBar value={record.salience} />
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function RecordDetail({
  record,
  onClose,
}: {
  record: SerializedRecord;
  onClose: () => void;
}) {
  const cfg = KIND_CONFIG[record.kind];

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
            <Badge className={cfg.color}>{cfg.label}</Badge>
            <span className="text-sm font-normal text-muted-foreground">
              Memory Record
            </span>
          </SheetTitle>
          <SheetDescription className="text-xs font-mono break-all">
            {record.id}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5">
          {/* Metadata grid */}
          <div className="grid grid-cols-2 gap-3">
            <MetaField label="Kind" value={record.kind} />
            <MetaField
              label="Salience"
              value={`${Math.round(record.salience * 100)}%`}
            />
            <MetaField
              label="Confidence"
              value={`${Math.round(record.confidence * 100)}%`}
            />
            <MetaField
              label="Created"
              value={new Date(record.createdAt).toLocaleString()}
            />
            <MetaField label="Author" value={record.provenance.author} />
            {record.provenance.tool && (
              <MetaField label="Tool" value={record.provenance.tool} />
            )}
            {record.provenance.model && (
              <MetaField label="Model" value={record.provenance.model} />
            )}
            {record.ttl && (
              <MetaField
                label="TTL"
                value={new Date(record.ttl).toLocaleString()}
              />
            )}
          </div>

          {/* Namespace */}
          <DetailSection title="Namespace">
            <div className="grid grid-cols-2 gap-2 text-xs">
              <MetaField label="Org" value={record.namespace.org} />
              <MetaField label="Workspace" value={record.namespace.workspace} />
              {record.namespace.session && (
                <MetaField label="Session" value={record.namespace.session} />
              )}
              {record.namespace.agent && (
                <MetaField label="Agent" value={record.namespace.agent} />
              )}
            </div>
          </DetailSection>

          {/* Body */}
          <DetailSection title="Body">
            <pre className="rounded-md bg-muted/60 p-3 text-[11px] leading-relaxed overflow-x-auto font-mono text-foreground whitespace-pre-wrap break-words">
              {JSON.stringify(record.body, null, 2)}
            </pre>
          </DetailSection>

          {/* Provenance */}
          <DetailSection title="Provenance">
            <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">Author:</span>{" "}
                {record.provenance.author}
              </p>
              <p>
                <span className="font-medium text-foreground">Timestamp:</span>{" "}
                {new Date(record.provenance.timestamp).toLocaleString()}
              </p>
              {record.provenance.derivedFrom.length > 0 && (
                <div>
                  <span className="font-medium text-foreground">
                    Derived from:
                  </span>
                  <ul className="mt-1 space-y-0.5">
                    {record.provenance.derivedFrom.map((id) => (
                      <li
                        key={id}
                        className="font-mono text-[10px] text-muted-foreground"
                      >
                        {id}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </DetailSection>

          {/* Causality DAG */}
          {record.causality.length > 0 && (
            <DetailSection title="Causality Chain">
              <ul className="space-y-0.5">
                {record.causality.map((id) => (
                  <li
                    key={id}
                    className="font-mono text-[10px] text-muted-foreground"
                  >
                    {id}
                  </li>
                ))}
              </ul>
            </DetailSection>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  );
}

function MetaField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium text-muted-foreground">
        {label}
      </span>
      <span className="text-xs text-foreground truncate">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MemoriesClient({
  initialRecords,
  orgId: _orgId,
  workspaceId: _workspaceId,
  orgSlug: _orgSlug,
  workspaceSlug: _workspaceSlug,
}: MemoriesClientProps) {
  const [records] = React.useState<SerializedRecord[]>(initialRecords);
  const [selectedRecord, setSelectedRecord] =
    React.useState<SerializedRecord | null>(null);
  const [activeKinds, setActiveKinds] = React.useState<Set<RecordKind>>(
    new Set(),
  );
  const [searchQuery, setSearchQuery] = React.useState("");
  const [minSalience, setMinSalience] = React.useState(0);

  const toggleKind = React.useCallback((kind: RecordKind) => {
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

  // Client-side filtering
  const filtered = React.useMemo(() => {
    return records.filter((r) => {
      // Kind filter
      if (activeKinds.size > 0 && !activeKinds.has(r.kind)) return false;
      // Salience filter
      if (r.salience < minSalience) return false;
      // Search filter
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const bodyStr = JSON.stringify(r.body).toLowerCase();
        const author = r.provenance.author.toLowerCase();
        const id = r.id.toLowerCase();
        if (!bodyStr.includes(q) && !author.includes(q) && !id.includes(q))
          return false;
      }
      return true;
    });
  }, [records, activeKinds, minSalience, searchQuery]);

  // Kind distribution for stats
  const kindCounts = React.useMemo(() => {
    const counts: Record<RecordKind, number> = {
      episodic: 0,
      semantic: 0,
      procedural: 0,
      entity: 0,
      edge: 0,
    };
    for (const r of records) counts[r.kind]++;
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
              Memory Records
            </p>
            <p className="text-xs text-muted-foreground">
              Content-addressed episodic events, semantic facts, and procedural
              rules written by agents during this workspace&apos;s sessions.
            </p>
          </div>
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
                className={`h-3.5 w-3.5 ${cfg.color.split(" ").slice(1).join(" ")}`}
              />
              <div className="flex flex-col">
                <span className="text-sm font-semibold tabular-nums text-foreground">
                  {kindCounts[kind]}
                </span>
                <span className="text-[10px] text-muted-foreground">
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
        minSalience={minSalience}
        setMinSalience={setMinSalience}
      />

      {/* Record list */}
      {filtered.length > 0 ? (
        <div className="rounded-lg border border-border/60 overflow-hidden">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5 bg-muted/30">
            <span className="text-[11px] font-medium text-muted-foreground">
              {filtered.length} record{filtered.length !== 1 ? "s" : ""}
              {activeKinds.size > 0 || minSalience > 0 || searchQuery
                ? " (filtered)"
                : ""}
            </span>
            <span className="text-[10px] text-muted-foreground">
              Sorted by most recent
            </span>
          </div>
          <div className="max-h-[600px] overflow-y-auto">
            {filtered.map((record) => (
              <MemoryRecordRow
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
              No memories found
            </p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              {records.length === 0
                ? "Memories will appear here as agents interact with this workspace."
                : "Try adjusting your filters to see more records."}
            </p>
          </div>
        </div>
      )}

      {/* Total footer */}
      <p className="text-[11px] text-muted-foreground">
        {records.length} total record{records.length !== 1 ? "s" : ""} in this
        workspace&apos;s episodic store.
      </p>

      {/* Detail sheet */}
      {selectedRecord && (
        <RecordDetail
          record={selectedRecord}
          onClose={() => setSelectedRecord(null)}
        />
      )}
    </div>
  );
}
