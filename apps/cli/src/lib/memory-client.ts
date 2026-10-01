/**
 * Typed client + formatters for the workspace AgentMemory capabilities.
 *
 * Wraps the org-scoped /v1 routes (agent/memory/list|remember|update|delete|
 * promote|promotion/candidates) the API exposes for the two-axis memory
 * contracts (docs/specs/two-axis-memory/DESIGN.md). Every call goes through
 * `apiPostOrThrow` so both the one-shot `oxagen memory`/`oxagen remember`
 * subcommands and the interactive REPL slash commands (/remember, /memories,
 * /forget) share one transport and one set of formatters — no drift between
 * the surfaces.
 *
 * Memory has two independent axes:
 *   - memoryClass  — epistemic status (the confidence ladder): OBSERVATION → RULE → FACT
 *   - memoryKind   — content domain (extensible open string)
 * and two independent weights:
 *   - confidenceScore (0-100) — how sure we are it is TRUE. Auto-decays, recovers on evidence.
 *   - enforcementScore (1-100, null for OBSERVATION) — how strongly it SHOULD be followed.
 */
import type {
  MarkdownImportPolicy,
  MarkdownImportRecord,
  MarkdownImportTarget,
} from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import type { SteeringMarkdownImportCommitOutput } from "@oxagen/oxagen/contracts/steering.markdown_import.commit";
import type { SteeringMarkdownImportParseOutput } from "@oxagen/oxagen/contracts/steering.markdown_import.parse";
import { apiPostOrThrow } from "./api.js";

export type MemoryClass = "OBSERVATION" | "RULE" | "FACT";
export type MemoryStatus = "ACTIVE" | "SUPERSEDED" | "RETRACTED" | "ARCHIVED";
export type ActorKind = "AGENT" | "USER" | "SYSTEM";
export type Influence = "DECISIVE" | "CONTRIBUTING" | "CONSIDERED" | "IGNORED";
export type Compliance = "COMPLIED" | "DISCRETION" | "VIOLATION" | "NA";
export type EvidenceSourceKind =
  | "CITATION"
  | "HUMAN_CONFIRM"
  | "CODE_SCAN"
  | "AGENT_JUDGE"
  | "REPEAT_OBSERVATION";

/**
 * Content domain is an open string per the schema, not a closed enum. This
 * mirrors `RECOMMENDED_MEMORY_KINDS` from `agent.memory.model` — the schema's
 * content domains plus the retained engineering kinds — for CLI hints only;
 * any non-empty string is accepted and stored verbatim.
 */
export type MemoryKind = string;

export const MEMORY_CLASSES: readonly MemoryClass[] = [
  "OBSERVATION",
  "RULE",
  "FACT",
];

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

