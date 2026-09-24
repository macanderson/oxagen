// Whether a wrapped run is paused, read from the commands its host applied
// (#4112).
//
// A ledger run records its pause on the run itself (`agent_runs.ingress_paused`),
// because `dispatch_command` applies a ledger pause in the same transaction
// that writes its receipt. A wrapped (`tse_…`) run has no such column. Its
// pause is applied by the host: the collector sets the session's pause flag
// and acknowledges the command `applied` in `tacho.control_commands`. So the
// run is paused when the latest pause or resume its host applied is a pause,
// and a queued, failed or expired command changes nothing. That is the same
// fact the pause dialog points at when it says the run's status will say
// when the pause has taken effect.
//
// The read covers a whole page in one statement, through
// `tacho_control_commands_target_idx` (org, workspace, target kind, target
// id), so a list of a hundred runs costs one read and not a hundred.
import { schema, withTenantDb } from "@oxagen/database";
import type { RunItem } from "@oxagen/oxagen/contracts/run.list";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { QueryDb, RunScope } from "../run.list";

const commands = schema.tachoControlCommands;

/** The two commands that change whether a run is paused. */
export const HALT_COMMANDS = ["pause", "resume"] as const;
export type RunHalt = (typeof HALT_COMMANDS)[number];

/**
 * The latest pause or resume the host applied to each run, by the run's
 * public id. A run with none applied is absent.
 */
export type ReadRunHalts = (
  scope: RunScope,
  runPublicIds: readonly string[],
) => Promise<Map<string, RunHalt>>;

/**
 * One row per run: its latest applied pause or resume. Latest is by the time
 * the host applied it, then by when it was issued, so two commands applied in
 * the same poll resolve to the one issued last.
 */
export function runHaltsQuery(
  db: QueryDb,
  scope: RunScope,
  runPublicIds: readonly string[],
) {
  return db
    .selectDistinctOn([commands.targetId], {
      targetId: commands.targetId,
      command: commands.command,
    })
    .from(commands)
    .where(
      and(
        eq(commands.orgId, scope.orgId),
        eq(commands.workspaceId, scope.workspaceId),
        eq(commands.targetKind, "run"),
        inArray(commands.targetId, [...runPublicIds]),
        inArray(commands.command, [...HALT_COMMANDS]),
        eq(commands.outcome, "applied"),
      ),
    )
    .orderBy(
      commands.targetId,
      sql`${commands.appliedAt} desc nulls last`,
      sql`${commands.issuedAt} desc`,
    );
}

function isHalt(word: string): word is RunHalt {
  return (HALT_COMMANDS as readonly string[]).includes(word);
}

export const postgresReadRunHalts: ReadRunHalts = async (
  scope,
  runPublicIds,
) => {
  const out = new Map<string, RunHalt>();
  if (runPublicIds.length === 0) return out;
  const rows = await withTenantDb((tx) =>
    runHaltsQuery(tx, scope, runPublicIds),
  );
  for (const row of rows) {
    if (isHalt(row.command)) out.set(row.targetId, row.command);
  }
  return out;
};

/**
 * A wrapped run's `ingressPaused`: true while the run is live and the latest
 * pause or resume its host applied is a pause. A sealed or halted run reads
 * false, since nothing is left to resume.
 */
export function tachoPaused(
  status: RunItem["status"],
  halt: RunHalt | undefined,
): boolean {
  return status === "live" && halt === "pause";
}
