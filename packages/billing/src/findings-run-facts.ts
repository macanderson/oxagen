/**
 * findings-run-facts.ts — the per-run reads the findings pass adds to the
 * run rows and frames (ADR-210): each run's frame source, its first prompt,
 * whether it changed a file, its compactions, and its pull request outcomes.
 *
 * A wrapped run's prompts and compactions are `tacho_events` rows, read
 * through `chSelect` inside the workspace's tenant scope. Its file changes
 * are `tacho.session_files` rows, and its outcomes are `cost.run_pr_outcomes`
 * rows, both read on the system connection with explicit org and workspace
 * predicates, as the rest of the findings store reads. A ledger run records
 * no prompt, compaction, or file change in these tables, so it is absent from
 * those three maps.
 */
import { schema, withSystemDb } from "@oxagen/database";
import { chSelect, type FrameRunRef } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { RunTotalsRecord } from "./cost-rollup";
import {
  microsOf,
  type RunCompaction,
  type RunFirstPrompt,
} from "./findings/shared";
import type { OutcomeRow } from "./run-pr-outcomes";
import { readOutcomeRows } from "./run-pr-outcomes-store";

const sessions = schema.tachoSessions;
const files = schema.tachoSessionFiles;
const ledgerRuns = schema.agentRuns;

type Scope = { orgId: string; workspaceId: string };

/** Ids one statement names at most. */
export const RUN_FACTS_CHUNK = 1_000;

/**
 * How far before the window's start a frame may have been received. A run
 * that started in the window can record its first frames before the start
 * on a skewed clock, and the bound keeps the read on the recent partitions.
 */
const RECEIVED_SLACK = "INTERVAL 1 DAY";

