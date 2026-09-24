// run-outputs.ts — the spine of `get_run_outputs`: the two stores' rows read
// into one node shape, and the pure builders that shape them.
//
// Everything below the queries is pure, so the read-versus-write split, the
// per-store node shapes and a run that produced nothing are pinned by unit
// tests with no database.
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, desc, eq, or } from "drizzle-orm";
import type {
  RunOutputNode,
  RunOutputState,
} from "@oxagen/oxagen/contracts/run.outputs.get";
import type { AttemptEventReadRecord } from "@oxagen/run-ledger";
import type { RunScope } from "../run.list";

// ---- Rows -----------------------------------------------------------------------------

/** One `tacho.session_files` row, as the spine reads it. */
export type SessionFileRow = {
  path: string;
  repoRelativePath: string | null;
  language: string | null;
  reads: number;
  writes: number;
  edits: number;
  deletes: number;
  linesAdded: number;
  linesRemoved: number;
  /** git's word at the last reconciliation; null means no reconciliation covered it. */
  observedStatus: string | null;
  firstSeq: number;
  lastSeq: number;
  digestBefore: string | null;
  digestAfter: string | null;
  /**
   * Whether the row is the run's own chain's. False for a subagent's chain,
   * whose frame numbers count that chain and not the run's.
   */
  ownChain: boolean;
};

/** One `agent.approval_requests` row on this run, as the spine reads it. */
export type RunApprovalRow = {
  publicId: string;
  capabilityName: string;
  createdAt: Date;
  /** Null while the call is still parked. */
  resolution: string | null;
};

export type RunOutputQueries = {
  sessionFiles: (
    scope: RunScope,
    sessionUuid: string,
    limit: number,
  ) => Promise<SessionFileRow[]>;
  runApprovals: (
    scope: RunScope,
    runPublicId: string,
    limit: number,
  ) => Promise<RunApprovalRow[]>;
};

const files = schema.tachoSessionFiles;
const sessions = schema.tachoSessions;
const approvals = schema.approvalRequests;

export const postgresRunOutputQueries: RunOutputQueries = {
  // `session_files.session_id` holds the `tacho.sessions` row id, not the
  // session uuid a run resolves to, so the chains are found through
  // `tacho.sessions`: the run's own and every subagent chain under it.
  sessionFiles: (scope, sessionUuid, limit) =>
    withTenantDb((tx) =>
      tx
        .select({
          path: files.path,
          repoRelativePath: files.repoRelativePath,
          language: files.language,
          reads: files.reads,
          writes: files.writes,
          edits: files.edits,
          deletes: files.deletes,
          linesAdded: files.linesAdded,
          linesRemoved: files.linesRemoved,
          observedStatus: files.observedStatus,
          firstSeq: files.firstSeq,
          lastSeq: files.lastSeq,
          digestBefore: files.digestBefore,
          digestAfter: files.digestAfter,
          chain: sessions.sessionUuid,
        })
        .from(files)
        .innerJoin(
          sessions,
          and(
            eq(sessions.id, files.sessionId),
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
          ),
        )
        .where(
          and(
            or(
              eq(sessions.sessionUuid, sessionUuid),
              eq(sessions.rootSessionUuid, sessionUuid),
            ),
            eq(files.orgId, scope.orgId),
            eq(files.workspaceId, scope.workspaceId),
          ),
        )
        // The producing frame is the node's place on the spine, so the read
        // is ordered by it and the cap cuts the tail rather than a slice
        // from the middle. Frame numbers count one chain, so the run's own
        // chain comes first and each subagent chain follows whole, in the
        // order it started.
        .orderBy(
          desc(eq(sessions.sessionUuid, sessionUuid)),
          asc(sessions.startedAt),
          asc(sessions.id),
          asc(files.lastSeq),
          asc(files.path),
        )
        .limit(limit),
    ).then((rows) =>
      rows.map(({ chain, ...row }) => ({
        ...row,
        ownChain: chain === sessionUuid,
      })),
    ),
  runApprovals: (scope, runPublicId, limit) =>
    withTenantDb((tx) =>
      tx
        .select({
          publicId: approvals.publicId,
          capabilityName: approvals.capabilityName,
          createdAt: approvals.createdAt,
          resolution: approvals.resolution,
        })
        .from(approvals)
        .where(
          and(
            eq(approvals.runPublicId, runPublicId),
            eq(approvals.orgId, scope.orgId),
            eq(approvals.workspaceId, scope.workspaceId),
          ),
        )
        .orderBy(asc(approvals.createdAt), asc(approvals.publicId))
        .limit(limit),
    ),
};

