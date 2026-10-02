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
//
// A setup that stopped with `choose_connection` recorded its candidates. A
// retry that names one of them stores it as the organization's steering
// connection first, so the job's pick_connection finds it and goes on
// (#4875). A pick the state did not record is refused before anything
// changes.
//
// `resetConnection` clears the organization's stored connection first, so the
// job lists the candidates again (#4899). The reset is refused once Oxagen has
// created a steering repo in the stored organization.
//
// A workspace with no repository yet can change where it goes and what it is
// called (#5196). A `connection` that is not one of the recorded choices, and
// a `name`, become the state's `requested_connection` and `requested_name`.
// The job's pick_connection checks the place against the stored tokens, so
// this handler calls no host.
import { schema, withSystemDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError, type CapabilityContext, type CapabilityHandler } from "@oxagen/oxagen";
import { steeringRepoProvisionRetry } from "@oxagen/oxagen/contracts/steering_repo.provision.retry";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
import { and, eq } from "drizzle-orm";
import { eventClient } from "./event-client";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";
import {
  STEERING_REPO_PROVISION_EVENT,
  pickSteeringConnection,
  readSteeringRepoState,
  resetSteeringConnection,
  saveSteeringRepoState,
  storeChosenSteeringConnection,
  type SteeringConnection,
  type SteeringRepoProvisionRequest,
  type SteeringRepoScope,
  type SteeringRepoState,
} from "./steering_repo.provision";

export interface RetrySteeringRepoProvisionDeps {
  loadState(scope: SteeringRepoScope): Promise<SteeringRepoState | null>;
  saveState(scope: SteeringRepoScope, state: SteeringRepoState): Promise<void>;
  /**
   * Store the picked connection as the organization's steering connection,
   * or refuse it when the organization already holds a different one.
   */
  saveConnection(orgId: string, connection: SteeringConnection): Promise<void>;
  /**
   * Clear the organization's stored connection, or refuse while a setup of
   * the organization recorded a repository in it.
   */
  resetConnection(orgId: string): Promise<SteeringConnection | null>;
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
  return async (input, ctx) => {
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

    const recorded =
      input.connection === undefined
        ? null
        : pickSteeringConnection(current, input.connection);
    // A connection the setup did not record, or a new name, changes the
    // workspace's own request. Both need a workspace with no repository and
    // no run in flight.
    const newPlace = input.connection !== undefined && recorded === null;
    if (input.name !== undefined || newPlace) {
      if (scope.kind !== "workspace" && newPlace)
        throw new HandlerError({
          code: "conflict",
          reason: "unknown_connection",
          message: `retry_steering_repo_provision: ${input.connection?.provider} ${input.connection?.id} is not one of the connections this setup found. Read get_steering_repo for its connectionChoices.`,
        });
      if (scope.kind !== "workspace")
        throw new HandlerError({
          code: "conflict",
          reason: "organization_repo_fixed",
          message:
            "retry_steering_repo_provision: the organization's steering repo is always oxagen-config, so it takes no name.",
        });
      if (current.repository !== null)
        throw new HandlerError({
          code: "conflict",
          reason: "repository_exists",
          message: `retry_steering_repo_provision: Oxagen already created ${current.repository.full_name}, so its name and place stay as they are.`,
        });
      if (current.status !== "failed" && current.status !== "blocked")
        throw new HandlerError({
          code: "conflict",
          reason: "setup_running",
          message:
            "retry_steering_repo_provision: the steering repo setup is still running. Wait for it to stop, then change the name or the place.",
        });
    }

    if (current.status !== "failed" && current.status !== "blocked") {
      return { status: current.status };
    }

    // Resolved and refused before the state flip below, so a caller with no
    // principal behind it (a deleted API key, a session gone stale) never
    // leaves the record stuck in "provisioning" with no event ever sent.
    const actorUserId = await resolveActingUserId(ctx);
    if (actorUserId === null) {
      throw new HandlerError({
        code: "forbidden",
        reason: "no_principal",
        message: "retry_steering_repo_provision: no signed-in user or API key creator behind this call",
      });
    }

    // Clearing or saving the stored connection writes the organization's
    // connection, which every workspace's setup reads. A workspace Owner or
    // Admin may retry their own setup (#5228), but only an org Owner or Admin
    // changes the connection.
    if (input.resetConnection === true || recorded !== null) {
      await assertOrgRole(
        { ...ctx, userId: actorUserId },
        { org: ["Owner", "Admin"], namedRolesOnly: true },
      );
    }

    if (input.resetConnection === true) await deps.resetConnection(ctx.orgId);

    if (recorded !== null) await deps.saveConnection(ctx.orgId, recorded);

    // A new request starts the name over at its first attempt, and a new
    // place drops the connection the last run resolved.
    const requested: Partial<SteeringRepoState> = {
      ...(input.name === undefined
        ? {}
        : { requested_name: input.name, attempt: 1, candidate: null }),
      ...(newPlace
        ? {
            requested_connection: input.connection,
            connection: null,
            connection_choices: [],
          }
        : {}),
    };

    const now = deps.now();
    const retrying: SteeringRepoState = {
      ...current,
      ...requested,
      status: "provisioning",
      error: null,
      ...(recorded === null ? {} : { connection_choices: [] }),
      updated_at: now.toISOString(),
    };
    await deps.saveState(scope, retrying);

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
    // tenancy: filtered by orgId, which scopeOf took from the capability
    // context the kernel already scoped to the caller's own organization.
    const [org] = await withSystemDb((tx) =>
      tx
        .select({ settings: schema.organizations.settings })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, scope.orgId))
        .limit(1),
    );
    return org ? readSteeringRepoState(org.settings) : null;
  }
  // tenancy: filtered by workspaceId and orgId together, both from the
  // capability context the kernel already scoped to the caller.
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
  saveConnection: storeChosenSteeringConnection,
  resetConnection: resetSteeringConnection,
  send: async (data, eventId) => {
    await eventClient.send({ name: STEERING_REPO_PROVISION_EVENT, data, id: eventId });
  },
  now: () => new Date(),
});
