/**
 * Account-linking hardening for trusted social providers.
 *
 * WHY THIS EXISTS
 * ---------------
 * Better Auth links a social sign-in to an existing user by email when the
 * provider is "trusted" (we trust Google + GitHub because both return a
 * provider-verified email). For that linking to also cover the legitimate
 * "I signed up with a password, never verified, now I log in with Google" flow,
 * auth.ts sets `account.accountLinking.requireLocalEmailVerified = false`.
 *
 * That single flag unblocks linking into UNVERIFIED local accounts — but it also
 * opens a classic PRE-HIJACKING vector (CWE-290 / "account pre-hijacking",
 * Microsoft MSRC 2022):
 *
 *   1. Attacker registers victim@example.com with a password they choose. The
 *      account stays unverified — they don't own the inbox, and prod's
 *      `requireEmailVerification` blocks them from signing in with it.
 *   2. The real victim later signs in with Google for victim@example.com.
 *   3. Better Auth links Google into the attacker's row and — because the
 *      provider's email is verified — flips the user's `emailVerified` to true
 *      (better-auth `oauth2/link-account.mjs`). The attacker's pre-set password
 *      now works, and they own a verified account the victim believes is theirs.
 *
 * MITIGATION (this module)
 * ------------------------
 * When a TRUSTED provider links into a local user whose email is still
 * UNVERIFIED, we revoke (null) any pre-existing "credential" (email/password)
 * password. The provider has just proven ownership of the address; a password
 * attached to a never-verified account is untrusted and must not survive the
 * link. The legitimate owner can set a fresh password via the verified
 * forgot-password flow, which is now reachable because the email is verified.
 *
 * Verified-email accounts are deliberately untouched: a password set on a
 * verified account was set by someone who proved they own the inbox, so linking
 * a social provider to it is safe and the password stays.
 *
 * WHERE IT RUNS
 * -------------
 * As a Better Auth `databaseHooks.account.create.before` step (composed onto the
 * existing token-encryption hook). That hook fires inside
 * `internalAdapter.linkAccount` BEFORE better-auth flips `emailVerified`, so the
 * "is the local account verified?" read observes the pre-link truth.
 *
 * The hardening is best-effort: any failure is logged and swallowed so it can
 * never turn a successful OAuth sign-in into a 500 — the same resilience
 * contract the session hooks in auth.ts use.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { captureError } from "@oxagen/telemetry";
import { logger } from "./logger";

/**
 * Providers whose returned email we treat as proof of ownership. MUST stay in
 * sync with `account.accountLinking.trustedProviders` in auth.ts — a provider
 * that does not verify emails must never appear here, or the pre-hijacking
 * mitigation would run for an unproven identity.
 */
export const TRUSTED_OAUTH_PROVIDERS = ["google", "github"] as const;

/** Better Auth's providerId for an email/password account. */
export const CREDENTIAL_PROVIDER_ID = "credential";

export function isTrustedOAuthProvider(
  providerId: unknown,
  trusted: readonly string[] = TRUSTED_OAUTH_PROVIDERS,
): boolean {
  return typeof providerId === "string" && trusted.includes(providerId);
}

/**
 * Pure policy decision: given the facts about an account-create, should we
 * revoke the local credential password? True only when a trusted provider is
 * being linked into a user whose email is unverified AND who actually has a
 * local password to revoke.
 */
export function shouldRevokeLocalCredentialPassword(facts: {
  providerId: unknown;
  userEmailVerified: boolean;
  hasLocalPassword: boolean;
  trustedProviders?: readonly string[];
}): boolean {
  return (
    isTrustedOAuthProvider(facts.providerId, facts.trustedProviders) &&
    facts.userEmailVerified === false &&
    facts.hasLocalPassword === true
  );
}

/** Facts about the link target, read before the account row is written. */
export interface LinkTargetFacts {
  /** The target user's current emailVerified flag (pre-link). */
  userEmailVerified: boolean;
  /** Whether the user has a credential account carrying a non-null password. */
  hasLocalPassword: boolean;
}

/**
 * Persistence seam — injected so the orchestration is unit-testable without a
 * live database. The default implementation (createDbAccountLinkingStore) runs
 * through withSystemDb because auth.users / auth.accounts are global identity
 * tables resolved before any tenant scope exists.
 */
export interface AccountLinkingStore {
  /** Returns the link-target facts, or null when no such user row exists. */
  loadLinkTargetFacts(userId: string): Promise<LinkTargetFacts | null>;
  /**
   * Nulls the password on the user's credential account(s) that currently hold
   * one. Returns the number of rows actually revoked.
   */
  clearLocalPassword(userId: string): Promise<number>;
}

export interface AccountLinkingLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const defaultLogger: AccountLinkingLogger = {
  warn: (message, context) => logger.warn(context ?? {}, message),
  error: (message, context) => {
    // Structured log for triage, plus captureError escalation so a spike in
    // failed credential-revocation hooks (the pre-hijacking mitigation) is
    // alertable — never re-throws, so a failure can never turn a successful
    // OAuth sign-in into a 500.
    logger.error(context ?? {}, message);
    captureError({
      error: context && "err" in context ? context.err : new Error(message),
      source: "app",
      severity: "warn",
      context: message,
    });
  },
};

