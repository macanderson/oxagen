// tacho-idle-close.ts — the control plane's close of a wrapped session that
// stopped reporting (#3980).
//
// A session seals when its host sends an `agent_stop`: the harness's
// SessionEnd hook, or the host daemon's sweep once the harness process is
// gone (or, with no process to watch, after six idle hours). Two cases never
// get there. A Claude Code terminal left open keeps its process alive, so the
// daemon waits on it for ever; and a host whose daemon stopped, or whose
// machine is gone, sends nothing at all. Both read as running for days.
//
// This closes a session once nothing in its run, root or subagent, has
// reported for `TACHO_IDLE_CLOSE_AFTER_MS`. The close is recorded as the
// control plane's (`seal_source = 'idle_timeout'`), with the outcome
// `unknown` (a run that may have finished is not a run that finished), the
// end at the last event the control plane received, and an unobserved tail,
// which grades the recording `inspect`. It is an inference from silence, so it
// stays open to correction: tacho ingest reopens the session on its next
// frame and replaces the close with the host's own seal when an `agent_stop`
// arrives.
import {
  readLatestRetentionPolicy,
  schema,
  withSystemDb,
  withTenantDb,
} from "@oxagen/database";
import {
  TACHO_IDLE_CLOSE_AFTER_MS,
  type TachoSealSource,
} from "@oxagen/database/schema";
import { sealTachoSession } from "@oxagen/tacho";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";

const sessions = schema.tachoSessions;

/** An open session the scan found idle, with what its seal is graded from. */
export interface IdleSession {
  id: string;
  publicId: string;
  orgId: string;
  workspaceId: string;
  parentSessionUuid: string | null;
  seqCount: number;
  /** The chain head the control plane last recorded; the close commits to it. */
  lastHash: string | null;
  lastEventAt: Date;
  chainVerified: boolean;
  telemetryGapCount: number;
  contentFrames: number;
  bodyFrames: number;
  numToolCalls: number;
  toolBodyFrames: number;
  enforcementTier: string;
}

/** A session the close sealed; a root is a run whose cost is rolled up. */
export interface ClosedSession {
  publicId: string;
  orgId: string;
  workspaceId: string;
  isRoot: boolean;
}

/** The instant before which a run's last event makes it idle. */
export function idleCutoff(now: Date): Date {
  return new Date(now.getTime() - TACHO_IDLE_CLOSE_AFTER_MS);
}

/**
 * The columns the close writes. The gaps and grade are the ones any seal of
 * this session would record from the same counters, plus the unobserved tail
 * a missing `agent_stop` is (`sealTachoSession`). The end is the last event
 * the control plane received, not the moment it noticed the silence; the
 * seal's own time is that moment. Tacho ingest's reopen undoes exactly these
 * columns, so a change here is a change there.
 */
export function idleCloseColumns(
  session: IdleSession,
  retentionMode: string,
  now: Date,
) {
  const seal = sealTachoSession({
    hostGaps: [],
    chainVerified: session.chainVerified,
    unobservedTail: true,
    telemetryGapCount: session.telemetryGapCount,
    retentionMode,
    contentFrames: session.contentFrames,
    bodyFrames: session.bodyFrames,
    toolCalls: session.numToolCalls,
    toolBodyFrames: session.toolBodyFrames,
    enforcementTier: session.enforcementTier,
  });
  return {
    sealedAt: now,
    sealSource: "idle_timeout" satisfies TachoSealSource,
    outcome: "unknown",
    endedAt: session.lastEventAt,
    // The chain as recorded ends here. The host never committed to an end,
    // so this is the head the control plane holds, not a host's final hash.
    finalHash: session.lastHash,
    unobservedTail: true,
    completenessGaps: seal.completenessGaps,
    replayGrade: seal.replayGrade,
    updatedAt: now,
  };
}

/**
 * No chain of this row's run, sealed or not, has reported since `cutoff`. The
 * scan asks it to find candidates, and the close asks it again as it writes,
 * so a subagent that reported between the two keeps its root open.
 */
