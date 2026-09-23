// `dispatch_command`: queue a run control (Mission Control spec §7.3, §7.4,
// §7.6; ADR-056).
//
// The target is resolved to recipient runs: one run, an agent's live runs, or
// every live run in the workspace. One `tacho.control_commands` row is written
// per recipient, addressed to the run (`target_kind = run`) and carried by the
// host its session belongs to. The collector takes the row on its next ingest
// response or command poll (`fetch_commands`) and reports what became of it.
//
// The one connection point in this tree is the hook adapter (decision 1 of
// ADR-056): a run is reachable when it is a live wrapped session at `harness`
// or `gateway` tier. An `observe`-tier session has no adapter in the path, so
// a command addressed to it directly is refused (§7.3 "refused, not queued"),
// and a broadcast records it as `failed` with the reason so the delivery
// report is complete (§7.6). A direct ledger cancel fences further appends and
// revokes its run credentials in the command transaction. Pause and resume
// fence ledger ingress. Steering still requires a producer connection point.
// Broadcasts enumerate wrapped sessions.
//
// A delivery mode is resolved per recipient at dispatch, at or below the
// requested one: the hook adapter cannot stop an in-flight call, so
// `interrupt` degrades to `next_step` with `degraded_reason = harness_tier`.
// A run on the `gateway` tier has its model traffic routed through the host's
// loopback proxy, which can, so there `interrupt` is delivered as `interrupt`.
// Both modes are recorded, and the report shows the achieved one.
//
// A new command supersedes an earlier `queued` command of the same kind on the
// same run: the earlier row becomes `cancelled` with the successor's id, so a
// run never receives two steers where the operator meant a correction.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  type CommandTarget,
  type DispatchCommandOutput,
  PROMPT_COMMANDS,
  type RunCommand,
  tachoCommandDispatch,
} from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import type { TachoDeliveryMode } from "@oxagen/tacho";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { revokeRunTokens } from "./lib/run-token";
import {
  cancelRunInTransaction,
  setRunIngressPaused,
  lockRunForControl,
  createPostgresRunStore,
} from "@oxagen/run-ledger";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { logger } from "./logger";
import { ledgerIdentityQuery, type RunScope, runScope } from "./run.list";

// ---- Delivery mode resolution --------------------------------------------------------

/** Why the achieved mode is below the requested one (spec §7.3). */
type DegradedReason = "harness_tier";

type ResolvedMode = {
  deliveryMode: TachoDeliveryMode;
  degradedReason: DegradedReason | null;
};

/**
 * The strongest mode the recipient's connection point can carry at or below
 * the request.
 *
 * The hook adapter injects at the next prompt boundary and cannot stop a call
 * in flight, so on the `harness` tier `interrupt` lands as `next_step` and says
 * so. `turn_boundary` is the next turn's prompt, which the adapter reaches.
 *
 * On the `gateway` tier the run's model traffic is routed through the host's
 * loopback proxy (ADR-094), which can cut the call in flight, so `interrupt` is
 * delivered as `interrupt` (ADR-095: "`interrupt` degrades at `harness` and is
 * real at `gateway`"). The host still reports what happened: the applied frame
 * carries `command.interrupted`, which is `1` only when a call was cut.
 */
export function resolveDeliveryMode(
  requested: TachoDeliveryMode,
  enforcementTier = "harness",
): ResolvedMode {
  if (
    requested === "interrupt" &&
    enforcementTier !== "gateway" &&
    enforcementTier !== "contained"
  ) {
    return { deliveryMode: "next_step", degradedReason: "harness_tier" };
  }
  return { deliveryMode: requested, degradedReason: null };
}

// ---- Recipients ----------------------------------------------------------------------

/** A wrapped session as the dispatcher needs to see it. */
export type RecipientSession = {
  id: string;
  publicId: string;
  sessionUuid: string;
  hostId: string | null;
  agentKey: string;
  /** `tacho.sessions.outcome`: `running` is live. */
  outcome: string;
  /** `tacho.sessions.enforcement_tier`: gateway, harness or observe. */
  enforcementTier: string;
};

/** Why a recipient cannot take the command (recorded on the row, or refused). */
type UndeliverableReason = "run_sealed" | "observe_tier";

function undeliverable(session: RecipientSession): UndeliverableReason | null {
  if (session.outcome !== "running") return "run_sealed";
  if (session.enforcementTier === "observe") return "observe_tier";
  return null;
}

/** §7.6 addressing as recorded on every row of a dispatch. */
export function addressOf(target: CommandTarget): string {
  switch (target.kind) {
    case "run":
      return target.id;
    case "agent":
      return `@${target.id}`;
    case "workspace":
      return "@agents";
  }
}

