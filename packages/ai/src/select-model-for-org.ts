/**
 * Pick the model AND the key for one organisation, in one call (ADR-131).
 *
 * `resolveModelFundingSource` answers two things — who is invoiced, and which
 * key the client is built on — and they have to be applied to the same call or
 * the pair is broken. Fifteen call sites applied only the first:
 *
 *     fundedBy: (await resolveModelFundingSource(ctx.orgId)).fundedBy,
 *     model: selectModel({ tier: "fast" }),
 *
 * which reads as careful and is not. `selectModel` with no credential builds
 * the client on the shared key in the process environment, so an organisation
 * that had brought its own key was reported as having paid — `fundedBy: "org"`
 * charges nothing — while Oxagen's key actually paid the vendor. The funding
 * parameter was made required precisely so nobody would assume the answer, and
 * the assumption moved one line down instead.
 *
 * This helper makes the pair inseparable, and it collapses those two lines
 * into one spread that can go where the `fundedBy:` line was:
 *
 *     ...(await selectModelForOrg(ctx.orgId, { tier: "fast" })),
 *
 * The selector deliberately has no `credential` of its own: the caller does
 * not choose the key, the organisation does.
 *
 * Server-only, and must be called inside a tenant scope — it reads through
 * `resolveModelFundingSource`, which opens a KMS envelope.
 */
import type { LanguageModel } from "ai";
import { resolveModelFundingSource, type TurnFunding } from "./funding-source";
import { selectModel, type ModelSelector } from "./models";

/** Exactly the two fields every metered call path needs, and nothing else. */
export interface OrgModelSelection {
  /** Built on the organisation's key when it has one. */
  readonly model: LanguageModel;
  /** Whether the tokens are charged to the organisation's credits. */
  readonly fundedBy: TurnFunding;
}

/**
 * Resolve the organisation's funding source and build the model on it.
 *
 * Spread the result into a `generateObjectFor` / `streamAgentReply` argument
 * object. Never destructure only `fundedBy` — that is the bug this exists to
 * remove.
 */
export async function selectModelForOrg(
  orgId: string,
  selector: Omit<ModelSelector, "credential"> = {},
): Promise<OrgModelSelection> {
  const funding = await resolveModelFundingSource(orgId);
  return {
    model: selectModel({
      ...selector,
      ...(funding.modelKey ? { credential: funding.modelKey } : {}),
    }),
    fundedBy: funding.fundedBy,
  };
}
