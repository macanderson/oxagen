// tacho.session_heads.list.ts: which of a batch of sessions the control
// plane already holds for the calling host (ADR-161, #4028).
//
// `oxagen agent backfill` asks before it seals anything. A session it would
// start at seq 0 that the control plane already holds would arrive as a
// chain break, and a session an earlier enrollment of the same agent recorded
// under another chain uuid would arrive as a second copy of the run. The
// answer names both, and the pass skips them.
//
// The handler checks the host key the way every Tacho control call does,
// then asks that the key's creator still holds a role the contract grants.
// It reads root sessions only: a backfill names the sessions it found on
// disk, and a subagent's chain goes with its parent's.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  tachoSessionHeadsList,
  type TachoSessionHeadsListOutput,
} from "@oxagen/oxagen/contracts/tacho.session_heads.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { assertContractRole } from "./lib/capability-role-guard";
import { resolveEnrolledHost } from "./lib/tacho-host";

const CAPABILITY = "list_tacho_session_heads";

type Head = TachoSessionHeadsListOutput["sessions"][number];

const RECORD_BASES: ReadonlySet<string> = new Set(["live", "backfill", "mixed"]);

export const tachoSessionHeadsListHandler: CapabilityHandler<
  typeof tachoSessionHeadsList
> = async (input, ctx): Promise<TachoSessionHeadsListOutput> => {
  const host = await withTenantDb((tx) =>
    resolveEnrolledHost(CAPABILITY, ctx, tx as never, input.host_enrollment_id),
  );
  await assertContractRole(tachoSessionHeadsList, ctx);
  const uuids = [...new Set(input.session_uuids)];
  const ids = [...new Set(input.harness_session_ids ?? [])];
  const rows = (await withTenantDb((tx) =>
    tx
      .select({
        sessionUuid: schema.tachoSessions.sessionUuid,
        harnessSessionId: schema.tachoSessions.harnessSessionId,
        seqCount: schema.tachoSessions.seqCount,
        recordBasis: schema.tachoSessions.recordBasis,
        backfillNormalizer: schema.tachoSessions.backfillNormalizer,
      })
      .from(schema.tachoSessions)
      .where(
        and(
          eq(schema.tachoSessions.orgId, ctx.orgId),
          eq(schema.tachoSessions.workspaceId, ctx.workspaceId),
          isNull(schema.tachoSessions.parentSessionUuid),
          or(
            // This host's own chains, by the uuid it derives.
            and(
              eq(schema.tachoSessions.hostId, host.id),
              inArray(schema.tachoSessions.sessionUuid, uuids),
            ),
            // The same agent's sessions under any chain uuid, so an earlier
            // enrollment's record of the session is found too.
            ...(ids.length > 0
              ? [
                  and(
                    eq(schema.tachoSessions.agentKey, host.agentKey),
                    inArray(schema.tachoSessions.harnessSessionId, ids),
                  ),
                ]
              : []),
          ),
        ),
      ),
  )) as Array<{
    sessionUuid: string;
    harnessSessionId: string;
    seqCount: number;
    recordBasis: string;
    backfillNormalizer: string | null;
  }>;
  const sessions: Head[] = rows.map((row) => ({
    session_uuid: row.sessionUuid,
    harness_session_id: row.harnessSessionId,
    seq_count: Math.max(0, Number(row.seqCount)),
    // A value the check constraint would refuse reads as live, the basis
    // that makes a backfill leave the session alone.
    record_basis: RECORD_BASES.has(row.recordBasis)
      ? (row.recordBasis as Head["record_basis"])
      : "live",
    backfill_normalizer: row.backfillNormalizer ?? null,
  }));
  return { sessions };
};
