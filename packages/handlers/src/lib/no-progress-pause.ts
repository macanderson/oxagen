// The pause behind an enforced no-progress limit (spend spec, detector 1;
// #4490), as `cost.run-progress` runs it through its runner seam
// (`@oxagen/inngest-functions/no-progress-pause-runner`).
//
// It takes the path an operator's pause takes. One `pause` row on
// `tacho.control_commands`, addressed to the run, is queued for the run's
// host through `writeRecipientCommand`, the write `dispatch_command` and
// `pause_workspace_runs` make. The host takes it on its next poll, and its
// hook refuses the agent's next governed call while the pause holds: the
// next checkpoint. The Run page reads the row as it reads any pause, from
// `pausing` to `paused`, with the limit as the reason. No person issued it,
// so the row names no issuer.
//
// A run that cannot take a command gets no row. The block goes back to the
// check, which records it on the hit for the Run page to name:
//
//   - A wrapped run whose host cannot take it answers `commandBlockOf`'s
//     reason, the rule every run control reads.
//   - A ledger run answers `no_connection_point`. Its pause fences evidence
//     and refuses none of its agent's calls, so it would pause nothing.
//
// The pause is idempotent by loop. The command carries the loop's key, and a
// request for a loop that already has a pause queues nothing. A check whose
// write failed after the pause retries with the same loop, so the retry
// cannot pause a run the operator has resumed since (#4503).
import { withTenantDb, schema, type Tx } from "@oxagen/database";
import type {
  NoProgressPauseOutcome,
  NoProgressPauseRequest,
} from "@oxagen/billing";
import { commandBlockOf } from "@oxagen/oxagen/contracts/run.list";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../logger";
import type { RunScope } from "../run.list";
import {
  type CommandStore,
  postgresCommandStore,
  type RecipientSession,
} from "../tacho.command.dispatch";
import { PAUSE_EXPIRES_MS } from "../tacho.workspace_runs.pause";
import { writeRecipientCommand } from "./run-command-recipients";

/** The payload key that names the loop a no-progress pause was queued for. */
export const NO_PROGRESS_LOOP_PAYLOAD_KEY = "no_progress_loop";

/** The longest tool name the pause reason quotes; the reason stays under 512. */
const REASON_TOOL_MAX = 200;

/** The reads and writes one pause makes, inside one tenant transaction. */
export interface NoProgressPauseStore {
  /** The run's root wrapped session in the scope, or null. */
  session(scope: RunScope, publicId: string): Promise<RecipientSession | null>;
  /**
   * The `tcm_…` id of a pause the limit already queued on the run for one of
   * `keys`, whatever became of it since; null when there is none.
   */
  pauseFor(
    scope: RunScope,
    runPublicId: string,
    keys: readonly string[],
  ): Promise<string | null>;
  /** The command writes `writeRecipientCommand` makes. */
  commands: CommandStore;
}

export interface NoProgressPauseDeps {
  /** Run `fn` against a store inside one tenant transaction in `scope`. */
  withStore<T>(
    scope: RunScope,
    fn: (store: NoProgressPauseStore) => Promise<T>,
  ): Promise<T>;
  now: () => Date;
}

/**
 * What the agent and the Run page read as the pause's reason: the call that
 * looped, how often, and the limit it met.
 */
export function noProgressPauseReason(
  loop: { tool: string; repeats: number },
  limit: number,
): string {
  const tool =
    loop.tool.length > REASON_TOOL_MAX
      ? `${loop.tool.slice(0, REASON_TOOL_MAX - 1)}…`
      : loop.tool;
  return `No-progress limit of ${limit}: ${tool} ran ${loop.repeats} times in a row with an unchanged result.`;
}

/** Pause the run for the loops the no-progress check found first. */
export async function pauseForNoProgress(
  request: NoProgressPauseRequest,
  deps: NoProgressPauseDeps,
): Promise<NoProgressPauseOutcome> {
  const scope: RunScope = {
    orgId: request.orgId,
    workspaceId: request.workspaceId,
  };
  const first = request.loops[0];
  // A ledger run's pause holds no call, and a request names at least one
  // loop; neither reaches the store.
  if (request.runId.startsWith("arun_") || first === undefined)
    return { paused: false, block: "no_connection_point" };
  const now = deps.now();
  const outcome = await deps.withStore(
    scope,
    async (store): Promise<NoProgressPauseOutcome> => {
      const keys = request.loops.map((l) => l.key);
      const earlier = await store.pauseFor(scope, request.runId, keys);
      if (earlier !== null) return { paused: true, commandId: earlier };
      const session = await store.session(scope, request.runId);
      if (session === null)
        return { paused: false, block: "no_connection_point" };
      const block = commandBlockOf({
        outcome: session.outcome,
        sealSource: session.sealSource,
        host: session.host,
        now,
      });
      if (block !== null) return { paused: false, block };
      const { publicId } = await writeRecipientCommand(
        store.commands,
        {
          scope,
          session,
          command: "pause",
          payload: {
            address: session.publicId,
            session_uuid: session.sessionUuid,
            [NO_PROGRESS_LOOP_PAYLOAD_KEY]: first.key,
          },
          requestedMode: null,
          deliveryMode: null,
          degradedReason: null,
          reason: noProgressPauseReason(first, request.limit.repeats),
          issuedByUserId: null,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + PAUSE_EXPIRES_MS),
        },
        null,
      );
      return { paused: true, commandId: publicId };
    },
  );
  logger.info(
    {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      runId: request.runId,
      loops: request.loops.length,
      ...outcome,
    },
    "no-progress pause: settled",
  );
  return outcome;
}

// ---- Postgres ------------------------------------------------------------------------

const commands = schema.tachoControlCommands;

/** The payload field as a SQL literal, as every other payload read writes it. */
const loopKeyField = sql.raw(`'${NO_PROGRESS_LOOP_PAYLOAD_KEY}'`);

export function postgresNoProgressPauseStore(tx: Tx): NoProgressPauseStore {
  const store = postgresCommandStore(tx);
  return {
    session: (scope, publicId) => store.session(scope, publicId),
    pauseFor: async (scope, runPublicId, keys) => {
      if (keys.length === 0) return null;
      const rows = await tx
        .select({ publicId: commands.publicId })
        .from(commands)
        .where(
          and(
            eq(commands.orgId, scope.orgId),
            eq(commands.workspaceId, scope.workspaceId),
            eq(commands.targetKind, "run"),
            eq(commands.targetId, runPublicId),
            eq(commands.command, "pause"),
            inArray(sql<string>`${commands.payload}->>${loopKeyField}`, [
              ...keys,
            ]),
          ),
        )
        .orderBy(asc(commands.issuedAt))
        .limit(1);
      return rows[0]?.publicId ?? null;
    },
    commands: store,
  };
}

export const POSTGRES_NO_PROGRESS_PAUSE_DEPS: NoProgressPauseDeps = {
  withStore: (scope, fn) =>
    runInTenantScope(scope, () =>
      withTenantDb((tx) => fn(postgresNoProgressPauseStore(tx))),
    ),
  now: () => new Date(),
};