/**
 * Live store backed by Postgres via withSystemDb. NEVER reads or logs the
 * password value itself — only its presence and the rows affected.
 */
export function createDbAccountLinkingStore(): AccountLinkingStore {
  return {
    async loadLinkTargetFacts(userId) {
      // tenancy: system bypass — auth.users / auth.accounts are global identity
      // tables, resolved before any tenant scope exists.
      return withSystemDb(async (tx) => {
        const userRow = (
          await tx
            .select({ emailVerified: schema.users.emailVerified })
            .from(schema.users)
            .where(eq(schema.users.id, userId))
            .limit(1)
        )[0];
        if (!userRow) return null;

        const credentials = await tx
          .select({ id: schema.accounts.id })
          .from(schema.accounts)
          .where(
            and(
              eq(schema.accounts.userId, userId),
              eq(schema.accounts.providerId, CREDENTIAL_PROVIDER_ID),
              isNotNull(schema.accounts.password),
            ),
          )
          .limit(1);

        return {
          userEmailVerified: userRow.emailVerified,
          hasLocalPassword: credentials.length > 0,
        };
      });
    },

    async clearLocalPassword(userId) {
      // tenancy: system bypass — see loadLinkTargetFacts. The isNotNull filter
      // means we only revoke (and count) rows that actually carried a password.
      return withSystemDb(async (tx) => {
        const revoked = await tx
          .update(schema.accounts)
          .set({ password: null, updatedAt: new Date() })
          .where(
            and(
              eq(schema.accounts.userId, userId),
              eq(schema.accounts.providerId, CREDENTIAL_PROVIDER_ID),
              isNotNull(schema.accounts.password),
            ),
          )
          .returning({ id: schema.accounts.id });
        return revoked.length;
      });
    },
  };
}

/**
 * Core orchestration: when a trusted provider is being linked into an
 * unverified local account that still holds a password, revoke that password.
 * Returns true when a password was actually revoked.
 *
 * Short-circuits before any DB I/O for the common cases (non-trusted provider
 * create, missing userId), so email/password sign-ups never pay for a query.
 */
export async function hardenTrustedProviderLink(
  account: { userId?: unknown; providerId?: unknown },
  store: AccountLinkingStore,
  log: AccountLinkingLogger = defaultLogger,
): Promise<boolean> {
  const { userId, providerId } = account;

  // Only a trusted-provider link to an existing user can ever trigger a
  // revocation. Everything else (credential sign-up, untrusted provider,
  // brand-new OAuth user with no userId yet) is a no-op with zero DB cost.
  if (
    !isTrustedOAuthProvider(providerId) ||
    typeof userId !== "string" ||
    userId.length === 0
  ) {
    return false;
  }

  const facts = await store.loadLinkTargetFacts(userId);
  // No user row means this is a brand-new OAuth sign-up (user created in the
  // same flow) — there is no pre-existing credential to revoke.
  if (!facts) return false;

  if (
    !shouldRevokeLocalCredentialPassword({
      providerId,
      userEmailVerified: facts.userEmailVerified,
      hasLocalPassword: facts.hasLocalPassword,
    })
  ) {
    return false;
  }

  const revoked = await store.clearLocalPassword(userId);
  if (revoked > 0) {
    // SECURITY-RELEVANT: surfaced for ops/audit visibility. Never logs the
    // password. A dedicated `auth.credential_revoked_on_link` SecurityEventType
    // (compliance taxonomy + DB CHECK migration) is a worthwhile follow-up.
    log.warn(
      "[auth] revoked stale credential password: trusted provider linked into an unverified account",
      { userId, providerId, revoked },
    );
  }
  return revoked > 0;
}

// ---------------------------------------------------------------------------
// databaseHooks.account composition
// ---------------------------------------------------------------------------

/** Shape of a Better Auth account create/update before-hook. */
type AccountBeforeHook = (
  account: Record<string, unknown>,
) => Promise<{ data: Record<string, unknown> }>;

export interface AccountDatabaseHooks {
  create: { before: AccountBeforeHook };
  update: { before: AccountBeforeHook };
}

/**
 * Wrap the existing `databaseHooks.account` so that, after the base
 * create.before transform (token strip/encrypt) runs, we also harden
 * trusted-provider links. The update hook passes through unchanged.
 *
 * The hardening side effect runs AFTER the base transform and never alters the
 * data being written for the account row — it only touches the separate
 * credential row. Its failures are caught and logged so a transient DB error
 * during revocation cannot fail the OAuth sign-in that triggered it.
 */
export function withTrustedLinkHardening(
  base: AccountDatabaseHooks,
  store: AccountLinkingStore = createDbAccountLinkingStore(),
  log: AccountLinkingLogger = defaultLogger,
): AccountDatabaseHooks {
  return {
    update: base.update,
    create: {
      before: async (account) => {
        const result = await base.create.before(account);
        try {
          await hardenTrustedProviderLink(account, store, log);
        } catch (err) {
          // Best-effort — never block sign-in for a hardening failure.
          log.error("[auth] trusted-link password-revocation hook failed", {
            err,
          });
        }
        return result;
      },
    },
  };
}
