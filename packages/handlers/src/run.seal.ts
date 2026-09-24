// `seal_run`: an operator seals a wrapped run the control plane still reads
// as live, and queues a kill for its agent (#4073, ADR-168).
//
// A wrapped session seals when its host sends `agent_stop`, or when the idle
// close (`tacho.session-idle-close`) seals it after twelve silent hours. A run
// whose agent finished without an `agent_stop` reads as live until then. This
// handler seals it now, in one tenant transaction:
//
// 1. It locks the root session row (`FOR UPDATE`), so the seal and an ingest
//    batch for the same run serialize. Ingest's session UPDATE is conditional
//    on the seal it read, so a batch that read the row before this commit is
//    refused and re-sent, and its next read sees this seal.
// 2. It refuses a run that is already sealed for good: the host's
//    `agent_stop`, an earlier operator seal, or a seal older than the
//    `seal_source` column. An idle close is sealable, because that close is
//    not final.
// 3. It seals the root and every chain of its run that is open or idle-closed,
//    with the columns the idle close writes (`controlPlaneSealColumns`) and
//    `seal_source = 'operator'`. Each UPDATE is conditional on the chain still
//    being open or idle-closed, so a host seal that committed first wins.
// 4. It queues one `kill` command for the agent when the root's host can
//    collect a command (`commandBlockOf`, read on the root as it was before
//    the seal). A host that cannot collect one does not stop the seal; the
//    answer says the kill was not sent and why.
//
// After the commit it sends `cost/run.sealed` for the root, best-effort, as
// tacho ingest does when a host seals a run.
//
// A ledger run (`arun_…`) is refused: its producer seals it, and
// `dispatch_command` cancel stops its ingress.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { runSeal, type SealRunOutput } from "@oxagen/oxagen/contracts/run.seal";
import { commandBlockOf } from "@oxagen/oxagen/contracts/run.list";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  readLatestRetentionPolicy,
  schema,
  withTenantDb,
  type Tx,
} from "@oxagen/database";
import {
  controlPlaneSealColumns,
  type SealableSession,
} from "@oxagen/inngest-functions/tacho-idle-close";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { eventClient } from "./event-client";
import { logger } from "./logger";
import { type RunScope, runScope } from "./run.list";
import {
  addressOf,
  type CommandStore,
  postgresCommandStore,
  type RecipientSession,
} from "./tacho.command.dispatch";

/** How long the kill waits for its host to collect it: `dispatch_command`'s default. */
export const KILL_EXPIRES_IN_MS = 3_600_000;

/** The run's root session, locked, with its host and its seal. */
export type SealRoot = RecipientSession & {
  sealedAt: Date | null;
  sealSource: string | null;
};

/** A chain of the run the seal may write: open, or closed for silence. */
export type SealableChain = SealableSession & {
  id: string;
  publicId: string;
};

/** The columns an operator's seal writes on one chain. */
export type OperatorSealColumns = ReturnType<typeof operatorSealColumns>;

/** The reads and writes one seal makes, all inside one tenant transaction. */
export interface SealStore
  extends Pick<CommandStore, "ledgerRunExists" | "insert" | "supersede"> {
  /** The root session by its `tse_…` id in the scope, locked for this transaction. */
  lockRoot(scope: RunScope, publicId: string): Promise<SealRoot | null>;
  /** The run's chains that are open or idle-closed, root included, locked. */
  lockSealableChains(scope: RunScope, root: SealRoot): Promise<SealableChain[]>;
  /** The workspace's retention mode, which grades the seal. */
  retentionMode(scope: RunScope): Promise<string>;
  /** Seal one chain if it is still open or idle-closed; whether it wrote. */
  seal(
    scope: RunScope,
    chainId: string,
    columns: OperatorSealColumns,
  ): Promise<boolean>;
}

/** The event the cost rollup rebuilds a sealed run's totals on. */
export type RunSealedEvent = {
  name: "cost/run.sealed";
  data: { runId: string; orgId: string; workspaceId: string };
};

export type SealRunDeps = {
  /** Run `fn` against a store inside one tenant transaction. */
  withStore<T>(fn: (store: SealStore) => Promise<T>): Promise<T>;
  now: () => Date;
  /** Sends `cost/run.sealed` once the seal has committed. */
  sendEvent: (event: RunSealedEvent) => Promise<void>;
};

const notFound = (reason: string) =>
  new HandlerError({ code: "not_found", reason });
const refused = (reason: string, message: string) =>
  new HandlerError({ code: "conflict", reason, message });

const alreadySealed = () => refused("run_sealed", "The run has already sealed");

/** The idle close's columns, recorded as the operator's seal. */
function operatorSealColumns(
  chain: SealableSession,
  retentionMode: string,
  now: Date,
) {
  return controlPlaneSealColumns(chain, retentionMode, now, "operator");
}

/**
 * Whether a root's seal is final: the host's `agent_stop`, an operator's seal,
 * or a seal written before `seal_source` existed. Only the idle close is not.
 */
function sealedForGood(root: SealRoot): boolean {
  return root.sealedAt !== null && root.sealSource !== "idle_timeout";
}

