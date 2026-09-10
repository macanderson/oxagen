/**
 * The organisation model-credential resolver (ADR-053 §2).
 *
 * The one place the `org.model_credentials` envelope is opened. `@oxagen/ai`
 * asks it "whose key pays for this organisation's completions?" before every
 * turn; the settings handlers write the row and invalidate here; nothing else
 * touches the ciphertext.
 *
 * Same shape as the data-plane resolver beside it, with two deliberate
 * differences. It reads through withTenantDb, because nothing resolves THROUGH
 * this table — RLS is the filter, and the caller is already inside the
 * organisation's scope. And it caches by digest rather than by row, so a
 * rotated key misses the cache on the next read and the provider client built
 * on the old key is dropped rather than retried.
 *
 * SECRET HANDLING: the decrypted key never leaves this module except inside a
 * `ModelCredential` handed to the provider factory in `@oxagen/ai`. It is never
 * logged, never serialised into an error, and never returned by a read
 * capability (`get_model_credential` returns the hint column and nothing from
 * the envelope).
 */
import { and, eq, isNull } from "drizzle-orm";
import { decrypt } from "@oxagen/crypto";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import type { KmsAdapter } from "@oxagen/crypto";
import { schema } from "./index";
import { withTenantDb } from "./tenant";
import { logger } from "./logger";

/**
 * Stable per-row key-version label for the model-credential envelope. Mirrors
 * DATA_PLANE_KEY_ID — bump on a KEK rotation so the read path can route the
 * decrypt by the stored key id.
 */
export const MODEL_CREDENTIAL_KEY_ID = "model_credential_v1";

export interface ResolvedModelCredentialKms {
  readonly adapter: KmsAdapter;
  readonly keyId: string;
}

/**
 * Resolve the KMS adapter used to envelope model credentials. Sources its
 * master key from AUTH_TOKEN_ENCRYPTION_KEY (base64 256-bit), the same key the
 * data-plane and plugin-credential envelopes use. Returns null when unset
 * (local dev without secrets) — a writer must then refuse to STORE a key
 * rather than write plaintext, and a reader reports "no credential" so the
 * platform key is used. NEVER log key material.
 */
export function resolveModelCredentialKms(): ResolvedModelCredentialKms | null {
  const key = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  return {
    adapter: createLocalKmsAdapter(loadMasterKey(key)),
    keyId: MODEL_CREDENTIAL_KEY_ID,
  };
}

/** The vendors `org.model_credentials.provider` admits (its CHECK). */
export type ModelCredentialProvider = "openrouter" | "gateway";

/** A live, decrypted credential. Handed to the provider factory and nowhere else. */
export interface ModelCredential {
  readonly orgId: string;
  readonly provider: ModelCredentialProvider;
  /** The plaintext key. Never log, never serialise. */
  readonly apiKey: string;
  /** SHA-256 of the key — the provider-client cache key. */
  readonly digest: string;
  /** Last four characters of the key, for a log line or a UI row. */
  readonly keyHint: string;
}

/**
 * How long a resolved credential is trusted without re-reading Postgres.
 *
 * Short on purpose: this sits in front of every assistant completion, so it
 * has to be cheap, but a deleted key must stop paying within seconds, and an
 * explicit write invalidates immediately.
 */
export const MODEL_CREDENTIAL_CACHE_TTL_MS = 5_000;

interface CacheEntry {
  /** null caches the "no live credential" answer too, so a platform-funded
   * organisation does not pay a Postgres read per turn. */
  readonly credential: ModelCredential | null;
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop the cached answer for one organisation. Called by every writer. */
export function invalidateModelCredentialCache(orgId: string): void {
  cache.delete(orgId);
}

/** Test seam: drop every cached answer. */
export function resetModelCredentialCacheForTests(): void {
  cache.clear();
}

/**
 * The organisation's live credential, or null when it has none — which is the
 * answer that routes the turn to the platform key.
 *
 * A stored row whose envelope cannot be opened (KEK unset, or a key id the
 * adapter does not know) resolves to null and logs why. Falling back to the
 * platform key is the safe direction here: the alternative is a turn that
 * fails on a customer's own key, which reads to them as their key being
 * broken. A `disabled` row resolves to null as well — that is what disabled
 * means.
 *
 * MUST be called inside a tenant scope: the read goes through withTenantDb so
 * RLS stays load-bearing.
 */
export async function loadModelCredential(
  orgId: string,
): Promise<ModelCredential | null> {
  const now = Date.now();
  const hit = cache.get(orgId);
  if (hit && hit.expiresAt > now) return hit.credential;

  const row = await withTenantDb((tx) =>
    tx.query.modelCredentials.findFirst({
      where: and(
        eq(schema.modelCredentials.orgId, orgId),
        isNull(schema.modelCredentials.deletedAt),
      ),
    }),
  );

  let credential: ModelCredential | null = null;
  if (row && row.status === "active") {
    const kms = resolveModelCredentialKms();
    if (!kms) {
      logger.warn(
        { orgId, alert: "model_credential_kek_unset" },
        "model-credential: a key is stored but AUTH_TOKEN_ENCRYPTION_KEY is unset — using the platform key",
      );
    } else {
      try {
        const plaintext = await decrypt(row.keyCiphertext, row.keyKeyId, {
          adapter: kms.adapter,
        });
        credential = {
          orgId,
          provider: row.provider as ModelCredentialProvider,
          apiKey: plaintext.toString("utf8"),
          digest: row.keyDigest,
          keyHint: row.keyHint,
        };
      } catch (err) {
        // Never the ciphertext, never the error's own payload: the envelope
        // library's messages are shape-only, but the rule is the same as for
        // every other secret in this package.
        logger.error(
          {
            orgId,
            keyKeyId: row.keyKeyId,
            alert: "model_credential_envelope_unreadable",
            err: err instanceof Error ? err.message : String(err),
          },
          "model-credential: stored envelope could not be opened — using the platform key",
        );
      }
    }
  }

  cache.set(orgId, {
    credential,
    expiresAt: now + MODEL_CREDENTIAL_CACHE_TTL_MS,
  });
  return credential;
}
