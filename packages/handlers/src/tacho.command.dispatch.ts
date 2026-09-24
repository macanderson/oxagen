// `dispatch_command`: queue a run control (Mission Control spec §7.3, §7.4,
// §7.6; ADR-056).
//
// The target is resolved to recipient runs: one run, an agent's live runs, or
// every live run in the workspace. One `tacho.control_commands` row is written
// per recipient, addressed to the run (`target_kind = run`) and carried by the
// host its session belongs to. The collector takes the row on its next ingest
// response or command poll (`fetch_commands`) and reports what became of it.
//
// The connection point is the host's command poll (ADR-056, ADR-163): a run is
// reachable when it is a live wrapped session whose host is enrolled and has
// polled within `HOST_POLL_WINDOW_MS`, whatever its enforcement tier. The tier
// governs policy verdicts; it never takes away the operator's ability to stop
// their own agent. A run that cannot be reached is refused when addressed
// directly (§7.3 "refused, not queued"), and a broadcast records it as
// `failed` with the reason so the delivery report is complete (§7.6). The
// reason is `commandBlockOf`'s, the rule every run row also reads, so the page
// never offers a control this handler refuses. A direct ledger cancel fences further appends and
// revokes its run credentials in the command transaction. Pause and resume
// fence ledger ingress. Steering still requires a producer connection point.
// Broadcasts enumerate wrapped sessions.
//
// A delivery mode is resolved per recipient at dispatch, at or below the
// requested one, and only to a mode the host can carry. The hook adapter
// delivers steering text at the next prompt, so without a host that
// advertises a step carrier (`steer_next_step`) both `next_step` and
// `interrupt` degrade to `turn_boundary` with `degraded_reason =
// no_step_carrier`. With one, `interrupt` degrades to `next_step`
// (`harness_tier`) unless the run's model traffic goes through the host's
// loopback proxy (`gateway`, `contained`), which can cut a call in flight.
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
import {
  type CommandBlock,
  commandBlockOf,
} from "@oxagen/oxagen/contracts/run.list";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { logger } from "./logger";
import { ledgerIdentityQuery, type RunScope, runScope } from "./run.list";

// ---- Delivery mode resolution --------------------------------------------------------

/**
 * The bundle feature a host advertises when it can put steering text in
 * front of the agent before its next step, rather than at the next prompt.
 * The host side (#4027) declares the same word in `@oxagen/tacho`'s
 * `wire.ts`; this copy goes when that lands.
 */
export const BUNDLE_FEATURE_STEER_NEXT_STEP = "steer_next_step";

/**
 * The runtimes whose hook adapter carries a steer mid-turn, once the host
 * advertises the feature. Claude Code and Codex deliver at `PostToolUse` and
 * at `Stop` as a block. Cursor's adapter delivers at `Stop` only, which is
 * the end of the turn (ADR-141), and Stella's only at `SessionStart`, so a
 * host carrying the feature still cannot move either one's steer earlier.
 */
const STEP_CARRIER_RUNTIMES: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
]);

/**
 * Why the achieved mode is below the requested one (spec §7.3).
 *
 * - `no_step_carrier`: the host delivers steering text only at the next
 *   prompt, so the steer waits for the next turn.
 * - `harness_tier`: the host can steer before the next step, but nothing on
 *   the run's path can cut a model call in flight.
 */
type DegradedReason = "no_step_carrier" | "harness_tier";

type ResolvedMode = {
  deliveryMode: TachoDeliveryMode;
  degradedReason: DegradedReason | null;
};

/**
 * The strongest mode the recipient's host can carry at or below the request.
 *
 * The hook adapter injects steering text at the next prompt
 * (`UserPromptSubmit`), so `turn_boundary` is the one mode every host
 * delivers. `next_step` needs a host that advertises
 * `BUNDLE_FEATURE_STEER_NEXT_STEP` and a runtime in `STEP_CARRIER_RUNTIMES`;
 * without both, `next_step` and `interrupt` are recorded as `turn_boundary`, which is when the text will arrive. Cutting
 * a call without delivering the text would disrupt the run and steer nothing.
 *
 * With a step carrier, `interrupt` also needs the run's model traffic routed
 * through the host's loopback proxy (ADR-094), which can cut the call in
 * flight: the `gateway` and `contained` tiers (ADR-095). Elsewhere it lands as
 * `next_step`. The host still reports what happened: the applied frame carries
 * `command.interrupted`, which is `1` only when a call was cut.
 */