// ---- Wrapped sessions -----------------------------------------------------------------

/**
 * A generated asset is shown rather than named (#3608 gives it a thumbnail),
 * so it gets its own kind here even while the spine renders it like a file.
 */
const MEDIA = /\.(png|jpe?g|gif|webp|svg|avif|mp4|mov|webm|wav|mp3|m4a)$/i;

/**
 * Did the run change this path, or only look at it? The counters count tool
 * calls, so one write, edit or delete makes the row durable and everything
 * else is a read. This is the split the hairline tick depends on: a file the
 * run only read must never draw a node.
 */
export function wroteFile(row: SessionFileRow): boolean {
  return row.writes + row.edits + row.deletes > 0;
}

/**
 * The badge. git's word wins where a reconciliation recorded one, because it
 * states a condition; the counters only say which tool calls were made.
 * `observed_status` null is not "unchanged", so it falls back to the
 * counters rather than to a word git never said.
 */
export function fileState(row: SessionFileRow): RunOutputState {
  switch (row.observedStatus) {
    case "added":
      return "created";
    case "modified":
      return "written";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      break;
  }
  if (!wroteFile(row)) return "read";
  if (row.deletes > 0) return "deleted";
  return "written";
}

/** `read 3 times`, `4 writes · 1 read`, or null when the row counted nothing. */
export function fileNote(row: SessionFileRow): string | null {
  const parts: string[] = [];
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  if (row.writes > 0) parts.push(plural(row.writes, "write"));
  if (row.edits > 0) parts.push(plural(row.edits, "edit"));
  if (row.deletes > 0) parts.push(plural(row.deletes, "delete"));
  if (row.reads > 0) parts.push(plural(row.reads, "read"));
  return parts.length === 0 ? null : parts.join(" · ");
}

export function sessionFileNode(row: SessionFileRow): RunOutputNode {
  const name = row.repoRelativePath ?? row.path;
  const wrote = wroteFile(row);
  const stat =
    row.linesAdded === 0 && row.linesRemoved === 0
      ? null
      : { added: row.linesAdded, removed: row.linesRemoved };
  return {
    // The frame that produced it is the last one that touched it; a read's
    // tick points at the last look. A subagent's frame is numbered on its
    // own chain, which the run's frame reads do not open, so its node
    // carries none rather than a number that opens a different frame.
    seq: row.ownChain ? String(row.lastSeq) : null,
    kind: wrote ? (MEDIA.test(name) ? "media" : "file") : "read",
    name,
    nameIsLocator: false,
    where: row.language,
    state: fileState(row),
    note: fileNote(row),
    // A diff stat on a row the run only read would read like a change it did
    // not make, so it is kept for durable nodes alone.
    stat: wrote ? stat : null,
    observedAt: null,
    digestBefore: row.digestBefore,
    digestAfter: row.digestAfter,
  };
}

// ---- Ledger runs ----------------------------------------------------------------------

const CHANGE_STATE: Record<string, RunOutputState> = {
  create: "created",
  modify: "written",
  delete: "deleted",
  rename: "renamed",
};