// ---- The store seam ------------------------------------------------------------------

export type CommandRowInput = {
  scope: RunScope;
  session: RecipientSession;
  command: RunCommand;
  payload: Record<string, unknown>;
  requestedMode: TachoDeliveryMode | null;
  deliveryMode: TachoDeliveryMode | null;
  degradedReason: DegradedReason | null;
  reason: string | null;
  outcome: "queued" | "failed";
  outcomeDetail: string | null;
  issuedByUserId: string | null;
  issuedAt: Date;
  expiresAt: Date;
};

/** The writes and reads one dispatch makes, all inside one tenant transaction. */
export interface CommandStore {
  /** One root session in the scope by its `tse_…` id. */
  session(scope: RunScope, publicId: string): Promise<RecipientSession | null>;
  /** Live root sessions in the scope, optionally one agent's. */
  liveSessions(
    scope: RunScope,
    agentKey: string | null,
  ): Promise<RecipientSession[]>;
  /** Whether an `arun_…` id names a ledger run in the scope. */
  ledgerRunExists(scope: RunScope, publicId: string): Promise<boolean>;
  setLedgerPaused(args: {
    scope: RunScope;
    publicId: string;
    command: "pause" | "resume";
    userId: string | null;
    now: Date;
    expiresAt: Date;
    reason: string | null;
  }): Promise<string>;
  cancelLedgerRun(args: {
    scope: RunScope;
    publicId: string;
    userId: string | null;
    now: Date;
    expiresAt: Date;
    reason: string | null;
  }): Promise<string>;
  insert(row: CommandRowInput): Promise<{ publicId: string }>;
  /** Cancel earlier `queued` rows of the same command on the run; returns how many. */
  supersede(args: {
    scope: RunScope;
    runPublicId: string;
    command: RunCommand;
    successorPublicId: string;
    now: Date;
  }): Promise<number>;
}

type DispatchCommandDeps = {
  /** Run `fn` against a store inside one tenant transaction. */
  withStore<T>(fn: (store: CommandStore) => Promise<T>): Promise<T>;
  now: () => Date;
};

// ---- The handler ---------------------------------------------------------------------

const notFound = (reason: string) =>
  new HandlerError({ code: "not_found", reason });
const refused = (reason: string, message: string) =>
  new HandlerError({ code: "conflict", reason, message });

/** The recipients a target names, or a refusal for a direct target that cannot receive. */
async function resolveRecipients(
  store: CommandStore,
  scope: RunScope,
  target: CommandTarget,
): Promise<RecipientSession[]> {
  switch (target.kind) {
    case "run": {
      if (target.id.startsWith("arun_")) {
        if (!(await store.ledgerRunExists(scope, target.id)))
          throw notFound("run_not_found");
        throw refused(
          "no_connection_point",
          "A ledger run has no connection point to carry a command",
        );
      }
      const session = await store.session(scope, target.id);
      if (!session) throw notFound("run_not_found");
      const reason = undeliverable(session);
      if (reason === "run_sealed")
        throw refused(
          "run_sealed",
          "The run has ended; nothing can receive it",
        );
      if (reason === "observe_tier")
        throw refused(
          "observe_tier",
          "An observe-tier run has no connection point; the command is refused",
        );
      return [session];
    }
    case "agent":
      return store.liveSessions(scope, target.id);
    case "workspace":
      if (target.id !== scope.workspaceId)
        throw notFound("workspace_not_found");
      return store.liveSessions(scope, null);
  }
}