/** Mirror of the shared agentMemoryRecordSchema returned by the API. */
export interface MemoryRecord {
  id: string;
  publicId: string;
  nodeRef: string;
  memoryClass: MemoryClass;
  memoryKind: string;
  lesson: string;
  source: string;
  confidenceScore: number;
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

export interface MemoryListResult {
  memories: MemoryRecord[];
  total: number;
}

export interface RememberResult {
  memory: MemoryRecord;
  inferred: {
    memoryClass: MemoryClass;
    memoryKind: MemoryKind;
    classified: boolean;
  };
}

export interface ListMemoriesOptions {
  memoryClass?: MemoryClass;
  memoryKind?: MemoryKind;
  minEnforcement?: number;
  minCitations?: number;
  sort?: "createdAt" | "citationCount";
  sortDir?: "asc" | "desc";
  nodeRef?: string;
  limit?: number;
  offset?: number;
}

/**
 * List the workspace's memories with optional filters, sorted by recency
 * (default) or citation count.
 */
export async function listMemories(
  opts: ListMemoriesOptions = {},
): Promise<MemoryListResult> {
  return apiPostOrThrow<MemoryListResult>("agent/memory/list", {
    memoryClass: opts.memoryClass,
    memoryKind: opts.memoryKind,
    minEnforcement: opts.minEnforcement,
    minCitations: opts.minCitations,
    sort: opts.sort,
    sortDir: opts.sortDir,
    nodeRef: opts.nodeRef,
    limit: opts.limit ?? 100,
    offset: opts.offset ?? 0,
  });
}

export interface RememberOptions {
  text: string;
  nodeRef?: string;
  memoryClass?: MemoryClass;
  memoryKind?: MemoryKind;
  enforcementScore?: number;
  source?: "user" | "feature" | "fix" | "exception-watcher" | "bug-report";
  relatedNodeIds?: string[];
}

/** Capture a free-text memory; the server infers class+kind unless pinned. */
export async function rememberMemory(
  opts: RememberOptions,
): Promise<RememberResult> {
  return apiPostOrThrow<RememberResult>("agent/memory/remember", opts);
}

/** One recalled memory row — mirrors the `agent.memory.recall` output rows. */
export interface RecalledMemory {
  id: string;
  nodeRef: string;
  memoryClass: MemoryClass;
  memoryKind: string;
  lesson: string;
  source: string;
  confidenceScore: number;
  enforcementScore: number | null;
  /** Semantic similarity score for the query (0-1). */
  score: number;
  createdAt: string;
}

export interface RecallMemoriesResult {
  memories: RecalledMemory[];
}

export interface RecallMemoriesOptions {
  query: string;
  limit?: number;
  memoryClass?: MemoryClass;
  minEnforcement?: number;
  nodeRef?: string;
  /**
   * When set, the server auto-records an :Execution and CONSIDERED citations for
   * every recalled memory — the citation pressure that surfaces promotion
   * candidates (the self-improvement flywheel). Omit for a pure read.
   */
  executionRef?: string;
  /** Agent id stamped on the auto-recorded execution (paired with executionRef). */
  agentId?: string;
}

/**
 * Recall workspace memories by semantic similarity to `query`, scoped to the
 * caller's workspace. Backs the coding agent's pre-task recall so it doesn't
 * re-discover known issues; pass an `executionRef` to auto-cite the results.
 */
export async function recallMemories(
  opts: RecallMemoriesOptions,
): Promise<RecallMemoriesResult> {
  return apiPostOrThrow<RecallMemoriesResult>("agent/memory/recall", {
    query: opts.query,
    limit: opts.limit ?? 6,
    memoryClass: opts.memoryClass,
    minEnforcement: opts.minEnforcement,
    nodeRef: opts.nodeRef,
    executionRef: opts.executionRef,
    agentId: opts.agentId,
  });
}

export interface UpdateMemoryOptions {
  memoryId: string;
  lesson?: string;
  memoryKind?: MemoryKind;
  source?: string;
  confidenceScore?: number;
  enforcementScore?: number;
  status?: MemoryStatus;
}

/** Edit a memory's lesson, kind, source, confidence/enforcement, or status. */
export async function updateMemory(
  opts: UpdateMemoryOptions,
): Promise<MemoryRecord> {
  return apiPostOrThrow<MemoryRecord>("agent/memory/update", opts);
}

/** Permanently delete a memory by id. */
export async function deleteMemory(
  memoryId: string,
): Promise<{ deleted: boolean; memoryId: string }> {
  return apiPostOrThrow<{ deleted: boolean; memoryId: string }>(
    "agent/memory/delete",
    {
      memoryId,
    },
  );
}

export interface PromoteMemoryOptions {
  memoryId: string;
  toClass: "RULE" | "FACT";
  enforcementScore?: number;
  /** Optional — a rationale is no longer required to promote. */
  rationale?: string;
  basedOnEvidenceIds?: string[];
}

/**
 * Promote a memory up the confidence ladder (OBSERVATION → RULE → FACT),
 * recording an auditable :Promotion event. FACT requires human confirmation
 * server-side and forces enforcement 100.
 */
export async function promoteMemory(
  opts: PromoteMemoryOptions,
): Promise<MemoryRecord> {
  return apiPostOrThrow<MemoryRecord>("agent/memory/promote", opts);
}

export interface DemoteMemoryOptions {
  memoryId: string;
  toClass: "RULE" | "OBSERVATION";
  enforcementScore?: number;
  rationale?: string;
}

/**
 * Demote a memory down the confidence ladder (FACT → RULE → OBSERVATION),
 * recording an auditable :Demotion event. Demoting to OBSERVATION clears
 * enforcement; leaving FACT clears human confirmation. The server rejects a
 * non-downward target.
 */
export async function demoteMemory(
  opts: DemoteMemoryOptions,
): Promise<MemoryRecord> {
  return apiPostOrThrow<MemoryRecord>("agent/memory/demote", opts);
}

export interface DismissPromotionResult {
  memoryId: string;
  dismissed: boolean;
}

/**
 * Dismiss a memory from the promotion-candidate queue (or restore it), freeing
 * the slot for the next candidate without archiving the memory.
 */
export async function dismissPromotion(opts: {
  memoryId: string;
  restore?: boolean;
}): Promise<DismissPromotionResult> {
  return apiPostOrThrow<DismissPromotionResult>(
    "agent/memory/promotion/dismiss",
    {
      memoryId: opts.memoryId,
      restore: opts.restore ?? false,
    },
  );
}

export interface PromotionCandidate {
  id: string;
  publicId: string;
  lesson: string;
  memoryKind: MemoryKind;
  citationCount: number;
  influenceCount: number;
  confidenceScore: number;
}

export interface PromotionCandidatesResult {
  candidates: PromotionCandidate[];
}

/** List the top OBSERVATION memories by citation pressure ripe for promotion. */
export async function promotionCandidates(
  opts: { limit?: number } = {},
): Promise<PromotionCandidatesResult> {
  return apiPostOrThrow<PromotionCandidatesResult>(
    "agent/memory/promotion/candidates",
    {
      limit: opts.limit ?? 3,
    },
  );
}

// ── Agent-runtime verbs (cite/evidence) — lightweight wrappers ───────────────
// These back agent execution telemetry rather than a dedicated CLI subcommand,
// but are trivial pass-throughs kept here so any future CLI surface (or an
// agent script run from the shell) shares the same transport.

export interface CiteMemoriesOptions {
  executionRef: string;
  agentId?: string;
  runId?: string;
  taskSummary?: string;
  citations: Array<{
    memoryId: string;
    influence: Influence;
    deviated?: boolean;
    expectedValue?: string;
    observedValue?: string;
    agentRationale?: string;
  }>;
}

export interface CiteMemoriesResult {
  executionId: string;
  results: Array<{
    memoryId: string;
    ok: boolean;
    citationId: string | null;
    compliance: Compliance;
    error: string | null;
  }>;
  recorded: number;
}

/** Record citations of memories within an agent execution. */
export async function citeMemories(
  opts: CiteMemoriesOptions,
): Promise<CiteMemoriesResult> {
  return apiPostOrThrow<CiteMemoriesResult>("agent/memory/cite", opts);
}

export interface AttachEvidenceOptions {
  memoryId: string;
  sourceKind: EvidenceSourceKind;
  strength: number;
  detail?: string;
  refutes?: boolean;
}

/** Attach supporting or refuting evidence to a memory, adjusting its confidence. */
export async function attachEvidence(
  opts: AttachEvidenceOptions,
): Promise<{ evidenceId: string; confidenceScore: number }> {
  return apiPostOrThrow<{ evidenceId: string; confidenceScore: number }>(
    "agent/memory/evidence/attach",
    opts,
  );
}

export interface ListCitationsOptions {
  executionId: string;
  compliance?: Compliance;
  influenceIn?: Influence[];
}

export interface ListCitationsResult {
  citations: Array<{
    citationId: string;
    memoryId: string;
    lesson: string;
    influence: Influence;
    compliance: Compliance;
    enforcementAtCite: number | null;
    expectedValue: string | null;
    observedValue: string | null;
    agentRationale: string | null;
  }>;
}

/** List memory citations recorded for an execution. */
export async function listCitations(
  opts: ListCitationsOptions,
): Promise<ListCitationsResult> {
  return apiPostOrThrow<ListCitationsResult>(
    "agent/memory/citations/list",
    opts,
  );
}

/** One cited-memory row in the citation-stats rollup. */
export interface CitedMemoryStat {
  memoryId: string;
  publicId: string;
  lesson: string;
  memoryClass: MemoryClass;
  memoryKind: string;
  citationCount: number;
  decisiveCount: number;
  contributingCount: number;
  consideredCount: number;
  ignoredCount: number;
  violationCount: number;
}

/** One cited-node row (resolved to a friendly ref) in the citation-stats rollup. */
export interface CitedNodeStat {
  node: {
    id: string | null;
    label: string;
    displayName: string;
    properties: Record<string, unknown>;
  };
  citationCount: number;
  decisiveCount: number;
  ignoredCount: number;
}

/** Output of `agent.memory.citations.stats` — the workspace citation rollup. */
export interface CitationStatsResult {
  totals: {
    citations: number;
    executions: number;
    memoriesCited: number;
    nodesCited: number;
  };
  byInfluence: Record<string, number>;
  byCompliance: Record<string, number>;
  daily: Array<{ date: string; citations: number; violations: number }>;
  topMemories: CitedMemoryStat[];
  leastUsefulMemories: CitedMemoryStat[];
  mostViolatedRules: CitedMemoryStat[];
  topNodes: CitedNodeStat[];
}

/**
 * Workspace-wide citation analytics across all executions: totals, influence /
 * compliance breakdowns, a daily series, and the most-cited / least-useful /
 * most-violated memories plus most-cited graph nodes.
 */
export async function citationStats(
  opts: { days?: number; limit?: number } = {},
): Promise<CitationStatsResult> {
  return apiPostOrThrow<CitationStatsResult>("agent/memory/citations/stats", {
    days: opts.days ?? 30,
    limit: opts.limit ?? 10,
  });
}

// ── Formatters (shared by the CLI subcommands and the REPL slash commands) ──────

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

/** A one-line class/kind reference badge. */
function badges(m: MemoryRecord): string {
  return `${m.memoryClass}/${m.memoryKind}`;
}

function fmtEnforcement(enforcementScore: number | null): string {
  return enforcementScore === null ? "—" : String(enforcementScore);
}

/**
 * Render a memory list as an aligned table string (so the REPL can print it via
 * the TUI and the CLI can write it to stdout from the same code).
 */
export function formatMemoryLines(result: MemoryListResult): string {
  if (result.memories.length === 0) {
    return 'No memories yet. Capture one with `/remember <text>` (or `oxagen remember "…"`).';
  }
  const rows = result.memories.map((m) => {
    const id = m.id.slice(0, 8);
    const conf = m.confidenceScore.toFixed(1);
    const enf = fmtEnforcement(m.enforcementScore).padStart(3);
    return `${id}  ${badges(m).padEnd(26)} ${conf.padStart(5)}  ${enf}  ${truncate(m.lesson, 60)}`;
  });
  const header = `${"id".padEnd(8)}  ${"class/kind".padEnd(26)} ${"conf".padStart(5)}  enf  lesson`;
  const shown = result.memories.length;
  const footer =
    result.total > shown
      ? `\nShowing ${shown} of ${result.total}. Use --limit / --offset to page.`
      : `\n${result.total} ${result.total === 1 ? "memory" : "memories"}.`;
  return [header, ...rows].join("\n") + footer;
}

/** Render a single memory in full detail. */
export function formatMemoryDetail(m: MemoryRecord): string {
  return [
    `Memory ${m.id}`,
    `  lesson:      ${m.lesson}`,
    `  memoryKind:  ${m.memoryKind}`,
    `  memoryClass: ${m.memoryClass}`,
    `  confidence:  ${m.confidenceScore.toFixed(1)}`,
    `  enforcement: ${fmtEnforcement(m.enforcementScore)}`,
    `  status:      ${m.status}`,
    `  source:      ${m.source}`,
    `  nodeRef:     ${m.nodeRef || "(none)"}`,
    `  subjectHint: ${m.subjectHint || "(none)"}`,
    `  citations:   ${m.citationCount} (influence ${m.influenceCount}, violations ${m.violationCount})`,
    `  created:     ${m.createdAt}`,
    `  lastEvidence:${m.lastEvidenceAt ?? "(never)"}`,
    `  publicId:    ${m.publicId}`,
  ].join("\n");
}

/** Render the result of a /remember capture. */
export function formatRememberResult(r: RememberResult): string {
  const how = r.inferred.classified ? "inferred" : "set";
  return (
    `✓ Remembered — class ${r.inferred.memoryClass}, kind ${r.inferred.memoryKind} (${how}).\n` +
    `  id: ${r.memory.id}\n` +
    `  ${truncate(r.memory.lesson, 100)}`
  );
}

/** Render the result of a promotion. */
export function formatPromoteResult(m: MemoryRecord): string {
  return (
    `✓ Promoted to ${m.memoryClass} — enforcement ${fmtEnforcement(m.enforcementScore)} (${m.id}).\n` +
    `  ${truncate(m.lesson, 100)}`
  );
}

/** Render the result of a demotion. */
export function formatDemoteResult(m: MemoryRecord): string {
  return (
    `✓ Demoted to ${m.memoryClass} — enforcement ${fmtEnforcement(m.enforcementScore)} (${m.id}).\n` +
    `  ${truncate(m.lesson, 100)}`
  );
}

/** Render the result of a promotion-candidate dismissal (or restore). */
export function formatDismissResult(r: DismissPromotionResult): string {
  return r.dismissed
    ? `✓ Dismissed ${r.memoryId} from the promotion queue.`
    : `✓ Restored ${r.memoryId} to the promotion queue.`;
}

/** Render the citation-stats rollup as a compact multi-section summary. */
export function formatCitationStats(result: CitationStatsResult): string {
  const { totals } = result;
  const lines: string[] = [
    `Citations: ${totals.citations} across ${totals.executions} execution${totals.executions === 1 ? "" : "s"} — ${totals.memoriesCited} memories, ${totals.nodesCited} nodes cited.`,
  ];

  const influence = Object.entries(result.byInfluence);
  if (influence.length > 0) {
    lines.push(
      `  influence: ${influence.map(([k, v]) => `${k} ${v}`).join(", ")}`,
    );
  }
  const compliance = Object.entries(result.byCompliance);
  if (compliance.length > 0) {
    lines.push(
      `  compliance: ${compliance.map(([k, v]) => `${k} ${v}`).join(", ")}`,
    );
  }

  const memRow = (m: CitedMemoryStat): string =>
    `    ${m.memoryId.slice(0, 8)}  cites:${String(m.citationCount).padStart(3)} dec:${String(m.decisiveCount).padStart(3)} viol:${String(m.violationCount).padStart(3)}  ${truncate(m.lesson, 48)}`;

  if (result.topMemories.length > 0) {
    lines.push("\nMost-cited memories:");
    lines.push(...result.topMemories.map(memRow));
  }
  if (result.leastUsefulMemories.length > 0) {
    lines.push("\nLeast-useful (cited but never influential):");
    lines.push(...result.leastUsefulMemories.map(memRow));
  }
  if (result.mostViolatedRules.length > 0) {
    lines.push("\nMost-violated rules:");
    lines.push(...result.mostViolatedRules.map(memRow));
  }
  if (result.topNodes.length > 0) {
    lines.push("\nMost-cited graph nodes:");
    lines.push(
      ...result.topNodes.map(
        (n) =>
          `    ${n.node.displayName} [${n.node.label}]  cites:${String(n.citationCount).padStart(3)} dec:${String(n.decisiveCount).padStart(3)}`,
      ),
    );
  }

  return lines.join("\n");
}

/** Render the promotion-candidates list as an aligned table string. */
export function formatPromotionCandidates(
  result: PromotionCandidatesResult,
): string {
  if (result.candidates.length === 0) {
    return "No promotion candidates right now — no OBSERVATIONs have enough citation pressure yet.";
  }
  const rows = result.candidates.map((c) => {
    const id = c.id.slice(0, 8);
    const conf = c.confidenceScore.toFixed(1).padStart(5);
    return `${id}  ${c.memoryKind.padEnd(22)} cites:${String(c.citationCount).padStart(3)} influence:${String(c.influenceCount).padStart(3)} conf:${conf}  ${truncate(c.lesson, 50)}`;
  });
  const header = `${"id".padEnd(8)}  ${"kind".padEnd(22)} ${"cites".padStart(9)} ${"influence".padStart(13)} ${"conf".padStart(9)}  lesson`;
  return [header, ...rows].join("\n");
}

// ── Markdown import (parse_markdown_import + commit_markdown_import) ─────────

/** The most files one parse call takes. Larger imports go in calls of this size. */
export const MARKDOWN_IMPORT_FILES_PER_CALL = 25;

/** One file the import reads, with the target it is read as. */
export interface MarkdownImportDocumentInput {
  filename: string;
  content: string;
  target?: MarkdownImportTarget;
}

/**
 * Call `parse_markdown_import`: split each file into proposed steering
 * records, each with a kind, a force, and any duplicate or conflict. Writes
 * nothing.
 */
export async function parseMarkdownImport(
  documents: MarkdownImportDocumentInput[],
): Promise<SteeringMarkdownImportParseOutput> {
  return apiPostOrThrow<SteeringMarkdownImportParseOutput>(
    "context/steering/import/parse",
    { documents },
  );
}

/**
 * Call `commit_markdown_import`: open one steering PR with every row marked
 * add. Nothing steers until the PR merges.
 */
export async function commitMarkdownImport(input: {
  records: MarkdownImportRecord[];
  policies?: MarkdownImportPolicy[];
}): Promise<SteeringMarkdownImportCommitOutput> {
  return apiPostOrThrow<SteeringMarkdownImportCommitOutput>(
    "context/steering/import/commit",
    { records: input.records, policies: input.policies ?? [] },
  );
}

/** What a row's mark column shows: its duplicate, its conflict, or nothing. */
function importMark(row: MarkdownImportRecord): string {
  if (row.conflict) return `conflicts with ${row.conflict.lineage}`;
  if (row.duplicate) return `duplicate of ${row.duplicate.lineage}`;
  return "";
}

/**
 * The proposed records as a numbered table: source, kind, force with the
 * words that justify it, the action, any duplicate or conflict, and the
 * statement. A must or should row adds its tokens to every request, so the
 * table ends with that total.
 */
export function formatImportRows(rows: MarkdownImportRecord[]): string {
  if (rows.length === 0) return "No records were proposed.";
  const header =
    `${"#".padEnd(4)}  ${"source".padEnd(24)} ${"kind".padEnd(22)}` +
    ` ${"force".padEnd(7)} ${"action".padEnd(7)} statement`;
  const lines = rows.map((row, i) => {
    const kind = row.effect ? `${row.kind} (${row.effect})` : row.kind;
    const source = truncate(`${row.file}:${row.line}`, 24).padEnd(24);
    const action = (row.action ?? "choose").padEnd(7);
    const words = row.forceWords ? ` "${row.forceWords}"` : "";
    const mark = importMark(row);
    return (
      `${String(i + 1).padEnd(4)}  ${source} ${kind.padEnd(22)} ${row.force.padEnd(7)} ${action} ${truncate(row.statement, 60)}` +
      (words || mark ? `\n      ${[words.trim(), mark].filter(Boolean).join(". ")}` : "")
    );
  });
  const alwaysOn = rows
    .filter((row) => row.action === "add" && (row.force === "must" || row.force === "should"))
    .reduce((sum, row) => sum + row.tokens, 0);
  const count = rows.length;
  return (
    [header, ...lines].join("\n") +
    `\n${count} proposed ${count === 1 ? "record" : "records"}. The must and should rows marked add load ${alwaysOn} tokens on every request.`
  );
}

/** The commit result: the steering PR, and what it holds. */
export function formatImportPullRequest(
  output: SteeringMarkdownImportCommitOutput,
): string {
  const noun = output.records === 1 ? "record" : "records";
  const lines = [
    `Opened steering PR #${output.pullRequest.number} on ${output.pullRequest.branch} with ${output.records} ${noun}.`,
    output.pullRequest.url,
  ];
  if (output.skipped > 0) {
    lines.push(`${output.skipped} ${output.skipped === 1 ? "row was" : "rows were"} left out.`);
  }
  lines.push("Nothing steers an agent until the PR merges.");
  return lines.join("\n");
}
