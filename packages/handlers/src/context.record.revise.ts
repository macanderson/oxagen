// audit-exempt: an revision publishes nothing (the new wording steers nothing until its PR merges, MC spec §10.3); the kernel capability.invoke_* audit covers the call and merge_context_pr emits steering.published.
//
// revise_context_record (ADR-061; MC spec §10.2, §10.3): change what a record
// in force says, as a pull request.
//
// The record's own page gives a reader one thing to change — the statement —
// and this is where that change goes. It raises a proposal carrying the
// record's kind, force, effect and scope EXACTLY as they stand, with the new
// statement, and hands it to `open_context_pr`, which is already the one path
// that writes `.oxagen/rules/<lineage>.toml`, opens the PR and runs the six
// §10.3 checks. Nothing here touches the registry and nothing here touches
// git: an revision that took a shortcut past the checks would put wording
// into force that `conflict_against_active` never saw, which is the one thing
// the check exists to stop.
//
// The record it revises is read the way the page reads it — the file on the
// production branch first, the registry mirror only when there is no file —
// so an revision carries forward what is actually in force rather than what
// the mirror last remembered.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { contextRecordRevise } from "@oxagen/oxagen/contracts/context.record.revise";
import type {
  ConstraintEffect,
  PublishedSharingScope,
  RecordForce,
  RecordKind,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { readRecordFromRepo } from "./context.record.source";
import { createOpenContextPrHandler } from "./context.pr.open";
import { createProposal } from "./context.proposal.shared";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";

export function createReviseRecordHandler(
  deps: Pick<SteeringDeps, "store" | "github" | "now">,
): CapabilityHandler<typeof contextRecordRevise> {
  const openPr = createOpenContextPrHandler(deps);
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"], workspace: ["Owner", "Member"] },
    );
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };

    const mirrored = await deps.store.findRecord(scope, input.recordId);
    const lineageId =
      mirrored?.record.slug ??
      (input.recordId.startsWith("ctr_") ? null : input.recordId);
    if (!lineageId) throw notFound(input.recordId);
    const fileRead = await readRecordFromRepo(deps.github, scope, lineageId);
    if (!mirrored && !fileRead) throw notFound(input.recordId);

    const kind = (fileRead?.file.kind ??
      (mirrored?.record.kind as RecordKind | null)) as RecordKind | null;
    const force = (fileRead?.file.force ??
      (mirrored?.record.force as RecordForce | null)) as RecordForce | null;
    const sharingScope = (fileRead?.file.sharingScope ??
      (mirrored?.record
        .sharingScope as PublishedSharingScope | null)) as PublishedSharingScope | null;
    if (!kind || !force || !sharingScope) {
      // A record nobody classified cannot be revised into a valid file: the
      // §10.3 schema check would refuse the commit this call is about to make,
      // and refusing here says so with the record's name attached instead of
      // leaving a branch and a failed check behind.
      throw new HandlerError({
        code: "conflict",
        reason: "record_unclassified",
        message: `${lineageId} records no kind, force or scope; it cannot be revised until it is republished with them`,
      });
    }
    // Carried, never re-derived. The effect is the one field of the four the
    // file does not hold, so on a record the mirror has no row for it is null
    // — and a constraint with no effect is refused rather than published as a
    // constraint that constrains nothing.
    const constraintEffect =
      (mirrored?.record.constraintEffect as ConstraintEffect | null) ?? null;
    if (kind === "constraint" && !constraintEffect) {
      throw new HandlerError({
        code: "conflict",
        reason: "constraint_effect_unknown",
        message: `${lineageId} is a constraint whose require/forbid effect this workspace does not hold; revise it through propose_record, which states the effect`,
      });
    }

    const row = await createProposal(deps.store, ctx, {
      lineageId,
      kind,
      force,
      constraintEffect,
      sharingScope,
      statement: input.statement,
      rationale:
        input.rationale ?? `Revises the statement of ${lineageId} in place.`,
      source: undefined,
      support: { runs: [], agents: [], recordIds: [], evidenceLinks: [] },
    });
    return openPr({ proposalId: row.publicId }, ctx);
  };
}

function notFound(id: string): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: "record_not_found",
    message: `No record ${id} in this workspace`,
  });
}

export const reviseRecordHandler = createReviseRecordHandler(steeringDeps());