export function createDispatchCommandHandler(
  deps: DispatchCommandDeps,
): CapabilityHandler<typeof tachoCommandDispatch> {
  return async (input, ctx): Promise<DispatchCommandOutput> => {
    // Org Owners and Admins control any run; a workspace Owner or Member
    // controls the runs of the workspace the call is scoped to, which is the
    // scope every recipient is resolved in (INV-29). The acting user is the
    // signed-in user or the creator of the API key, and is recorded as the
    // issuer.
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
    );
    const scope = runScope(ctx);
    const now = deps.now();
    const expiresAt = new Date(now.getTime() + input.expiresInMs);
    const address = addressOf(input.target);
    const carriesPrompt = PROMPT_COMMANDS.has(input.command);
    const requestedMode =
      carriesPrompt && input.payload ? input.payload.requestedMode : null;

    const commandIds = await deps.withStore(async (store) => {
      if (
        input.target.kind === "run" &&
        input.target.id.startsWith("arun_") &&
        input.command === "cancel"
      ) {
        return [
          await store.cancelLedgerRun({
            scope,
            publicId: input.target.id,
            userId: actingUserId,
            now,
            expiresAt,
            reason: input.reason ?? null,
          }),
        ];
      }
      if (
        input.target.kind === "run" &&
        input.target.id.startsWith("arun_") &&
        (input.command === "pause" || input.command === "resume")
      ) {
        return [
          await store.setLedgerPaused({
            scope,
            publicId: input.target.id,
            command: input.command,
            userId: actingUserId,
            now,
            expiresAt,
            reason: input.reason ?? null,
          }),
        ];
      }
      const sessions = await resolveRecipients(store, scope, input.target);
      const ids: string[] = [];
      for (const session of sessions) {
        const reason = undeliverable(session);
        const resolved =
          requestedMode !== null && reason === null
            ? resolveDeliveryMode(requestedMode, session.enforcementTier)
            : null;
        const payload: Record<string, unknown> = {
          address,
          session_uuid: session.sessionUuid,
          ...(input.payload ? { text: input.payload.text } : {}),
        };
        const { publicId } = await store.insert({
          scope,
          session,
          command: input.command,
          payload,
          requestedMode,
          deliveryMode: resolved?.deliveryMode ?? null,
          degradedReason: resolved?.degradedReason ?? null,
          reason: input.reason ?? null,
          outcome: reason === null ? "queued" : "failed",
          outcomeDetail: reason,
          issuedByUserId: actingUserId,
          issuedAt: now,
          expiresAt,
        });
        if (reason === null) {
          await store.supersede({
            scope,
            runPublicId: session.publicId,
            command: input.command,
            successorPublicId: publicId,
            now,
          });
        }
        ids.push(publicId);
      }
      return ids;
    });

    logger.info(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        command: input.command,
        address,
        recipients: commandIds.length,
      },
      "dispatch_command: queued",
    );
    return { commandIds };
  };
}

// ---- Postgres ------------------------------------------------------------------------

const sessions = schema.tachoSessions;
const commands = schema.tachoControlCommands;

const recipientColumns = {
  id: sessions.id,
  publicId: sessions.publicId,
  sessionUuid: sessions.sessionUuid,
  hostId: sessions.hostId,
  agentKey: sessions.agentKey,
  outcome: sessions.outcome,
  enforcementTier: sessions.enforcementTier,
};

