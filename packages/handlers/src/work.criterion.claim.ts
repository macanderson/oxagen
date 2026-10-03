// `claim_work_criterion`: the agent working a send says it met one criterion
// of the brief on the pull request's head commit (ADR-244, ADR-251).
//
// The caller has to be the agent working the send. No existing context field
// names a Tacho-watched run on its own: the local gateway's
// `ctx.gatewaySessionUuid` names the daemon's own chain, not the agent's
// session. So the handler takes the narrowest field each caller has:
//
//   - An agent run's context names its run (`ctx.agentRun.runId`). The run
//     must be the one linked to the send.
//   - A host key names its host (`tacho_host_v1`, ADR-251). The host must be
//     the one that claimed the send, and the claim is filed as the run linked
//     to it. Ingest links only a run of the claiming host.
//
// A signed-in person and any other key are refused before anything is read: a
// person reads the claim on the work item and decides. The key's creator must
// still hold a role the contract grants, as for `claim_work_order`. The claim
// then runs in one tenant transaction (lib/work-records/claims.ts), and a work
// record refusal reaches the caller as a conflict, not found, forbidden, or
// invalid input (lib/work-records/errors.ts).
import type { CapabilityHandler, CheckedContext } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { workCriterionClaim, type WorkCriterionClaimOutput } from "@oxagen/oxagen/contracts/work.criterion.claim";
import { type Tx, withTenantDb } from "@oxagen/database";
import { type KeyScope, TACHO_HOST_PURPOSE, readKeyScope } from "@oxagen/iam/machine-key-scope";
import { assertContractRole } from "./lib/capability-role-guard";
import { resolveEnrolledHost } from "./lib/tacho-host";
import { claimWorkCriterion } from "./lib/work-records/claims";
import { refusingAs } from "./lib/work-records/errors";

export interface WorkCriterionClaimDeps {
  /** Opens the tenant transaction. Tests pass a fake. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** The scope on the calling API key. */
  keyScope: (orgId: string, apiKeyId: string) => Promise<KeyScope>;
  now: () => Date;
}

export const defaultWorkCriterionClaimDeps: WorkCriterionClaimDeps = {
  db: (fn) => withTenantDb(fn),
  keyScope: (orgId, apiKeyId) => readKeyScope(orgId, apiKeyId),
  now: () => new Date(),
};

function agentRequired(message: string): HandlerError {
  return new HandlerError({ code: "forbidden", reason: "agent_required", message });
}

/** The enrolled host a host key names, or a refusal for any other caller. Reads no tenant data. */
async function hostEnrollmentOf(deps: WorkCriterionClaimDeps, ctx: CheckedContext): Promise<string> {
  if (!ctx.apiKeyId) {
    throw agentRequired(
      "Only the agent working a send can claim a criterion. A person reads the claim on the work item and decides.",
    );
  }
  const scope = await deps.keyScope(ctx.orgId, ctx.apiKeyId);
  if (scope.kind === "purpose" && scope.purpose === TACHO_HOST_PURPOSE && scope.hostEnrollmentId !== undefined) {
    return scope.hostEnrollmentId;
  }
  throw agentRequired(
    "Only the agent working a send can claim a criterion, through its run or the key of the host running it. This key is neither.",
  );
}

export function createWorkCriterionClaimHandler(deps: WorkCriterionClaimDeps): CapabilityHandler<typeof workCriterionClaim> {
  return async (input, ctx): Promise<WorkCriterionClaimOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const agentRun = ctx.agentRun;
    if (agentRun) {
      await assertContractRole(workCriterionClaim, ctx);
      return refusingAs(workCriterionClaim.name, () =>
        deps.db((tx) => claimWorkCriterion(tx, scope, { kind: "run", runId: agentRun.runId }, input, deps.now())),
      );
    }
    const hostEnrollmentId = await hostEnrollmentOf(deps, ctx);
    await assertContractRole(workCriterionClaim, ctx);
    return refusingAs(workCriterionClaim.name, () =>
      deps.db(async (tx) => {
        const host = await resolveEnrolledHost(workCriterionClaim.name, ctx, tx as never, hostEnrollmentId);
        return claimWorkCriterion(
          tx,
          scope,
          {
            kind: "host",
            host: { id: host.id, publicId: String(host.publicId), runtimeId: host.runtimeId, agentId: host.agentId },
          },
          input,
          deps.now(),
        );
      }),
    );
  };
}

export const workCriterionClaimHandler = createWorkCriterionClaimHandler(defaultWorkCriterionClaimDeps);
