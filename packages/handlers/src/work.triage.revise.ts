// work.triage.revise.ts: revise_work_triage, a person corrects a triage
// suggestion or its outcome, or clears a correction (P1-03, #5103). The
// correction stays in force through every later triage run until a person
// clears it (effectiveTriage in @oxagen/work).
import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  workTriageRevise,
  reviseRequestProblem,
  type WorkTriageReviseOutput,
} from "@oxagen/oxagen/contracts/work.triage.revise";
import type { TriageView } from "@oxagen/work";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import { assertContractRole } from "./lib/capability-role-guard";
import type { ReviseFields, ReviseInput, ReviseResult } from "./lib/work-intake/actions";
import { workRefusal } from "./lib/work-intake/handler-support";
import type { WorkScope } from "./lib/work-records/store";

export interface WorkTriageReviseDeps {
  revise(scope: WorkScope, input: ReviseInput): Promise<ReviseResult>;
}

/** The Postgres store, loaded on the first call. */
export const defaultWorkTriageReviseDeps: WorkTriageReviseDeps = {
  async revise(scope, input) {
    return (await import("./lib/work-intake/actions")).reviseTriage(scope, input);
  },
};

/** The view as the contract spells it. */
export function triageViewOutput(view: TriageView): WorkTriageReviseOutput["triage"] {
  return {
    decision: view.decision,
    priority: view.priority,
    priority_reason: view.priorityReason,
    cites: view.cites,
    estimate_minutes: view.estimate_minutes,
    labels: view.labels,
    claims: view.claims,
    criteria: view.criteria,
    questions: view.questions,
    duplicates: view.duplicates,
    related: view.related,
    conflicts: view.conflicts,
  };
}

export function createWorkTriageReviseHandler(deps: WorkTriageReviseDeps): CapabilityHandler<typeof workTriageRevise> {
  return async (input, ctx): Promise<WorkTriageReviseOutput> => {
    await assertContractRole(workTriageRevise, ctx);
    // assertContractRole answers the role that passed, not who acted. The
    // actor is the person the call acts as, which the record stores as a
    // user id.
    const actorUserId = await resolveActingUserId(ctx);
    if (actorUserId === null) {
      throw new HandlerError({
        code: "forbidden",
        reason: "person_required",
        message: "Sign in to Oxagen to correct triage. The call names no person to record as the actor.",
      });
    }
    const problem = reviseRequestProblem(input);
    if (problem !== null) throw new CapabilityError(workTriageRevise.name, "invalid_input", problem);
    const fields: ReviseFields = {};
    if (input.priority !== undefined) fields.priority = input.priority;
    if (input.estimate_minutes !== undefined) fields.estimate_minutes = input.estimate_minutes;
    if (input.labels !== undefined) fields.labels = input.labels;
    if (input.claims !== undefined) fields.claims = input.claims;
    if (input.criteria !== undefined) fields.criteria = input.criteria;
    let result: ReviseResult;
    try {
      result = await deps.revise(
        { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
        {
          itemPublicId: input.item_id,
          expectedVersion: input.expected_version,
          reason: input.reason,
          fields,
          ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
          ...(input.duplicate_of !== undefined ? { duplicateOf: input.duplicate_of } : {}),
          actorUserId,
        },
      );
    } catch (error) {
      throw workRefusal(workTriageRevise.name, error);
    }
    return {
      item_id: result.item.publicId,
      version: result.version,
      state: result.state,
      changed: result.changed,
      triage: triageViewOutput(result.view),
      standing: {
        outcome: result.standing.outcome,
        by: result.standing.by,
        duplicate_of: result.standing.duplicateOf,
      },
    };
  };
}

export const workTriageReviseHandler = createWorkTriageReviseHandler(defaultWorkTriageReviseDeps);
