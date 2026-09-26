// `pause_workspace_runs` (#3862): pause every live wrapped run in the
// workspace as one governed decision, with one audit event and a receipt.
//
// `dispatch_command` with target `{ kind: "workspace" }` queues the same
// pauses. This handler differs in four ways:
//
// - Roles. It admits org Owner and Admin and workspace Owner. A workspace
//   Member, whom `dispatch_command` admits, is refused.
// - Approval. The contract parks an in-app agent's call for a person.
// - The receipt. It separates the runs that took the pause from the runs
//   that were skipped, and says why each was skipped.
// - The audit. One `tacho.workspace_runs_paused` security event records the
//   decision with its counts, in the same transaction as the command rows.
//
// Which runs are reached (ADR-163): every live root session in the caller's
// workspace. A run whose host is enrolled and polling takes the pause,
// whatever its enforcement tier, so an `observe`-tier run is paused too.
// A run `commandBlockOf` calls unreachable gets a `failed` row with the reason
// and is listed as skipped, the way the `@agents` broadcast records it
// (§7.6). A session the control plane closed for silence is not live and is
// not enumerated. Ledger runs (`arun_…`) are left alone: `liveSessions` reads
// wrapped sessions only, and a ledger run is paused from its own row.
//
// The rows are written by the same helper `dispatch_command` uses
// (`lib/run-command-recipients.ts`), so the two cannot disagree about what a
// queued or a failed row looks like, or about supersession.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  type PauseWorkspaceRunsOutput,
  pauseWorkspaceRuns,
} from "@oxagen/oxagen/contracts/tacho.workspace_runs.pause";
import { commandBlockOf } from "@oxagen/oxagen/contracts/run.list";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { withTenantDb } from "@oxagen/database";
import { emitSecurityEventIn } from "@oxagen/database/security";
import { writeRecipientCommand } from "./lib/run-command-recipients";
import { logger } from "./logger";
import { runScope } from "./run.list";
import {
  addressOf,
  type CommandStore,
  postgresCommandStore,
} from "./tacho.command.dispatch";

/** How long a queued pause waits for its host: `dispatch_command`'s default. */
export const PAUSE_EXPIRES_MS = 3_600_000;

/** The audit row this handler writes, in the shape the security events table takes. */
export type AuditEvent = Parameters<typeof emitSecurityEventIn>[1];

/** Writes one audit row inside the same transaction as the command rows. */
export type AuditSink = (event: AuditEvent) => Promise<void>;

type PauseWorkspaceRunsDeps = {
  /** Run `fn` against a store and an audit sink inside one tenant transaction. */
  withStore<T>(
    fn: (store: CommandStore, audit: AuditSink) => Promise<T>,
  ): Promise<T>;
  now: () => Date;
};

export function createPauseWorkspaceRunsHandler(
  deps: PauseWorkspaceRunsDeps,
): CapabilityHandler<typeof pauseWorkspaceRuns> {
  return async (input, ctx): Promise<PauseWorkspaceRunsOutput> => {
    // The acting user is the signed-in user or the creator of the API key.
    // That user is recorded as the issuer of every row and as the actor on
    // the audit event.
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner"] },
    );
    const scope = runScope(ctx);
    const now = deps.now();
    const expiresAt = new Date(now.getTime() + PAUSE_EXPIRES_MS);
    const address = addressOf({ kind: "workspace", id: scope.workspaceId });

    const receipt = await deps.withStore(async (store, audit) => {
      const sessions = await store.liveSessions(scope, null);
      const commandIds: string[] = [];
      const skipped: PauseWorkspaceRunsOutput["skipped"] = [];
      for (const session of sessions) {
        // The tier is never read here (ADR-163): reach is the host's poll.
        const block = commandBlockOf({
          outcome: session.outcome,
          sealSource: session.sealSource,
          host: session.host,
          now,
        });
        const { publicId } = await writeRecipientCommand(
          store,
          {
            scope,
            session,
            command: "pause",
            payload: { address, session_uuid: session.sessionUuid },
            requestedMode: null,
            deliveryMode: null,
            degradedReason: null,
            reason: input.reason,
            issuedByUserId: actingUserId,
            issuedAt: now,
            expiresAt,
          },
          block,
        );
        if (block === null) commandIds.push(publicId);
        else
          skipped.push({
            runId: session.publicId,
            agentKey: session.agentKey,
            reason: block,
            commandId: publicId,
          });
      }
      await audit({
        eventType: "tacho.workspace_runs_paused",
        actorUserId: actingUserId,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        capability: pauseWorkspaceRuns.name,
        outcome: "success",
        occurredAt: now,
        ip: ctx.clientIp ?? null,
        userAgent: null,
        requestId: ctx.requestId,
        detail: {
          reason: input.reason,
          queued: commandIds.length,
          commandIds,
          skipped: skipped.map(({ runId, reason }) => ({ runId, reason })),
        },
      });
      return { queued: commandIds.length, commandIds, skipped };
    });

    logger.info(
      {
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
        queued: receipt.queued,
        skipped: receipt.skipped.length,
      },
      "pause_workspace_runs: recorded",
    );
    return receipt;
  };
}

function defaultPauseWorkspaceRunsDeps(): PauseWorkspaceRunsDeps {
  return {
    withStore: (fn) =>
      withTenantDb((tx) =>
        fn(postgresCommandStore(tx), (event) => emitSecurityEventIn(tx, event)),
      ),
    now: () => new Date(),
  };
}

export const pauseWorkspaceRunsHandler = createPauseWorkspaceRunsHandler(
  defaultPauseWorkspaceRunsDeps(),
);
