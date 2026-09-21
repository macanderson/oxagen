// audit-exempt: read-only — lists the models the price book cannot price; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `list_unpriced_models` (ADR-060 §1): the diff between the models the
// organization has actually run and the prices anyone has stated for them.
//
// The role gate runs in the handler rather than resting on the contract's
// `defaultRoles`, because the kernel's IAM check allows every capability for a
// non-enterprise organization (INV-29, apps/app/ARCHITECTURE.md §3.2). Model
// names, call counts and token totals are the same class of commercial detail
// `set_price_entry` and `remove_price_entry` already gate on this branch; a
// Compliance or Viewer member could otherwise read them on any free, build or
// scale organization despite the contract naming only Owner, Admin, Billing
// and Member.
import {
  ORG_ONLY_WORKSPACE_ID,
  HandlerError,
  type CapabilityHandler,
} from "@oxagen/oxagen";
import {
  costUnpricedModelList,
  UNPRICED_MODEL_WINDOW_DAYS,
  type CostUnpricedModelListOutput,
} from "@oxagen/oxagen/contracts/cost.unpriced_model.list";
import { readUnpricedModels, type UnpricedModel } from "@oxagen/billing";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";

const DAY_MS = 24 * 60 * 60 * 1000;

export type UnpricedModelListDeps = {
  readUnpricedModels: (args: {
    orgId: string;
    workspaceId?: string;
    since: Date;
    at: Date;
  }) => Promise<UnpricedModel[]>;
  now: () => Date;
};

export function createUnpricedModelListHandler(
  deps: UnpricedModelListDeps,
): CapabilityHandler<typeof costUnpricedModelList> {
  return async (input, ctx): Promise<CostUnpricedModelListOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin", "Billing", "Member"] },
    );

    const at = input.at === undefined ? deps.now() : new Date(input.at);
    const since =
      input.since === undefined
        ? new Date(at.getTime() - UNPRICED_MODEL_WINDOW_DAYS * DAY_MS)
        : new Date(input.since);
    if (since > at)
      throw new HandlerError({
        code: "conflict",
        reason: "unpriced_model_window_reversed",
        message:
          "The observation start is after its end. Choose since at or before at.",
      });
    // An org-only mount carries the nil workspace sentinel (ADR-068), which
    // is a real workspace_id in the frame stores: filtering on it would answer
    // "no unpriced models" for every organization whose frames name a real
    // workspace. No workspace means the whole organization.
    const workspaceId =
      ctx.workspaceId === ORG_ONLY_WORKSPACE_ID ? undefined : ctx.workspaceId;
    const models = await deps.readUnpricedModels({
      orgId: ctx.orgId,
      workspaceId,
      since,
      at,
    });
    return {
      since: since.toISOString(),
      at: at.toISOString(),
      models: models.map((m) => ({
        model: m.model,
        provider: m.provider,
        calls: m.calls,
        tokens: m.tokens,
        firstSeen: m.firstSeen.toISOString(),
        lastSeen: m.lastSeen.toISOString(),
        missingClasses: [...m.missingClasses],
        missingClassWindows: m.missingClassWindows.map((w) => ({
          tokenClass: w.tokenClass,
          unpricedFrom: w.unpricedFrom.toISOString(),
          unpricedTo: w.unpricedTo.toISOString(),
        })),
        fullyUnpriced: m.fullyUnpriced,
      })),
    };
  };
}

export const unpricedModelListHandler = createUnpricedModelListHandler({
  readUnpricedModels,
  now: () => new Date(),
});
