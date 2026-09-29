// steering_repo.provision.retry.ts: retry_steering_repo_provision (#4750).
//
// The health banner's Retry button, and the analogous organization setting,
// call this after a steering repo setup fails or is blocked. It flips the
// recorded state back to "provisioning", clears the error, and re-sends the
// provision event with a fresh id so Inngest's 24h dedup window (keyed on
// `steering-repo-backfill:<workspaceId>`, #4683/#4751) never eats a retry.
//
// Every other state field is left exactly as the failed run wrote it. The
// provisioning job (`provisionSteeringRepo` in ./steering_repo.provision)
// always starts its loop at the first step, but each step adopts or skips
// work it already finished by checking the fields it owns — a repository
// already created, a candidate name already chosen, the `attempt` counter
// the job itself increments on a naming collision. Preserving those fields
// is what makes the retry resume the run instead of starting it over.
import { schema, withSystemDb } from "@oxagen/database";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError, type CapabilityContext, type CapabilityHandler } from "@oxagen/oxagen";
import { steeringRepoProvisionRetry } from "@oxagen/oxagen/contracts/steering_repo.provision.retry";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
import { and, eq } from "drizzle-orm";
import { eventClient } from "./event-client";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";
import {
  STEERING_REPO_PROVISION_EVENT,
  readSteeringRepoState,
  saveSteeringRepoState,
  type SteeringRepoProvisionRequest,
  type SteeringRepoScope,
  type SteeringRepoState,
} from "./steering_repo.provision";

export interface RetrySteeringRepoProvisionDeps {
  loadState(scope: SteeringRepoScope): Promise<SteeringRepoState | null>;
  saveState(scope: SteeringRepoScope, state: SteeringRepoState): Promise<void>;
  send(data: SteeringRepoProvisionRequest, eventId: string): Promise<void>;
  now(): Date;
}

function scopeOf(ctx: CapabilityContext): SteeringRepoScope {
  return ctx.workspaceId === ORG_ONLY_WORKSPACE_ID
    ? { kind: "organization", orgId: ctx.orgId }
    : { kind: "workspace", orgId: ctx.orgId, workspaceId: ctx.workspaceId };
}

function retryEventId(scope: SteeringRepoScope, now: Date): string {
  const scopeKey = scope.kind === "workspace" ? scope.workspaceId : scope.orgId;
  return `steering-repo-retry:${scopeKey}:${now.getTime()}`;
}

export function createRetrySteeringRepoProvisionHandler(
  deps: RetrySteeringRepoProvisionDeps,
): CapabilityHandler<typeof steeringRepoProvisionRetry> {
  return async (_input, ctx) => {
    // The kernel's IAM check allows every capability for a non-enterprise
    // org, so the handler asks for the contract's roles itself (INV-29).
    await assertContractRole(steeringRepoProvisionRetry, ctx);

    const scope = scopeOf(ctx);
    const current = await deps.loadState(scope);
    if (current === null) {
      throw new HandlerError({
        code: "not_found",
        reason: "no_steering_repo_state",
        message: "retry_steering_repo_provision: this scope has no steering repository setup to retry",
      });
    }

    if (current.status !== "failed" && current.status !== "blocked") {
      return { status: current.status };
    }

    const now = deps.now();
    const retrying: SteeringRepoState = {
      ...current,
      status: "provisioning",
      error: null,
      updated_at: now.toISOString(),
    };
    await deps.saveState(scope, retrying);

    const actorUserId = await resolveActingUserId(ctx);
    const request: SteeringRepoProvisionRequest = {
      orgId: ctx.orgId,
      workspaceId: scope.kind === "workspace" ? scope.workspaceId : null,
      actorUserId,
    };

    try {
      await deps.send(request, retryEventId(scope, now));
      return { status: "provisioning" };
    } catch (err) {
      logger.error(
        { err, orgId: ctx.orgId, workspaceId: request.workspaceId },
        "retry_steering_repo_provision: could not queue the retry",
      );
      const failed: SteeringRepoState = {
        ...retrying,
        status: "failed",
        error: {
          code: "enqueue_failed",
          message: err instanceof Error ? err.message : String(err),
        },
        updated_at: new Date().toISOString(),
      };
      await deps.saveState(scope, failed).catch((saveErr: unknown) => {
        logger.error(
          { err: saveErr, orgId: ctx.orgId, workspaceId: request.workspaceId },
          "retry_steering_repo_provision: could not record the failed retry",
        );
      });
      return { status: "failed" };
    }
  };
}

async function loadSteeringRepoState(scope: SteeringRepoScope): Promise<SteeringRepoState | null> {
  if (scope.kind === "organization") {
    const [org] = await withSystemDb((tx) =>
      tx
        .select({ settings: schema.organizations.settings })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, scope.orgId))
        .limit(1),
    );
    return org ? readSteeringRepoState(org.settings) : null;
  }
  const [workspace] = await withSystemDb((tx) =>
    tx
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.id, scope.workspaceId),
          eq(schema.workspaces.orgId, scope.orgId),
        ),
      )
      .limit(1),
  );
  return workspace ? readSteeringRepoState(workspace.settings) : null;
}

export const retrySteeringRepoProvisionHandler = createRetrySteeringRepoProvisionHandler({
  loadState: loadSteeringRepoState,
  saveState: saveSteeringRepoState,
  send: async (data, eventId) => {
    await eventClient.send({ name: STEERING_REPO_PROVISION_EVENT, data, id: eventId });
  },
  now: () => new Date(),
});
