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
import { wrapLanguageModel, type LanguageModel } from "ai";
import { mintedKeyLimitMiddleware } from "./assistant-model-key-limit";
import {
  resolveModelFundingSource,
  type ModelFundingSource,
  type TurnFunding,
} from "./funding-source";
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
 *
 * A model built on a minted key (platform-funded, with a key) is wrapped so
 * the vendor's spend refusal reaches the caller as
 * `AssistantModelKeyLimitError` rather than a bare 402. A key the customer
 * brought is not wrapped: its refusal is the customer's own account to read.
 */
export async function selectModelForOrg(
  orgId: string,
  selector: Omit<ModelSelector, "credential"> = {},
): Promise<OrgModelSelection> {
  return selectModelFromFunding(
    orgId,
    await resolveModelFundingSource(orgId),
    selector,
  );
}

/** Build from an already-resolved snapshot when the governed runtime also needs its credential. */
export function selectModelFromFunding(
  orgId: string,
  funding: ModelFundingSource,
  selector: Omit<ModelSelector, "credential"> = {},
): OrgModelSelection {
  const model = selectModel({
    ...selector,
    ...(funding.modelKey ? { credential: funding.modelKey } : {}),
  });
  const minted = funding.fundedBy === "platform" && funding.modelKey;
  return {
    model:
      minted && typeof model !== "string"
        ? wrapLanguageModel({
            model,
            middleware: mintedKeyLimitMiddleware({
              orgId,
              keyHint: funding.keyHint,
            }),
          })
        : model,
    fundedBy: funding.fundedBy,
  };
}