export function createSealRunHandler(
  deps: SealRunDeps,
): CapabilityHandler<typeof runSeal> {
  return async (input, ctx): Promise<SealRunOutput> => {
    // Org Owners and Admins seal any run; a workspace Owner seals the runs of
    // the workspace the call is scoped to. A seal is final and kills another
    // person's agent, so a workspace Member, who may pause or steer a run,
    // may not seal one. The acting user is the signed-in user or the creator
    // of the API key, and is recorded as the kill's issuer.
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    const scope = runScope(ctx);
    const now = deps.now();

    const result = await deps.withStore(async (store) => {
      if (input.runId.startsWith("arun_")) {
        if (!(await store.ledgerRunExists(scope, input.runId)))
          throw notFound("run_not_found");
        throw refused(
          "ledger_run",
          "A ledger run seals when its producer seals it. Use dispatch_command cancel to stop its ingress",
        );
      }
      const root = await store.lockRoot(scope, input.runId);
      if (!root) throw notFound("run_not_found");
      if (sealedForGood(root)) throw alreadySealed();

      // Whether a host can collect the kill, read on the session as it was
      // before this seal: the same rule every run row and `dispatch_command`
      // read, which treats an idle close as commandable.
      const block = commandBlockOf({
        outcome: root.outcome,
        sealSource: root.sealSource,
        host: root.host,
        now,
      });

      const mode = await store.retentionMode(scope);
      const chains = await store.lockSealableChains(scope, root);
      let sessionsSealed = 0;
      let rootSealed = false;
      for (const chain of chains) {
        const wrote = await store.seal(
          scope,
          chain.id,
          operatorSealColumns(chain, mode, now),
        );
        if (!wrote) continue;
        sessionsSealed += 1;
        if (chain.id === root.id) rootSealed = true;
      }
      // A host seal that committed first leaves the root nothing to write.
      if (!rootSealed) throw alreadySealed();

      if (block !== null)
        return {
          sessionsSealed,
          kill: { status: "not_sent" as const, reason: block },
        };
      const { publicId: commandId } = await store.insert({
        scope,
        session: root,
        command: "kill",
        payload: {
          address: addressOf({ kind: "run", id: input.runId }),
          session_uuid: root.sessionUuid,
        },
        requestedMode: null,
        deliveryMode: null,
        degradedReason: null,
        reason: input.reason ?? null,
        outcome: "queued",
        outcomeDetail: null,
        issuedByUserId: actingUserId,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + KILL_EXPIRES_IN_MS),
      });
      await store.supersede({
        scope,
        runPublicId: root.publicId,
        command: "kill",
        successorPublicId: commandId,
        now,
      });
      return { sessionsSealed, kill: { status: "queued" as const, commandId } };
    });

    logger.info(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        runId: input.runId,
        sessionsSealed: result.sessionsSealed,
        kill: result.kill.status,
      },
      "seal_run: sealed",
    );

    // After the commit, as ingest sends it when a host seals a run: the
    // rollup rebuilds the run's cost as final. Best-effort, because the seal
    // has committed and the nightly sweep rolls up a run whose event is lost.
    try {
      await deps.sendEvent({
        name: "cost/run.sealed",
        data: {
          runId: input.runId,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
        },
      });
    } catch (err) {
      logger.error(
        { err, runId: input.runId },
        "seal_run: cost/run.sealed dispatch failed; the nightly sweep rolls the run up",
      );
    }

    return {
      runId: input.runId,
      sealedAt: now.toISOString(),
      sessionsSealed: result.sessionsSealed,
      kill: result.kill,
    };
  };
}

// ---- Postgres ------------------------------------------------------------------------

const sessions = schema.tachoSessions;

/** The chain is open, or its only seal is the idle close. */
const openOrIdleClosed = () =>
  or(isNull(sessions.sealedAt), eq(sessions.sealSource, "idle_timeout"));

export function postgresSealStore(tx: Tx): SealStore {
  const commands = postgresCommandStore(tx);
  return {
    ledgerRunExists: commands.ledgerRunExists,
    insert: commands.insert,
    supersede: commands.supersede,
    lockRoot: async (scope, publicId) => {
      // The lock first. An ingest batch that writes this row waits for the
      // seal to commit, and one already writing it commits before this read.
      const [locked] = await tx
        .select({
          sealedAt: sessions.sealedAt,
          sealSource: sessions.sealSource,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.publicId, publicId),
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
            isNull(sessions.parentSessionUuid),
          ),
        )
        .limit(1)
        .for("update");
      if (!locked) return null;
      const session = await commands.session(scope, publicId);
      if (!session) return null;
      return {
        ...session,
        sealedAt: locked.sealedAt,
        sealSource: locked.sealSource,
      };
    },
    lockSealableChains: async (scope, root) => {
      const rows = await tx
        .select({
          id: sessions.id,
          publicId: sessions.publicId,
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
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
            // A root's chain names itself as its root; the id covers a row
            // that does not.
            or(
              eq(sessions.id, root.id),
              eq(sessions.rootSessionUuid, root.sessionUuid),
            ),
            openOrIdleClosed(),
          ),
        )
        // One order for every lock this statement takes.
        .orderBy(asc(sessions.id))
        .for("update");
      // As the idle close reads it: the seal's end is this instant.
      return rows.map((row) => ({
        ...row,
        lastEventAt: new Date(row.lastEventAt),
      }));
    },
    retentionMode: async (scope) => {
      const policy = await readLatestRetentionPolicy(
        tx,
        scope.orgId,
        scope.workspaceId,
      );
      // The idle close's default, and ingest's at an `agent_stop`.
      return policy?.mode ?? "content_exact";
    },
    seal: async (scope, chainId, columns) => {
      const written = await tx
        .update(sessions)
        .set(columns)
        .where(
          and(
            eq(sessions.id, chainId),
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
            openOrIdleClosed(),
          ),
        )
        .returning({ id: sessions.id });
      return written.length > 0;
    },
  };
}

function defaultSealRunDeps(): SealRunDeps {
  return {
    withStore: (fn) => withTenantDb((tx) => fn(postgresSealStore(tx))),
    now: () => new Date(),
    sendEvent: (event) => eventClient.send(event),
  };
}

export const runSealHandler = createSealRunHandler(defaultSealRunDeps());