function runSilentSince(cutoff: Date) {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${sessions} AS run_chain
    WHERE run_chain.org_id = ${sessions.orgId}
      AND run_chain.root_session_uuid = ${sessions.rootSessionUuid}
      AND run_chain.last_event_at >= ${cutoff.toISOString()}::timestamptz
  )`;
}

/**
 * Open sessions whose run has been silent since `cutoff`: the session itself
 * and every other chain of its run, sealed or not, last reported before it.
 * A subagent still working keeps its root open, and a root still working
 * keeps an orphaned subagent open until the whole run goes quiet. Oldest
 * first, at most `limit`.
 */
export async function listIdleSessions(args: {
  cutoff: Date;
  limit: number;
}): Promise<IdleSession[]> {
  // tenancy: the scheduled close runs outside a tenant scope and scans every
  // organization's open sessions; each row carries its own orgId and
  // workspaceId, and the close writes it in that tenant's scope.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        id: sessions.id,
        publicId: sessions.publicId,
        orgId: sessions.orgId,
        workspaceId: sessions.workspaceId,
        parentSessionUuid: sessions.parentSessionUuid,
        seqCount: sessions.seqCount,
        lastHash: sessions.lastHash,
        lastEventAt: sessions.lastEventAt,
        chainVerified: sessions.chainVerified,
        telemetryGapCount: sessions.telemetryGapCount,
        contentFrames: sessions.contentFrames,
        bodyFrames: sessions.bodyFrames,
        numToolCalls: sessions.numToolCalls,
        toolBodyFrames: sessions.toolBodyFrames,
        enforcementTier: sessions.enforcementTier,
      })
      .from(sessions)
      .where(
        and(
          isNull(sessions.sealedAt),
          lt(sessions.lastEventAt, args.cutoff),
          runSilentSince(args.cutoff),
        ),
      )
      .orderBy(asc(sessions.lastEventAt))
      .limit(args.limit),
  );
  return rows.map((row) => ({
    ...row,
    lastEventAt: new Date(row.lastEventAt),
  }));
}

/**
 * Close one idle session, in its tenant's scope. Null when the session moved
 * since the scan: a batch landed on it (its head or last event advanced), a
 * batch landed on another chain of its run, or its host sealed it. On this
 * row the close and a batch cannot both win: this statement is conditional
 * on the head and the silence it read, and ingest's own write is conditional
 * on the seal it read, so whichever commits second finds the row changed and
 * gives way. A subagent batch that commits while this statement runs can
 * still miss it; ingest then reopens the root when that subagent reports.
 */
export async function closeIdleSession(
  session: IdleSession,
  cutoff: Date,
  now: Date,
): Promise<ClosedSession | null> {
  return runInTenantScope(
    { orgId: session.orgId, workspaceId: session.workspaceId },
    () =>
      withTenantDb(async (tx) => {
        // The retention mode is the one fact the grade needs from outside
        // the row, read the way ingest reads it at an `agent_stop`.
        const policy = await readLatestRetentionPolicy(
          tx,
          session.orgId,
          session.workspaceId,
        );
        const mode = policy?.mode ?? "content_exact";
        const written = await tx
          .update(sessions)
          .set(idleCloseColumns(session, mode, now))
          .where(
            and(
              eq(sessions.id, session.id),
              eq(sessions.orgId, session.orgId),
              eq(sessions.workspaceId, session.workspaceId),
              isNull(sessions.sealedAt),
              eq(sessions.seqCount, session.seqCount),
              // Covers this row's own last event too: every chain, this one
              // included, belongs to its run.
              runSilentSince(cutoff),
            ),
          )
          .returning({ publicId: sessions.publicId });
        if (written.length === 0) return null;
        return {
          publicId: session.publicId,
          orgId: session.orgId,
          workspaceId: session.workspaceId,
          isRoot: session.parentSessionUuid === null,
        };
      }),
  );
}