export function postgresCommandStore(tx: Tx): CommandStore {
  const ledger = createPostgresRunStore();
  return {
    session: async (scope, publicId) => {
      const rows = await tx
        .select(recipientColumns)
        .from(sessions)
        .where(
          and(
            eq(sessions.publicId, publicId),
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
            isNull(sessions.parentSessionUuid),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    liveSessions: (scope, agentKey) =>
      tx
        .select(recipientColumns)
        .from(sessions)
        .where(
          and(
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
            isNull(sessions.parentSessionUuid),
            eq(sessions.outcome, "running"),
            agentKey === null ? undefined : eq(sessions.agentKey, agentKey),
          ),
        )
        .orderBy(sessions.startedAt),
    setLedgerPaused: async ({
      scope,
      publicId,
      command,
      userId,
      now,
      expiresAt,
      reason,
    }) => {
      const run = await lockRunForControl(tx, scope, publicId);
      if (!run) throw notFound("run_not_found");
      if (run.cancelled)
        throw refused(
          "run_cancelled",
          `The run was cancelled. Its evidence ingress cannot be ${command}d`,
        );
      if (!["pending", "running"].includes(run.status))
        throw refused("run_sealed", "The run has ended");
      const paused = command === "pause";
      const outcomeDetail = paused
        ? "ledger_ingress_paused"
        : "ledger_ingress_resumed";
      if (run.paused === paused) {
        const [existing] = await tx
          .select({ publicId: commands.publicId })
          .from(commands)
          .where(
            and(
              eq(commands.orgId, scope.orgId),
              eq(commands.workspaceId, scope.workspaceId),
              eq(commands.targetId, publicId),
              eq(commands.command, command),
              eq(commands.outcome, "applied"),
              eq(commands.outcomeDetail, outcomeDetail),
            ),
          )
          .orderBy(desc(commands.issuedAt))
          .limit(1);
        if (existing) return existing.publicId;
      }
      await setRunIngressPaused(tx, run.id, paused, now);
      const [receipt] = await tx
        .insert(commands)
        .values({
          ...scope,
          hostId: null,
          sessionId: null,
          targetKind: "run",
          targetId: publicId,
          command,
          payload: { address: publicId },
          reason,
          issuedByUserId: userId,
          issuedAt: now,
          expiresAt,
          outcome: "applied",
          outcomeDetail,
          appliedAt: now,
          createdById: userId,
          updatedById: userId,
        })
        .returning({ publicId: commands.publicId });
      if (!receipt)
        throw new Error("Run ingress control receipt was not written");
      return receipt.publicId;
    },
    cancelLedgerRun: async ({
      scope,
      publicId,
      userId,
      now,
      expiresAt,
      reason,
    }) => {
      const run = await lockRunForControl(tx, scope, publicId);
      if (!run) throw notFound("run_not_found");
      // The receipt first, then the status: `cancelRunInTransaction` sets
      // `cancelRequested` and the status becomes `cancelled` when the
      // producer seals, so a cancel retried after that seal must find its
      // receipt rather than a `run_sealed` refusal.
      if (run.cancelled) {
        const [existing] = await tx
          .select({ publicId: commands.publicId })
          .from(commands)
          .where(
            and(
              eq(commands.orgId, scope.orgId),
              eq(commands.workspaceId, scope.workspaceId),
              eq(commands.targetId, publicId),
              eq(commands.command, "cancel"),
              eq(commands.outcome, "applied"),
              eq(commands.outcomeDetail, "ledger_ingress_revoked"),
            ),
          )
          .orderBy(desc(commands.issuedAt))
          .limit(1);
        if (existing) return existing.publicId;
      }
      if (!["pending", "running"].includes(run.status))
        throw refused("run_sealed", "The run has ended");
      await cancelRunInTransaction(tx, run.id, now);
      await revokeRunTokens(tx, scope, run.id, now);
      const [receipt] = await tx
        .insert(commands)
        .values({
          ...scope,
          hostId: null,
          sessionId: null,
          targetKind: "run",
          targetId: publicId,
          command: "cancel",
          payload: { address: publicId },
          reason,
          issuedByUserId: userId,
          issuedAt: now,
          expiresAt,
          outcome: "applied",
          outcomeDetail: "ledger_ingress_revoked",
          appliedAt: now,
          createdById: userId,
          updatedById: userId,
        })
        .returning({ publicId: commands.publicId });
      if (!receipt) throw new Error("Run cancellation receipt was not written");
      return receipt.publicId;
    },
    ledgerRunExists: async (scope, publicId) => {
      const summary = await ledger.getRunByPublicId(publicId);
      if (!summary) return false;
      const rows = await ledgerIdentityQuery(tx, scope, summary.runId);
      return rows.length > 0;
    },
    insert: async (row) => {
      const [inserted] = await tx
        .insert(commands)
        .values({
          orgId: row.scope.orgId,
          workspaceId: row.scope.workspaceId,
          hostId: row.session.hostId,
          sessionId: row.session.id,
          targetKind: "run",
          targetId: row.session.publicId,
          command: row.command,
          payload: row.payload,
          requestedMode: row.requestedMode,
          deliveryMode: row.deliveryMode,
          degradedReason: row.degradedReason,
          reason: row.reason,
          issuedByUserId: row.issuedByUserId,
          issuedAt: row.issuedAt,
          expiresAt: row.expiresAt,
          outcome: row.outcome,
          outcomeDetail: row.outcomeDetail,
          createdById: row.issuedByUserId,
          updatedById: row.issuedByUserId,
        })
        .returning({ publicId: commands.publicId });
      if (!inserted)
        throw new Error("dispatch_command: insert returned no row");
      return inserted;
    },
    supersede: async ({
      scope,
      runPublicId,
      command,
      successorPublicId,
      now,
    }) => {
      const cancelled = await tx
        .update(commands)
        .set({
          outcome: "cancelled",
          outcomeDetail: `superseded_by:${successorPublicId}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(commands.orgId, scope.orgId),
            eq(commands.workspaceId, scope.workspaceId),
            eq(commands.targetKind, "run"),
            eq(commands.targetId, runPublicId),
            eq(commands.command, command),
            eq(commands.outcome, "queued"),
            ne(commands.publicId, successorPublicId),
          ),
        )
        .returning({ id: commands.id });
      return cancelled.length;
    },
  };
}

function defaultDispatchCommandDeps(): DispatchCommandDeps {
  return {
    withStore: (fn) => withTenantDb((tx) => fn(postgresCommandStore(tx))),
    now: () => new Date(),
  };
}

export const tachoCommandDispatchHandler = createDispatchCommandHandler(
  defaultDispatchCommandDeps(),
);
