import { EdgeTypes, NodeLabels, scopedSession } from "@oxagen/ontology";
import {
  type AttemptEventReadRecord,
  isContextWindowEvent,
  ledgerContextWindows,
  type RecordedWindow,
} from "@oxagen/run-ledger";

// ── Graph projection of the context windows one run recorded ────────────────
//
// ARCHITECTURE (ADR-193; the same shape as tool-projection.ts): the run's
// model-call frames in the evidence ledger are the record. Each
// `model.engine_call_started` frame carries the request's window block by
// block, and `get_run_context` reads the window from there, never from Neo4j.
// This module reads those frames back for one sealed run and idempotently
// MERGEs a lineage of them:
//
//   (:Execution {id: executionRef})-[:USED_CONTEXT]->(:ContextManifest)
//
// one :ContextManifest per measured window. The execution is the turn's
// message, the same :Execution node the recall's citations hang on
// (`recordExecution`, memory/neo4j.ts), so the graph can say which windows a
// turn sent beside which memories it cited. A run no message asked for
// anchors on its own public id.
//
// Four-store boundary (CLAUDE.md): the projection writes STRUCTURE only: the
// run, the call, the frame, which blocks the window carried and how many
// items each held. It NEVER writes bytes, tokens or cost. Those stay on the
// frame, where the vendor's total is divided across the blocks at read time.
//
// Best-effort: the caller (the assistant run's seal) catches and logs a
// failure, and never lets it fail or slow the seal. No read depends on the
// edges, so a projection that never ran loses nothing but the lineage.
//
// Wrapped runs are not projected here: tacho records on the operator's
// machine and cannot reach Neo4j. A projector over ingested sessions can read
// them through the same `@oxagen/run-ledger` reader.

/** The most ledger events one projection reads, the same cap `get_run_context` uses. */
const EVENT_CAP = 20_000;
/** Events per page of that walk. */
const PAGE = 500;

export interface ProjectRunContextArgs {
  /** agent.agent_runs.id (the internal uuid). */
  runId: string;
  /** `arun_…`, stamped on each manifest and edge. */
  runPublicId: string;
  /** The :Execution the edges start at: the turn's message id, else the run's public id. */
  executionRef: string;
}

/** A page of the run's events after `afterRunSeq`, as `RunStore.readAttemptEventsSince` reads them. */
export type ReadRunEvents = (
  runId: string,
  afterRunSeq: string,
  limit: number,
) => Promise<AttemptEventReadRecord[]>;

/** The one Neo4j seam, so a test can record what the projection sent. */
export interface ProjectionSession {
  run(cypher: string, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

const EXECUTION_LABEL = NodeLabels.Execution;
const MANIFEST_LABEL = NodeLabels.ContextManifest;
const USED_CONTEXT = EdgeTypes.USED_CONTEXT;

// Three independently valid MERGE statements, each literally anchoring the
// tenant (`orgId: $orgId`), which the scoped session's guard requires.

// ON CREATE only, so the citation path keeps owning the node's other facts.
const MERGE_EXECUTION_CYPHER = /* cypher */ `
  MERGE (e:${EXECUTION_LABEL} {id: $executionRef, orgId: $orgId, workspaceId: $workspaceId})
  ON CREATE SET
    e:GraphNode,
    e.is_system = true,
    e.label = '${EXECUTION_LABEL}',
    e.publicId = coalesce(e.publicId, randomUUID()),
    e.run_id = $runPublicId,
    e.started_at = datetime()
`;

const MERGE_MANIFESTS_CYPHER = /* cypher */ `
  UNWIND $windows AS w
  MERGE (m:${MANIFEST_LABEL} {id: w.id, orgId: $orgId, workspaceId: $workspaceId})
  ON CREATE SET
    m:GraphNode,
    m.is_system = true,
    m.label = '${MANIFEST_LABEL}',
    m.publicId = w.publicId,
    m.createdAt = datetime()
  SET
    m.runId = $runPublicId,
    m.frameSeq = w.seq,
    m.modelCallId = w.modelCallId,
    m.blockKinds = w.kinds,
    m.blockItems = w.items,
    m.displayName = w.displayName,
    m.updatedAt = datetime()
`;

const MERGE_USED_CONTEXT_CYPHER = /* cypher */ `
  UNWIND $windows AS w
  MATCH (e:${EXECUTION_LABEL} {id: $executionRef, orgId: $orgId, workspaceId: $workspaceId})
  MATCH (m:${MANIFEST_LABEL} {id: w.id, orgId: $orgId, workspaceId: $workspaceId})
  MERGE (e)-[u:${USED_CONTEXT}]->(m)
  ON CREATE SET u.is_system = true
  SET
    u.runId = $runPublicId,
    u.frameSeq = w.seq,
    u.updatedAt = datetime()
`;

/**
 * One manifest node's parameters: its identity and the blocks the window
 * carried, never their bytes or tokens.
 *
 * @internal Exported for its test.
 */
export function manifestParams(runPublicId: string, window: RecordedWindow) {
  const carried = window.blocks.filter((block) => block.bytes > 0);
  const id = `${runPublicId}:${window.seq}`;
  return {
    id,
    // Graph-global, so the run's public id keeps two workspaces apart.
    publicId: `context-window:${id}`,
    seq: window.seq,
    modelCallId: window.modelCallId,
    kinds: carried.map((block) => block.kind),
    items: carried.map((block) => block.items),
    displayName: `Context window: ${runPublicId} frame ${window.seq}`,
  };
}

/** The run's context-window events, read page by page from its first frame. */
async function readWindowEvents(
  runId: string,
  readEvents: ReadRunEvents,
): Promise<AttemptEventReadRecord[]> {
  const kept: AttemptEventReadRecord[] = [];
  let after = "0";
  let walked = 0;
  for (;;) {
    const want = Math.min(PAGE, EVENT_CAP - walked);
    if (want <= 0) return kept;
    const page = await readEvents(runId, after, want);
    walked += page.length;
    for (const event of page)
      if (isContextWindowEvent(event.eventType)) kept.push(event);
    const last = page.at(-1);
    if (!last || page.length < want) return kept;
    after = last.runSeq;
  }
}

/**
 * Project the windows `runId` recorded into Neo4j as :ContextManifest nodes
 * joined to the turn's :Execution by :USED_CONTEXT edges. Reads the ledger's
 * current record, so it is safe to call again for the same run. Runs inside
 * the caller's tenant scope. A run that measured no window writes nothing.
 *
 * Returns the number of windows projected. Throws on a ledger or Neo4j
 * failure, deliberately: the caller catches and logs it, so a backfill sees
 * a real failure signal.
 */
export async function projectRunContextWindows(
  args: ProjectRunContextArgs,
  readEvents: ReadRunEvents,
  openSession: () => ProjectionSession = scopedSession,
): Promise<number> {
  const events = await readWindowEvents(args.runId, readEvents);
  const { windows } = ledgerContextWindows(events);
  if (windows.length === 0) return 0;
  const params = {
    executionRef: args.executionRef,
    runPublicId: args.runPublicId,
    windows: windows.map((window) => manifestParams(args.runPublicId, window)),
  };
  const s = openSession();
  try {
    await s.run(MERGE_EXECUTION_CYPHER, params);
    await s.run(MERGE_MANIFESTS_CYPHER, params);
    await s.run(MERGE_USED_CONTEXT_CYPHER, params);
  } finally {
    await s.close();
  }
  return windows.length;
}
