/**
 * page.tsx — Workspace → Knowledge → Memories (static mock).
 *
 * Static presentational mock — zero withTenantDb / invoke() dependencies.
 * Wire-up target: knowledge.memories.list + knowledge.memories.create
 *                 capabilities (agent_memories table, Neo4j).
 *
 * Memories are workspace-scoped rules, facts, and agent-proposed lessons that
 * persist across sessions and inform every agent run.
 */
import {
  Info,
  BrainCircuit,
  Plus,
  User,
  Bot,
  Lightbulb,
  Trash2,
  Pin,
} from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

type MemoryKind = "rule" | "fact" | "lesson" | "preference";
type MemorySource = "user" | "agent";

interface MockMemory {
  id: string;
  kind: MemoryKind;
  source: MemorySource;
  content: string;
  pinned: boolean;
  confidence: number;
  createdAt: string;
  usedCount: number;
}

const MOCK_MEMORIES: MockMemory[] = [
  {
    id: "mem-01",
    kind: "rule",
    source: "user",
    content: "Always write output in British English. Use -ise not -ize, favour not favor.",
    pinned: true,
    confidence: 1,
    createdAt: "2026-05-10",
    usedCount: 142,
  },
  {
    id: "mem-02",
    kind: "preference",
    source: "user",
    content: "Format code output with 2-space indentation. TypeScript preferred over plain JavaScript.",
    pinned: true,
    confidence: 1,
    createdAt: "2026-05-12",
    usedCount: 88,
  },
  {
    id: "mem-03",
    kind: "fact",
    source: "agent",
    content: "The primary project management tool for this workspace is Linear, using the oxagen-v2 project.",
    pinned: false,
    confidence: 0.97,
    createdAt: "2026-05-18",
    usedCount: 34,
  },
  {
    id: "mem-04",
    kind: "lesson",
    source: "agent",
    content: "When generating Stripe API calls, always verify idempotency keys are unique per request to avoid duplicate charges.",
    pinned: false,
    confidence: 0.91,
    createdAt: "2026-06-01",
    usedCount: 12,
  },
  {
    id: "mem-05",
    kind: "fact",
    source: "user",
    content: "Mac Anderson (mac@oxagen.ai) is the workspace owner and primary stakeholder for all engineering decisions.",
    pinned: false,
    confidence: 1,
    createdAt: "2026-05-20",
    usedCount: 67,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const KIND_CONFIG: Record<MemoryKind, { label: string; className: string }> = {
  rule: { label: "Rule", className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" },
  fact: { label: "Fact", className: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" },
  lesson: { label: "Lesson", className: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  preference: { label: "Preference", className: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300" },
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function MemoryRow({ memory }: { memory: MockMemory }) {
  const kind = KIND_CONFIG[memory.kind];
  const SourceIcon = memory.source === "user" ? User : Bot;
  return (
    <li className="flex items-start justify-between gap-3 border-b border-border/40 px-4 py-4 last:border-b-0">
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${kind.className}`}>
            {kind.label}
          </span>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <SourceIcon className="h-3 w-3" aria-hidden="true" />
            {memory.source === "user" ? "User-authored" : "Agent-proposed"}
          </span>
          {memory.pinned && (
            <span className="flex items-center gap-1 text-[11px] font-medium text-primary">
              <Pin className="h-3 w-3" aria-hidden="true" />
              Pinned
            </span>
          )}
        </div>
        <p className="text-sm text-foreground">{memory.content}</p>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>Added {memory.createdAt}</span>
          <span>Used {memory.usedCount}× in runs</span>
          {memory.confidence < 1 && (
            <span>Confidence {Math.round(memory.confidence * 100)}%</span>
          )}
        </div>
      </div>
      <button
        type="button"
        aria-label="Delete memory"
        className="flex-shrink-0 rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function KnowledgeMemoriesPage() {
  const pinned = MOCK_MEMORIES.filter((m) => m.pinned);
  const rest = MOCK_MEMORIES.filter((m) => !m.pinned);

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      {/* Preview pill */}
      <div className="flex items-center justify-end">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" aria-hidden="true" />
          Preview · not yet wired to live data
        </span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <BrainCircuit className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-foreground">Memories</p>
            <p className="text-xs text-muted-foreground">
              Workspace-scoped rules, facts, preferences, and agent-proposed lessons.
              Memories persist across sessions and inform every agent run in this workspace.
            </p>
          </div>
        </div>
        <button
          type="button"
          className="flex flex-shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add memory
        </button>
      </div>

      {/* Agent-proposed note */}
      <div className="flex items-start gap-2 rounded-lg border border-blue-200/60 bg-blue-50/60 px-4 py-3 dark:border-blue-900/40 dark:bg-blue-950/20">
        <Lightbulb className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
        <p className="text-xs text-blue-700 dark:text-blue-300">
          Agents can propose new memories during runs. Proposals appear here for review before
          they are pinned and applied. Unpinned agent lessons are used with a confidence weight.
        </p>
      </div>

      {/* Pinned memories */}
      {pinned.length > 0 && (
        <div className="rounded-lg border border-border/60">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <Pin className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Pinned ({pinned.length})
            </span>
          </div>
          <ul>
            {pinned.map((m) => (
              <MemoryRow key={m.id} memory={m} />
            ))}
          </ul>
        </div>
      )}

      {/* Other memories */}
      {rest.length > 0 && (
        <div className="rounded-lg border border-border/60">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              All memories ({rest.length})
            </span>
          </div>
          <ul>
            {rest.map((m) => (
              <MemoryRow key={m.id} memory={m} />
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {MOCK_MEMORIES.length} memories total — applied to all agent runs in this workspace.
      </p>
    </div>
  );
}