function chunks<T>(items: readonly T[], size = RUN_FACTS_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** A Date as a ClickHouse `DateTime64(3)` parameter, in UTC. */
function chDateTime(at: Date): string {
  return at.toISOString().replace("T", " ").replace("Z", "");
}

/** A string column's value, or null when it is empty or absent. */
function text(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : value;
}

/** A count column's value, or null when it is absent. */
function count(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Each run's frame source, by run public id. A wrapped run names its root
 * session and every subagent session under it. A ledger run names its run
 * row, and the message that asked for it when there is one (#4167). A run
 * with no root session in `runIdBySession`, or no v2 ledger row, is absent.
 */
export async function readRunRefs(
  scope: Scope,
  runs: readonly RunTotalsRecord[],
  runIdBySession: ReadonlyMap<string, string>,
): Promise<Map<string, FrameRunRef>> {
  const tachoIds = new Set(
    runs.filter((r) => r.runSource === "tacho").map((r) => r.runId),
  );
  const rootByRun = new Map<string, string>();
  for (const [root, runId] of runIdBySession)
    if (tachoIds.has(runId)) rootByRun.set(runId, root);
  const ledgerIds = runs
    .filter((r) => r.runSource === "ledger")
    .map((r) => r.runId);

  const children = new Map<string, string[]>();
  const ledger = new Map<string, FrameRunRef>();
  // tenancy: the scheduled findings job runs outside a tenant scope, and every
  // statement here is filtered by the pass's orgId and workspaceId.
  await withSystemDb(async (tx) => {
    for (const roots of chunks([...rootByRun.values()])) {
      const rows = await tx
        .select({
          sessionUuid: sessions.sessionUuid,
          rootSessionUuid: sessions.rootSessionUuid,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
            inArray(sessions.rootSessionUuid, roots),
            ne(sessions.sessionUuid, sessions.rootSessionUuid),
          ),
        );
      for (const r of rows) {
        const list = children.get(r.rootSessionUuid) ?? [];
        list.push(r.sessionUuid);
        children.set(r.rootSessionUuid, list);
      }
    }
    for (const ids of chunks(ledgerIds)) {
      const rows = await tx
        .select({
          publicId: ledgerRuns.publicId,
          runUuid: ledgerRuns.id,
          originMessageId: ledgerRuns.originMessageId,
        })
        .from(ledgerRuns)
        .where(
          and(
            eq(ledgerRuns.orgId, scope.orgId),
            eq(ledgerRuns.workspaceId, scope.workspaceId),
            inArray(ledgerRuns.publicId, ids),
            eq(ledgerRuns.specVersion, 2),
          ),
        );
      for (const r of rows)
        ledger.set(r.publicId, {
          kind: "ledger",
          runUuid: r.runUuid,
          originMessageId: r.originMessageId,
        });
    }
  });

  const out = new Map<string, FrameRunRef>(ledger);
  for (const [runId, root] of rootByRun)
    out.set(runId, {
      kind: "tacho",
      rootSessionUuid: root,
      sessionUuids: [root, ...(children.get(root) ?? []).sort()],
    });
  return out;
}

interface FirstPromptRow {
  root: string;
  at: string;
  prompt_digest: string;
  prompt_source: string | null;
  prompt_origin: string | null;
  command_name: string | null;
}

/**
 * The first `turn_start` frame with a prompt on each root's own chain. A
 * slash command is kept, with its name, so a detector can tell it from typed
 * text. A text column takes an alias of its own, since a ClickHouse alias
 * that names a column replaces the column everywhere in the query.
 */
const FIRST_PROMPTS_QUERY = `SELECT toString(root_session_uuid) AS root,
  formatDateTime(ts, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS at,
  prompt_digest, prompt_source, prompt_origin, command_name
  FROM tacho_events FINAL
  WHERE kind = 'turn_start'
    AND root_session_uuid IN {roots:Array(UUID)}
    AND session_uuid = root_session_uuid
    AND received_at >= {from:DateTime64(3)} - ${RECEIVED_SLACK}
    AND prompt_digest != ''
  ORDER BY root_session_uuid, ts, seq
  LIMIT 1 BY root_session_uuid`;

/**
 * Each wrapped run's first prompt, by run public id. `rootByRun` maps a run's
 * public id to its root session uuid. A run that recorded no prompt is
 * absent.
 */
export async function readFirstPrompts(
  scope: Scope,
  rootByRun: ReadonlyMap<string, string>,
  from: Date,
): Promise<Map<string, RunFirstPrompt>> {
  const runByRoot = new Map<string, string>();
  for (const [runId, root] of rootByRun) runByRoot.set(root, runId);
  const out = new Map<string, RunFirstPrompt>();
  for (const roots of chunks([...runByRoot.keys()])) {
    const result = await runInTenantScope(scope, () =>
      chSelect<FirstPromptRow>({
        query: FIRST_PROMPTS_QUERY,
        params: { roots, from: chDateTime(from) },
      }),
    );
    for (const r of result.data) {
      const runId = runByRoot.get(r.root);
      if (runId === undefined) continue;
      out.set(runId, {
        at: new Date(r.at),
        atMicros: microsOf(r.at),
        digest: r.prompt_digest,
        source: text(r.prompt_source),
        origin: text(r.prompt_origin),
        commandName: text(r.command_name),
      });
    }
  }
  return out;
}

interface CompactionRow {
  root: string;
  chain: string;
  seq: string | number;
  at: string;
  compact_trigger: string | null;
  tokens_before: string | number | null;
  tokens_after: string | number | null;
}

/**
 * Every compaction on each root's chains. A hook records a compaction twice,
 * before and after, so only its `PostCompact` frame counts. Another source
 * records it once. This is the rule the ingest handler counts a session's
 * compactions by (`numCompactions`).
 */
const COMPACTIONS_QUERY = `SELECT toString(root_session_uuid) AS root,
  toString(session_uuid) AS chain, seq,
  formatDateTime(ts, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS at,
  compact_trigger, tokens_before, tokens_after
  FROM tacho_events FINAL
  WHERE kind = 'oxagen:compaction'
    AND (hook_event_name = 'PostCompact' OR source != 'hook')
    AND root_session_uuid IN {roots:Array(UUID)}
    AND received_at >= {from:DateTime64(3)} - ${RECEIVED_SLACK}
  ORDER BY root_session_uuid, ts, seq`;

/**
 * Each wrapped run's compactions in time order, by run public id. A run with
 * none is absent.
 */
export async function readCompactions(
  scope: Scope,
  rootByRun: ReadonlyMap<string, string>,
  from: Date,
): Promise<Map<string, RunCompaction[]>> {
  const runByRoot = new Map<string, string>();
  for (const [runId, root] of rootByRun) runByRoot.set(root, runId);
  const out = new Map<string, RunCompaction[]>();
  for (const roots of chunks([...runByRoot.keys()])) {
    const result = await runInTenantScope(scope, () =>
      chSelect<CompactionRow>({
        query: COMPACTIONS_QUERY,
        params: { roots, from: chDateTime(from) },
      }),
    );
    for (const r of result.data) {
      const runId = runByRoot.get(r.root);
      if (runId === undefined) continue;
      const list = out.get(runId) ?? [];
      list.push({
        at: new Date(r.at),
        atMicros: microsOf(r.at),
        seq: Number(r.seq),
        sessionUuid: r.chain === r.root ? null : r.chain,
        trigger: text(r.compact_trigger),
        tokensBefore: count(r.tokens_before),
        tokensAfter: count(r.tokens_after),
      });
      out.set(runId, list);
    }
  }
  for (const list of out.values())
    list.sort((a, b) => a.atMicros - b.atMicros || a.seq - b.seq);
  return out;
}

/**
 * Whether each wrapped run changed a file, by run public id. A file row
 * counts as a change when a session wrote, edited, or deleted the file, when
 * git saw it added, modified, deleted, or renamed (the rule
 * `sessionChangedFilesWhere` applies), or when its digests before and after
 * are both set and differ. Every run in `rootByRun` is in the answer: false
 * when no session of the run recorded a change.
 */
export async function readFileChanges(
  scope: Scope,
  rootByRun: ReadonlyMap<string, string>,
): Promise<Map<string, boolean>> {
  const runByRoot = new Map<string, string>();
  for (const [runId, root] of rootByRun) runByRoot.set(root, runId);
  const out = new Map<string, boolean>();
  for (const runId of rootByRun.keys()) out.set(runId, false);
  if (runByRoot.size === 0) return out;
  const changed = sql<boolean>`bool_or(
    ${files.writes} + ${files.edits} + ${files.deletes} > 0
    OR ${files.observedStatus} IN ('added', 'modified', 'deleted', 'renamed')
    OR (${files.digestBefore} IS NOT NULL
      AND ${files.digestAfter} IS NOT NULL
      AND ${files.digestBefore} <> ${files.digestAfter})
  )`;
  // tenancy: the scheduled findings job runs outside a tenant scope, and both
  // tables are filtered by the pass's orgId and workspaceId.
  await withSystemDb(async (tx) => {
    for (const roots of chunks([...runByRoot.keys()])) {
      const rows = await tx
        .select({ root: sessions.rootSessionUuid, changed })
        .from(files)
        .innerJoin(sessions, eq(sessions.id, files.sessionId))
        .where(
          and(
            eq(files.orgId, scope.orgId),
            eq(files.workspaceId, scope.workspaceId),
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
            inArray(sessions.rootSessionUuid, roots),
          ),
        )
        .groupBy(sessions.rootSessionUuid);
      for (const r of rows) {
        const runId = runByRoot.get(r.root);
        if (runId !== undefined && r.changed === true) out.set(runId, true);
      }
    }
  });
  return out;
}

/**
 * Each run's rows of `cost.run_pr_outcomes`, by run public id. A run with no
 * row is absent.
 */
export async function readOutcomes(
  scope: Scope,
  runIds: readonly string[],
): Promise<Map<string, OutcomeRow[]>> {
  const out = new Map<string, OutcomeRow[]>();
  for (const ids of chunks(runIds)) {
    for (const row of await readOutcomeRows(scope, ids)) {
      const list = out.get(row.runId) ?? [];
      list.push(row);
      out.set(row.runId, list);
    }
  }
  return out;
}
