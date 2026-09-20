/**
 * Give one organisation its own OpenRouter key, once (ADR-131).
 *
 * The three parts this joins are deliberately apart: the vendor calls have no
 * database (`openrouter-provisioning.ts`), the row has no vendor
 * (`@oxagen/database/assistant-model-key`), and the name is a pure function
 * (`assistant-key-name.ts`). This is the only place they meet, and the only
 * place the ordering between them is decided.
 *
 * THE ORDERING, and why it is the way round it is:
 *
 *   1. read the row. The common case is "already provisioned", and it must
 *      cost one indexed read and no vendor call.
 *   2. mint at the vendor.
 *   3. write the row.
 *
 * Minting before writing means a crash between 2 and 3 leaves a key at the
 * vendor that nothing references — visible in the account, spending nothing,
 * cleaned up by the reconciliation report. Writing before minting would mean a
 * crash leaves a row claiming a key that does not exist, and every turn for
 * that organisation would then fail on a key the customer cannot see. An
 * orphan costs an operator a minute; a phantom costs a customer their
 * assistant.
 *
 * NEVER INSIDE THE TRANSACTION THAT CREATES THE ORGANISATION. This makes an
 * HTTPS call to a third party; holding a Postgres transaction open across it
 * makes every organisation's creation as slow and as fragile as OpenRouter's
 * worst minute, and a rollback afterwards would strand a live spendable key
 * with no row to find it by. Call it after the commit, fire-and-forget.
 *
 * FAILURE IS NOT AN ERROR HERE. Every failure resolves to
 * `{ provisioned: false }` and logs why. An organisation with no minted key
 * serves on the shared key, which is exactly what every organisation did
 * before ADR-131 — so a bad minute at OpenRouter costs reconciliation
 * granularity for those organisations and nothing else. Making signup fail
 * because a vendor's key API was down would be a far worse trade.
 */
import {
  createAssistantKey,
  deleteAssistantKey,
  OpenRouterProvisioningError,
} from "./openrouter-provisioning";
import { assistantKeyName } from "./assistant-key-name";
import {
  AssistantModelKeyExistsError,
  hasAssistantModelKey,
  recordAssistantModelKey,
  logAssistantModelKeyFailure,
} from "@oxagen/database/assistant-model-key";

/** What the caller needs to name the key. Both are point-in-time facts. */
export interface EnsureAssistantModelKeyArgs {
  readonly orgId: string;
  /** The organisation's slug at creation. Baked into the name, never updated. */
  readonly orgSlug: string;
  /** The email of the person who created the organisation. */
  readonly creatorEmail: string;
  /** Who to attribute the row to. Optional: a backfill has no actor. */
  readonly actorUserId?: string | null;
}

export interface EnsureAssistantModelKeyResult {
  /** True only when THIS call minted and stored a key. */
  readonly provisioned: boolean;
  /**
   * Why not, when `provisioned` is false. `already` and `race` are ordinary
   * outcomes; `disabled` means the feature is off in this environment; `error`
   * is the only one worth an alert.
   */
  readonly reason?: "already" | "race" | "disabled" | "error";
}

/** The provisioning key, or null where the feature is not configured. */
function managementKey(): string | null {
  const key = process.env.OPENROUTER_MANAGEMENT_KEY;
  return key && key.length > 0 ? key : null;
}

/** The ceiling for a newly minted key, in USD per day. */
function dailyLimitUsd(): number {
  const raw = Number(process.env.OPENROUTER_ORG_KEY_DAILY_LIMIT_USD);
  // A non-numeric or non-positive setting is a misconfiguration, and the
  // column's CHECK would refuse it anyway. Falling back to the schema default
  // keeps provisioning working while the setting is fixed, which is the right
  // direction for a blast-radius ceiling: a key that exists with a sane cap
  // beats no key at all.
  return Number.isFinite(raw) && raw > 0 ? raw : 25;
}

/**
 * Mint and store the organisation's key if it does not have one.
 *
 * Safe to call repeatedly and safe to call concurrently. The `org_id` unique
 * index is the real idempotence — the read in step 1 is only an optimisation,
 * because two callers can both see "no row" before either inserts. The loser
 * of that race deletes the key it just minted rather than leaving it to spend
 * unreferenced; that is the one place this module deletes a key at all.
 */
export async function ensureAssistantModelKey(
  args: EnsureAssistantModelKeyArgs,
): Promise<EnsureAssistantModelKeyResult> {
  const management = managementKey();
  if (!management) return { provisioned: false, reason: "disabled" };

  if (await hasAssistantModelKey(args.orgId)) {
    return { provisioned: false, reason: "already" };
  }

  const limitUsd = dailyLimitUsd();
  const name = assistantKeyName({
    orgSlug: args.orgSlug,
    creatorEmail: args.creatorEmail,
  });

  let minted;
  try {
    minted = await createAssistantKey({
      name,
      limitUsd,
      limitReset: "daily",
      managementKey: management,
    });
  } catch (err) {
    logAssistantModelKeyFailure(args.orgId, err, "mint");
    return { provisioned: false, reason: "error" };
  }

  try {
    await recordAssistantModelKey({
      orgId: args.orgId,
      apiKey: minted.apiKey,
      keyHash: minted.key.hash,
      keyName: name,
      dailyLimitUsd: limitUsd,
      actorUserId: args.actorUserId ?? null,
    });
  } catch (err) {
    // Whatever went wrong, the key at the vendor is now unreachable — no row
    // records its hash, so nothing can disable it later or attribute its
    // spend. Unwinding it is the only honest response, and it is the reason
    // `recordAssistantModelKey` throws rather than returning a flag.
    await unwind(minted.key.hash, management, args.orgId);
    if (err instanceof AssistantModelKeyExistsError) {
      return { provisioned: false, reason: "race" };
    }
    logAssistantModelKeyFailure(args.orgId, err, "store");
    return { provisioned: false, reason: "error" };
  }

  return { provisioned: true };
}

/**
 * Destroy a key that was minted and could not be stored.
 *
 * The one deletion in the system, and it is narrow on purpose: this key has
 * no usage history to preserve because it has never served a turn. Every
 * other way a key leaves service is a DISABLE, so the vendor keeps reporting
 * what it spent and an invoice from six months ago still reconciles.
 *
 * A failed unwind is logged and swallowed. The caller has already failed to
 * provision; throwing here would replace "this organisation has no minted
 * key" — recoverable, and the shared key still serves it — with an exception
 * on the signup path. The orphan is visible in the reconciliation report as a
 * vendor key with no organisation, which is what that report is for.
 */
async function unwind(
  hash: string,
  management: string,
  orgId: string,
): Promise<void> {
  try {
    await deleteAssistantKey({ hash, managementKey: management });
  } catch (err) {
    logAssistantModelKeyFailure(
      orgId,
      err instanceof OpenRouterProvisioningError
        ? err
        : new Error(`unwind failed: ${String(err)}`),
      "mint",
    );
  }
}
