// A steer or message queued for an agent's next run (#2953, ADR-056).
//
// `dispatch_command` writes a prompt command for an agent with no run in
// flight as one row addressed to the agent: `target_kind` `agent`,
// `target_id` the agent key, no host and no session. No host drains such a
// row, because a command with no session is a host-level command and the host
// would fan it out to whatever runs it held at that moment.
//
// When the agent's next root session opens, ingest calls
// `readdressNextRunCommands` in the transaction that writes the session. Each
// queued row for the agent becomes a row for that run: `target_kind` `run`,
// `target_id` the run's `tse_…` id, the host and session that carry it, and
// `payload.session_uuid`. The mode is resolved against the run as dispatch
// resolves it for a run in flight (`resolveDeliveryMode`). The control
// envelope on the same ingest response then drains the row like any command
// addressed to a run, and the host holds the text for the first boundary its
// harness can carry. That is the run's first prompt when the envelope lands
// before it, and otherwise the next tool call or the end of the turn.
//
// A Stella run reads steering text only when its session starts, which has
// passed by the time the session reaches ingest, so the row is re-addressed
// as `failed` with `no_prompt_carrier`, the reason a broadcast records. A row
// past its expiry is marked `expired` here, since `expireCommands` sweeps a
// host's rows and this row names no host. The UPDATE re-reads its WHERE under
// the row lock, so when two runs of the agent open at once only one takes
// each command.
import { schema, type Tx } from "@oxagen/database";
import { steerBlockOf } from "@oxagen/oxagen/contracts/run.list";
import type { TachoDeliveryMode } from "@oxagen/tacho";
import { and, eq, gt, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { resolveDeliveryMode } from "../tacho.command.dispatch";
import type { RunScope } from "../run.list";

const commands = schema.tachoControlCommands;

/** Every mode a steer can ask for, each resolved against the run once. */
const REQUESTABLE_MODES: readonly TachoDeliveryMode[] = [
  "next_step",
  "interrupt",
  "turn_boundary",
];

/**
 * The daemon's own chain opens a root session too (`tachod-<ulid>`). It is
 * host bookkeeping, not an agent's run, and the host refuses a command
 * addressed to it (`isInternalSession` in `@oxagen/tacho/collector`).
 */
const DAEMON_CHAIN_PREFIX = "tachod-";

/** The run a queued command goes to: a root session ingest just opened. */
export type NextRun = {
  /** `tacho.sessions.id`. */
  id: string;
  /** The run's `tse_…` id. */
  publicId: string;
  sessionUuid: string;
  /** The harness's own session id, which names the daemon's chain. */
  harnessSessionId: string;
  hostId: string;
  /** `tacho.sessions.runtime`, which decides the steer carrier. */
  runtime: string;
  /** The tier the session opened on. */
  enforcementTier: string;
};

/**
 * A `CASE requested_mode` that maps each requestable mode to what `pick`
 * answers for it on this run, and anything else to NULL.
 */
function byRequestedMode(
  pick: (mode: TachoDeliveryMode) => string | null,
): SQL {
  return sql`CASE ${commands.requestedMode} ${sql.join(
    REQUESTABLE_MODES.map(
      (mode) => sql`WHEN ${mode}::text THEN ${pick(mode)}::text`,
    ),
    sql` `,
  )} ELSE NULL END`;
}

/**
 * Re-address the agent's queued next-run commands to the run that just
 * opened. Returns how many rows the run took. Called only for a root session
 * this batch inserted, so a batch on a session already open never takes one.
 */
export async function readdressNextRunCommands(
  tx: Tx,
  args: {
    scope: RunScope;
    /** The host's agent key, the address the rows carry. */
    agentKey: string | null;
    run: NextRun;
    /** What the run's host advertised on its last health report. */
    hostFeatures: readonly string[];
    now: Date;
  },
): Promise<number> {
  const { scope, agentKey, run, hostFeatures, now } = args;
  if (
    agentKey === null ||
    run.harnessSessionId.startsWith(DAEMON_CHAIN_PREFIX)
  )
    return 0;
  const addressedToAgent = and(
    eq(commands.orgId, scope.orgId),
    eq(commands.workspaceId, scope.workspaceId),
    eq(commands.targetKind, "agent"),
    eq(commands.targetId, agentKey),
    eq(commands.outcome, "queued"),
  );
  await tx
    .update(commands)
    .set({ outcome: "expired", updatedAt: now })
    .where(and(addressedToAgent, lte(commands.expiresAt, now)));
  const block = steerBlockOf(run.runtime);
  const readdressed = await tx
    .update(commands)
    .set({
      targetKind: "run",
      targetId: run.publicId,
      hostId: run.hostId,
      sessionId: run.id,
      payload: sql`${commands.payload} || ${JSON.stringify({
        session_uuid: run.sessionUuid,
      })}::jsonb`,
      ...(block === null
        ? {
            deliveryMode: byRequestedMode(
              (mode) =>
                resolveDeliveryMode(
                  mode,
                  run.enforcementTier,
                  hostFeatures,
                  run.runtime,
                ).deliveryMode,
            ),
            degradedReason: byRequestedMode(
              (mode) =>
                resolveDeliveryMode(
                  mode,
                  run.enforcementTier,
                  hostFeatures,
                  run.runtime,
                ).degradedReason,
            ),
          }
        : { outcome: "failed", outcomeDetail: block }),
      updatedAt: now,
    })
    .where(
      and(
        addressedToAgent,
        or(isNull(commands.expiresAt), gt(commands.expiresAt, now)),
      ),
    )
    .returning({ id: commands.id });
  return readdressed.length;
}
