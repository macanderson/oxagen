/**
 * page.tsx — Workspace → Knowledge → Graph (static mock).
 *
 * Static presentational mock — zero server/DB/handler dependencies.
 * Wire-up target: knowledge.graph.stats + ontology explorer (Neo4j, reagraph).
 */
import { Info, GitGraph, Circle, ArrowRight } from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

interface MockNodeType {
  label: string;
  count: number;
  color: string;
}

interface MockEdgeType {
  label: string;
  count: number;
  fromType: string;
  toType: string;
}

const NODE_TYPES: MockNodeType[] = [
  { label: "Person",     count: 148,  color: "#6366f1" },
  { label: "Company",    count: 52,   color: "#22c55e" },
  { label: "Project",    count: 237,  color: "#f59e0b" },
  { label: "Document",   count: 1284, color: "#3b82f6" },
  { label: "Ticket",     count: 412,  color: "#8b5cf6" },
  { label: "Concept",    count: 96,   color: "#ec4899" },
];

const EDGE_TYPES: MockEdgeType[] = [
  { label: "AUTHORED",     count: 842,  fromType: "Person",   toType: "Document" },
  { label: "ASSIGNED_TO",  count: 412,  fromType: "Ticket",   toType: "Person" },
  { label: "REFERENCES",   count: 1204, fromType: "Document", toType: "Concept" },
  { label: "MEMBER_OF",    count: 148,  fromType: "Person",   toType: "Company" },
  { label: "LINKED_TO",    count: 580,  fromType: "Ticket",   toType: "Project" },
];

const totalNodes = NODE_TYPES.reduce((s, n) => s + n.count, 0);
const totalEdges = EDGE_TYPES.reduce((s, e) => s + e.count, 0);

// ── Components ────────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function NodeTypeRow({ nt }: { nt: MockNodeType }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="flex items-center gap-2">
        <Circle className="h-3 w-3 flex-shrink-0" style={{ color: nt.color, fill: nt.color }} aria-hidden="true" />
        <span className="text-sm text-foreground">{nt.label}</span>
      </div>
      <span className="text-sm tabular-nums text-muted-foreground">{nt.count.toLocaleString()}</span>
    </li>
  );
}

function EdgeTypeRow({ et }: { et: MockEdgeType }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">{et.fromType}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
        <code className="font-mono font-medium text-foreground">{et.label}</code>
        <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
        <span className="text-muted-foreground">{et.toType}</span>
      </div>
      <span className="text-sm tabular-nums text-muted-foreground">{et.count.toLocaleString()}</span>
    </li>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function KnowledgeGraphPage() {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      {/* Preview pill */}
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" aria-hidden="true" />
          Preview · not yet wired to live data
        </span>
      </div>

      <div className="flex items-center gap-2">
        <GitGraph className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p className="text-base font-semibold text-foreground">Ontology explorer</p>
      </div>

      <p className="text-sm text-muted-foreground">
        Inspect nodes, edges, and merge policies for the workspace knowledge graph. Navigate relationships between entities ingested from connected sources.
      </p>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Total nodes" value={totalNodes.toLocaleString()} />
        <StatCard label="Total edges" value={totalEdges.toLocaleString()} />
        <StatCard label="Node types" value={String(NODE_TYPES.length)} />
      </div>

      <div className="grid grid-cols-2 gap-5">
        {/* Node types */}
        <div className="rounded-lg border border-border/60 bg-card px-4 py-3">
          <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Node types</p>
          <ul className="divide-y divide-border/40">
            {NODE_TYPES.map((nt) => (
              <NodeTypeRow key={nt.label} nt={nt} />
            ))}
          </ul>
        </div>

        {/* Edge types */}
        <div className="rounded-lg border border-border/60 bg-card px-4 py-3">
          <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Edge types</p>
          <ul className="divide-y divide-border/40">
            {EDGE_TYPES.map((et) => (
              <EdgeTypeRow key={et.label} et={et} />
            ))}
          </ul>
        </div>
      </div>

      {/* Interactive explorer placeholder */}
      <div className="flex h-56 items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/20">
        <div className="flex flex-col items-center gap-2 text-center">
          <GitGraph className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
          <p className="text-sm font-medium text-muted-foreground">Interactive graph explorer</p>
          <p className="text-xs text-muted-foreground">Reagraph WebGL visualisation — available once wired to live Neo4j data.</p>
        </div>
      </div>
    </div>
  );
}
