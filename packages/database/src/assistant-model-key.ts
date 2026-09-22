/**
 * The assistant-model-key resolver (ADR-131) — the one place the
 * `org.assistant_model_keys` envelope is opened, and the one place a row is
 * written.
 *
 * This is the key OXAGEN minted for one organisation on its own OpenRouter
 * account. Its neighbour, `model-credential-resolver.ts`, is the key a
 * CUSTOMER brought. The two look alike and mean opposite things about money,
 * so the difference is stated once, here, and threaded through the types:
 *
 *   model_credentials   the customer pays the vendor. Oxagen bills no tokens.
 *   assistant_model_keys  Oxagen pays the vendor, on a token minted for this
 *                       organisation alone. Metering and billing are exactly
 *                       what they were on the single shared key.
 *
 * Nothing about funding is decided in this file. `resolveModelFundingSource`
 * still answers `platform` for an organisation whose only key is one of these,
 * and the credit gate still charges the turn. What changes is which token the
 * provider client is built on — which is what makes the vendor's own
 * per-key usage figure a per-customer figure.
 *
 * WHY THE WRITE PATH IS HERE TOO, unlike the credential resolver whose writer
 * is a handler: a row is written on organisation creation, from outside any
 * tenant scope (the new organisation does not exist when the caller's scope
 * was opened), so the insert goes through `withSystemDb`. Putting the
 * bypassing write next to the RLS-scoped read means both halves of the
 * table's access rules are readable in one file rather than one being a
 * surprise found later.
 *
 * SECRET HANDLING: the decrypted key leaves this module only inside an
 * `AssistantModelKey.apiKey` handed to the provider factory in `@oxagen/ai`.
 * It is never logged, never serialised into an error, and no read capability
 * returns it.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { decrypt, encrypt } from "@oxagen/crypto";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import type { KmsAdapter } from "@oxagen/crypto";
import { schema } from "./index";
import { withSystemDb, withTenantDb } from "./tenant";
import { logger } from "./logger";
import { isUniqueViolation } from "./errors";

/**
 * Per-row key-version label for this envelope. Its own value rather than a
 * reuse of MODEL_CREDENTIAL_KEY_ID: the two tables can be re-keyed on
 * different days, and a shared label would force them to move together.
 */
export const ASSISTANT_MODEL_KEY_KEY_ID = "assistant_model_key_v1";

/** A live, decrypted key Oxagen minted for one organisation. */
export interface AssistantModelKey {
  readonly orgId: string;
  /** Always `openrouter` today; the column's CHECK admits nothing else. */
  readonly provider: "openrouter";
  /** The plaintext key. Never log, never serialise. */
  readonly apiKey: string;
  /** SHA-256 of the key — the provider-client cache key. */
  readonly digest: string;
  /** Last four characters, for a log line or an operator's row. */
  readonly keyHint: string;
  /** The vendor's durable handle. The join key for a usage export. */
  readonly keyHash: string;
  /** The display name fixed at creation. */
  readonly keyName: string;
  /** The ceiling OpenRouter refills at midnight UTC, in USD. */
  readonly dailyLimitUsd: number;
}

/**
 * How long a resolved key is trusted without re-reading Postgres. Same five
 * seconds as the credential resolver, for the same two reasons: this sits in
 * front of every assistant completion, and a key switched off must stop
 * spending within seconds.
 */
export const ASSISTANT_MODEL_KEY_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  /** null caches "this organisation has no minted key" too, so an
   * organisation still on the shared key does not pay a read per turn. */
  readonly key: AssistantModelKey | null;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop the cached answer for one organisation. Called by every writer here. */
export function invalidateAssistantModelKeyCache(orgId: string): void {
  cache.delete(orgId);
}

/** Test seam: drop every cached answer. */
export function resetAssistantModelKeyCacheForTests(): void {
  cache.clear();
}

/** The KMS adapter for this envelope, or null when the KEK is unset. */
export function resolveAssistantModelKeyKms(): {
  readonly adapter: KmsAdapter;
  readonly keyId: string;
} | null {
  const key = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  return {
    adapter: createLocalKmsAdapter(loadMasterKey(key)),
    keyId: ASSISTANT_MODEL_KEY_KEY_ID,
  };
}