export function resolveDeliveryMode(
  requested: TachoDeliveryMode,
  enforcementTier: string,
  hostFeatures: readonly string[],
  runtime: string,
): ResolvedMode {
  if (requested === "turn_boundary")
    return { deliveryMode: requested, degradedReason: null };
  if (
    !hostFeatures.includes(BUNDLE_FEATURE_STEER_NEXT_STEP) ||
    !STEP_CARRIER_RUNTIMES.has(runtime)
  )
    return { deliveryMode: "turn_boundary", degradedReason: "no_step_carrier" };
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
  /** `tacho.sessions.runtime`: the harness, which decides the steer carrier. */
  runtime: string;
  /** `tacho.sessions.outcome`: `running` is live. */
  outcome: string;
  /** `tacho.sessions.enforcement_tier`: gateway, harness or observe. */
  enforcementTier: string;
  /** The session's host as its polls left it; null when it names none. */
  host: {
    status: string;
    lastSeenAt: Date | null;
    /** What the host advertised on its last health report. */
    bundleFeatures: readonly string[];
  } | null;
};

/**
 * Why a recipient cannot take the command (recorded on the row, or refused).
 * The run's own rule, so the controls a row offers and this handler agree.
 */
function undeliverable(
  session: RecipientSession,
  now: Date,
): CommandBlock | null {
  return commandBlockOf({
    outcome: session.outcome,
    host: session.host,
    now,
  });
}

/** What `dispatch_command` says when a run named directly cannot be reached. */
const BLOCK_MESSAGES: Record<CommandBlock, string> = {
  run_sealed: "The run has ended; nothing can receive it",
  no_host: "The run names no enrolled host to carry the command",
  host_revoked: "The run's host enrollment was revoked; it takes no commands",
  host_offline:
    "The run's host has not checked in for five minutes; nothing would take the command",
};

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
  now: Date,
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
      const reason = undeliverable(session, now);
      if (reason !== null) throw refused(reason, BLOCK_MESSAGES[reason]);
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
      const sessions = await resolveRecipients(
        store,
        scope,
        input.target,
        now,
      );
      const ids: string[] = [];
      for (const session of sessions) {
        const reason = undeliverable(session, now);
        const resolved =
          requestedMode !== null && reason === null
            ? resolveDeliveryMode(
                requestedMode,
                session.enforcementTier,
                session.host?.bundleFeatures ?? [],
                session.runtime,
              )
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
const hosts = schema.tachoHosts;
const commands = schema.tachoControlCommands;

const recipientColumns = {
  id: sessions.id,
  publicId: sessions.publicId,
  sessionUuid: sessions.sessionUuid,
  hostId: sessions.hostId,
  agentKey: sessions.agentKey,
  runtime: sessions.runtime,
  outcome: sessions.outcome,
  enforcementTier: sessions.enforcementTier,
  hostRowId: hosts.id,
  hostStatus: hosts.status,
  hostLastSeenAt: hosts.lastSeenAt,
  hostBundleFeatures: hosts.bundleFeatures,
};

/** A session row with its host's liveness, as `recipientColumns` selects it. */
type RecipientRow = {
  id: string;
  publicId: string;
  sessionUuid: string;
  hostId: string | null;
  agentKey: string;
  runtime: string;
  outcome: string;
  enforcementTier: string;
  hostRowId: string | null;
  hostStatus: string | null;
  hostLastSeenAt: Date | null;
  hostBundleFeatures: string[] | null;
};

function recipientOf(row: RecipientRow): RecipientSession {
  const {
    hostRowId,
    hostStatus,
    hostLastSeenAt,
    hostBundleFeatures,
    ...session
  } = row;
  return {
    ...session,
    host:
      hostRowId === null || hostStatus === null
        ? null
        : {
            status: hostStatus,
            lastSeenAt: hostLastSeenAt,
            bundleFeatures: hostBundleFeatures ?? [],
          },
  };
}

export function postgresCommandStore(tx: Tx): CommandStore {
  const ledger = createPostgresRunStore();
  return {
    session: async (scope, publicId) => {
      const rows = await tx
        .select(recipientColumns)
        .from(sessions)
        .leftJoin(hosts, eq(hosts.id, sessions.hostId))
        .where(
          and(
            eq(sessions.publicId, publicId),
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
            isNull(sessions.parentSessionUuid),
          ),
        )
        .limit(1);
      return rows[0] ? recipientOf(rows[0]) : null;
    },
    liveSessions: async (scope, agentKey) => {
      const rows = await tx
        .select(recipientColumns)
        .from(sessions)
        .leftJoin(hosts, eq(hosts.id, sessions.hostId))
        .where(
          and(
            eq(sessions.orgId, scope.orgId),
            eq(sessions.workspaceId, scope.workspaceId),
            isNull(sessions.parentSessionUuid),
            eq(sessions.outcome, "running"),
            agentKey === null ? undefined : eq(sessions.agentKey, agentKey),
          ),
        )
        .orderBy(sessions.startedAt);
      return rows.map(recipientOf);
    },
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