function str(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(payload: unknown, key: string): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One node from a ledger receipt, or null for an event that is not an output.
 *
 * A `change.recorded` node names its `rpl_` path locator and says so
 * (`nameIsLocator`): the exact path is never part of the event and nothing
 * resolves the locator back to one, so the alternative is a node with no
 * name at all. A receipt whose locator is missing is skipped rather than
 * given a made-up name.
 */
export function ledgerNode(
  event: Pick<
    AttemptEventReadRecord,
    "eventType" | "payload" | "runSeq" | "observedAt"
  >,
): RunOutputNode | null {
  const at = event.observedAt.toISOString();
  const base = { seq: event.runSeq, observedAt: at } as const;
  switch (event.eventType) {
    case "change.recorded": {
      const locator = str(event.payload, "path_locator_public_id");
      if (locator === null) return null;
      const kind = str(event.payload, "change_kind");
      return {
        ...base,
        kind: "change",
        name: locator,
        nameIsLocator: true,
        where: null,
        state: (kind === null ? null : CHANGE_STATE[kind]) ?? "written",
        note: str(event.payload, "classification_authority"),
        stat: null,
        digestBefore: str(event.payload, "before_digest"),
        digestAfter: str(event.payload, "after_digest"),
      };
    }
    case "provider_publish.commit_created": {
      const sha = str(event.payload, "commit_sha");
      if (sha === null) return null;
      const changed = num(event.payload, "changed_file_count");
      return {
        ...base,
        kind: "commit",
        name: sha,
        nameIsLocator: false,
        where: str(event.payload, "provider_repository_id"),
        state: "pushed",
        note:
          changed === null
            ? null
            : `${changed} file${changed === 1 ? "" : "s"} changed`,
        stat: null,
        digestBefore: null,
        digestAfter: str(event.payload, "tree_sha"),
      };
    }
    case "provider_publish.pull_request_opened": {
      const number = num(event.payload, "pull_request_number");
      if (number === null) return null;
      return {
        ...base,
        kind: "pr",
        name: `#${number}`,
        nameIsLocator: false,
        where: str(event.payload, "provider_repository_id"),
        state: "open",
        // Branch names are annotations and never checkout identity, so the
        // head sha is what the node carries.
        note: null,
        stat: null,
        digestBefore: null,
        digestAfter: str(event.payload, "head_commit_sha"),
      };
    }
    default:
      return null;
  }
}

// ---- Gates ----------------------------------------------------------------------------

/**
 * A gate and the thing it withheld.
 *
 * `seq` is null on both: `approval_requests` records no frame sequence, and
 * inventing one would put a made-up position on the spine. They sit at the
 * end of the spine instead, which is where a gate stopped the run — nothing
 * after it happened.
 *
 * A resolved-and-approved gate produces nothing: the call went through, and
 * whatever it produced already has its own node from the frames.
 */
export function gateNodes(row: RunApprovalRow): RunOutputNode[] {
  if (row.resolution === "approved") return [];
  const refused = row.resolution !== null;
  const at = row.createdAt.toISOString();
  return [
    {
      seq: null,
      kind: "gate",
      name: row.capabilityName,
      nameIsLocator: false,
      where: "oxagen",
      state: refused ? "blocked" : "awaiting",
      note: refused
        ? `the call was ${row.resolution}`
        : "the run is stopped here until someone answers",
      stat: null,
      observedAt: at,
      digestBefore: null,
      digestAfter: null,
    },
    {
      seq: null,
      kind: "would",
      name: row.capabilityName,
      nameIsLocator: false,
      where: null,
      state: "withheld",
      note: refused ? "it did not run" : "it has not run",
      stat: null,
      observedAt: at,
      digestBefore: null,
      digestAfter: null,
    },
  ];
}

// ---- Tally ----------------------------------------------------------------------------

const DURABLE = new Set(["file", "media", "change", "commit", "pr"]);

/** `3 artifacts · 2 reads · 1 gate`: a read is never an artifact, and nor is a gate. */
export function tally(nodes: readonly RunOutputNode[]): {
  artifacts: number;
  reads: number;
  gates: number;
} {
  let artifacts = 0;
  let reads = 0;
  let gates = 0;
  for (const node of nodes) {
    if (DURABLE.has(node.kind)) artifacts += 1;
    else if (node.kind === "read") reads += 1;
    else if (node.kind === "gate") gates += 1;
  }
  return { artifacts, reads, gates };
}