/** SHA-256 of the key: the provider-client cache key, not the key. */
export function assistantKeyDigest(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** The last four characters — what a vendor dashboard shows. Not a secret. */
export function assistantKeyHint(apiKey: string): string {
  return apiKey.slice(-4);
}

/**
 * The organisation's minted key, or null when it has none — which is the
 * answer that routes the turn to the shared platform key.
 *
 * Every failure resolves to null and logs why: an unset KEK, an envelope that
 * cannot be opened, a row marked disabled. Falling back to the shared key is
 * the safe direction in all three, because the alternative is an assistant
 * that stops answering for a customer over a key-management problem they
 * cannot see and did not cause. The cost of the fallback is attribution, not
 * money: the tokens are Oxagen's either way, and the meter charges the same
 * turn the same amount. That trade is the whole reason this read never
 * throws.
 *
 * MUST be called inside a tenant scope: the read goes through withTenantDb so
 * RLS stays load-bearing.
 */
export async function loadAssistantModelKey(
  orgId: string,
): Promise<AssistantModelKey | null> {
  const now = Date.now();
  const hit = cache.get(orgId);
  if (hit && hit.expiresAt > now) return hit.key;

  const row = await withTenantDb((tx) =>
    tx.query.assistantModelKeys.findFirst({
      where: eq(schema.assistantModelKeys.orgId, orgId),
    }),
  );

  let key: AssistantModelKey | null = null;
  if (row && row.status === "active") {
    const kms = resolveAssistantModelKeyKms();
    if (!kms) {
      logger.warn(
        { orgId, alert: "assistant_model_key_kek_unset" },
        "assistant-model-key: a key is stored but AUTH_TOKEN_ENCRYPTION_KEY is unset — using the shared platform key",
      );
    } else {
      try {
        const plaintext = await decrypt(row.keyCiphertext, row.keyKeyId, {
          adapter: kms.adapter,
        });
        key = {
          orgId,
          provider: "openrouter",
          apiKey: plaintext.toString("utf8"),
          digest: row.keyDigest,
          keyHint: row.keyHint,
          keyHash: row.keyHash,
          keyName: row.keyName,
          // numeric(10,2) arrives as a string from node-postgres, which is
          // correct for money and wrong for the one consumer that compares it
          // to what the vendor reports. Parsed once, here.
          dailyLimitUsd: Number(row.dailyLimitUsd),
        };
      } catch (err) {
        logger.error(
          {
            orgId,
            keyKeyId: row.keyKeyId,
            alert: "assistant_model_key_envelope_unreadable",
            err: err instanceof Error ? err.message : String(err),
          },
          "assistant-model-key: stored envelope could not be opened — using the shared platform key",
        );
      }
    }
  }

  cache.set(orgId, { key, expiresAt: now + ASSISTANT_MODEL_KEY_CACHE_TTL_MS });
  return key;
}

/** What `recordAssistantModelKey` needs to write one row. */
export interface RecordAssistantModelKeyArgs {
  readonly orgId: string;
  /** The plaintext, straight from the vendor. Enveloped here and dropped. */
  readonly apiKey: string;
  readonly keyHash: string;
  readonly keyName: string;
  readonly dailyLimitUsd: number;
  /** The person whose creation of the organisation caused the mint. */
  readonly actorUserId?: string | null;
}

/** The row is already there — the caller minted a key it must now destroy. */
export class AssistantModelKeyExistsError extends Error {
  constructor(readonly orgId: string) {
    super(`organisation ${orgId} already has an assistant model key`);
    this.name = "AssistantModelKeyExistsError";
  }
}

/** The KEK is unset, so nothing can be stored encrypted. Same unwind. */
export class AssistantModelKeyKekUnsetError extends Error {
  constructor() {
    super(
      "AUTH_TOKEN_ENCRYPTION_KEY is unset, so an assistant model key cannot be stored encrypted",
    );
    this.name = "AssistantModelKeyKekUnsetError";
  }
}

/**
 * Write the row for a key that already exists at the vendor.
 *
 * Runs on `withSystemDb`: the caller is provisioning for an organisation that
 * was created moments ago and whose tenant scope the caller is not inside.
 * The row's `org_id` is supplied by the caller rather than read from a scope,
 * which is exactly why this function is not exported from the package barrel
 * — it is reachable from the provisioner and the backfill script and nowhere
 * a request can reach.
 *
 * Throws rather than returning on both failure modes, because both leave a
 * key at the vendor that nothing can use and that must be deleted by the
 * caller in its catch. Silently returning would strand a spendable key.
 */
export async function recordAssistantModelKey(
  args: RecordAssistantModelKeyArgs,
): Promise<void> {
  const kms = resolveAssistantModelKeyKms();
  if (!kms) throw new AssistantModelKeyKekUnsetError();

  const ciphertext = await encrypt(args.apiKey, kms.keyId, {
    adapter: kms.adapter,
  });

  // tenancy: system bypass via withSystemDb (bootstrap — the organisation was
  // created by the transaction that triggered this and no tenant scope for it
  // is open) (see docs/specs/tenancy-rls/spec.md)
  try {
    await withSystemDb((tx) =>
      tx.insert(schema.assistantModelKeys).values({
        orgId: args.orgId,
        provider: "openrouter",
        keyHash: args.keyHash,
        keyName: args.keyName,
        keyCiphertext: ciphertext,
        keyKeyId: kms.keyId,
        keyDigest: assistantKeyDigest(args.apiKey),
        keyHint: assistantKeyHint(args.apiKey),
        dailyLimitUsd: args.dailyLimitUsd.toFixed(2),
        status: "active",
        createdById: args.actorUserId ?? null,
        updatedById: args.actorUserId ?? null,
      }),
    );
  } catch (err) {
    // The unique index on org_id is the provisioner's idempotence, so losing
    // this race is an ordinary outcome, not a fault. The caller answers it by
    // deleting the key it minted; the row that won keeps the organisation.
    if (isUniqueViolation(err, "assistant_model_keys_org_unique")) {
      throw new AssistantModelKeyExistsError(args.orgId);
    }
    throw err;
  }
  invalidateAssistantModelKeyCache(args.orgId);
}

/**
 * Take key material out of a message before it is stored or logged.
 *
 * The one shape an OpenRouter key has today, `sk-or-v1-<hex>`, is replaced
 * wherever it appears. The same rule guards `OpenRouterProvisioningError` in
 * `@oxagen/ai`; it is restated here because `@oxagen/ai` depends on this
 * package, not the other way round. Both a vendor error and a caller's reason
 * can quote the request that failed, and the request carried the key.
 */
export function scrubAssistantKeyMaterial(text: string): string {
  return text.replace(/sk-or-v1-[A-Za-z0-9]+/g, "sk-or-v1-[redacted]");
}

/**
 * Record that a provisioning attempt failed, without a key to show for it.
 *
 * Deliberately NOT a row: a row in this table means "a key exists at the
 * vendor", and the NOT NULL envelope says so. A failure is a log line with an
 * alert on it, which is what an operator greps and what an alert rule fires
 * on. The organisation keeps serving on the shared key in the meantime, so a
 * failed provision is a reconciliation gap, never an outage.
 */
export function logAssistantModelKeyFailure(
  orgId: string,
  err: unknown,
  phase: "mint" | "store",
): void {
  logger.error(
    {
      orgId,
      phase,
      alert: "assistant_model_key_provision_failed",
      err: scrubAssistantKeyMaterial(
        err instanceof Error ? err.message : String(err),
      ),
    },
    "assistant-model-key: provisioning failed — the organisation stays on the shared platform key",
  );
}

/**
 * Switch an organisation's key off in Oxagen's record.
 *
 * Pairs with `updateAssistantKey({disabled: true})` at the vendor, and the
 * caller does both. This half alone stops Oxagen building a client on the
 * key; the vendor half alone stops anything else that holds the plaintext.
 * Neither is sufficient, which is why the caller is a single function
 * (`disableAssistantModelKey` in `@oxagen/handlers`) rather than two callers.
 *
 * The key is never DELETED here. A deleted key takes its usage history with
 * it, and the invoice for the month it was deleted in stops reconciling.
 */
export async function markAssistantModelKeyDisabled(
  orgId: string,
  reason?: string,
): Promise<void> {
  // tenancy: system bypass via withSystemDb; the update is filtered by orgId,
  // and the caller is an operator or an offboarding job, not a request inside
  // the organisation's scope (see docs/specs/tenancy-rls/spec.md)
  await withSystemDb((tx) =>
    tx
      .update(schema.assistantModelKeys)
      .set({
        status: "disabled",
        disabledAt: new Date(),
        updatedAt: new Date(),
        // The column comment promises a reason scrubbed of key material,
        // and the writer is the one place that promise can be kept.
        ...(reason
          ? { lastError: scrubAssistantKeyMaterial(reason).slice(0, 500) }
          : {}),
      })
      .where(eq(schema.assistantModelKeys.orgId, orgId)),
  );
  invalidateAssistantModelKeyCache(orgId);
}

/**
 * Every organisation's key handle and name, for reconciliation.
 *
 * The plaintext and the envelope are deliberately absent: the one caller is
 * the report that joins OpenRouter's per-key usage to Oxagen's customers, and
 * it has no business decrypting anything. Runs on `withSystemDb` because the
 * report is across tenants by definition.
 */
export async function listAssistantModelKeyHandles(): Promise<
  {
    orgId: string;
    keyHash: string;
    keyName: string;
    status: string;
    dailyLimitUsd: number;
  }[]
> {
  // tenancy: system bypass via withSystemDb (cross-tenant reconciliation
  // report; no single organisation's scope applies) (see
  // docs/specs/tenancy-rls/spec.md)
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        orgId: schema.assistantModelKeys.orgId,
        keyHash: schema.assistantModelKeys.keyHash,
        keyName: schema.assistantModelKeys.keyName,
        status: schema.assistantModelKeys.status,
        dailyLimitUsd: schema.assistantModelKeys.dailyLimitUsd,
      })
      .from(schema.assistantModelKeys),
  );
  return rows.map((r) => ({ ...r, dailyLimitUsd: Number(r.dailyLimitUsd) }));
}

/**
 * Does this organisation already have a row?
 *
 * The provisioner's cheap pre-check, so the common "already provisioned" case
 * costs one indexed read and no vendor call. It is NOT the idempotence — the
 * unique index is, because two callers can both read "no row" before either
 * inserts. Reads through `withSystemDb` for the same reason the insert does.
 */
export async function hasAssistantModelKey(orgId: string): Promise<boolean> {
  // tenancy: system bypass via withSystemDb (bootstrap — called before any
  // scope for the new organisation exists) (see docs/specs/tenancy-rls/spec.md)
  const row = await withSystemDb((tx) =>
    tx.query.assistantModelKeys.findFirst({
      where: eq(schema.assistantModelKeys.orgId, orgId),
      columns: { id: true },
    }),
  );
  return row !== undefined;
}
