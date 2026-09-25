/**
 * The decisions `tools/scripts/assistant-model-keys.ts` makes, as pure
 * functions over owned data (ADR-131).
 *
 * They live here rather than in the script because the script opens a database
 * connection and calls `process.exit` at import time, so nothing in it can be
 * imported by a test. Each function below answers one question the script used
 * to answer inline, and each one got it wrong in a way that was invisible from
 * the output: a mistyped cap that removed the cap, a vendor outage that
 * reported as a clean run, a deleted key reported as a live one, and a ceiling
 * that changed its reset window without changing its dollar figure.
 *
 * `orgsWithoutKeyQuery` is the one builder here. It takes the transaction as
 * an argument and returns the unexecuted query, so a test can render its SQL
 * through `drizzle.mock` and read the predicates without a database.
 */

import { and, isNull, ne, sql } from "drizzle-orm";
import { schema, type Tx } from "@oxagen/database";

/** What the query builder needs from a transaction: the select builder. */
type QueryDb = Pick<Tx, "select">;

/**
 * Every organisation with no `assistant_model_keys` row, joined to the email
 * of each member whose role is owner.
 *
 * Two predicates here shipped wrong on #3598, and each one failed silently:
 * the run printed a shorter list and nothing said which organisation was left
 * out or why it was there.
 *
 * The owner rather than the creator: `org_users` records the role, and the
 * creator's identity is not kept separately once the row is written. For an
 * organisation created by the signup flow the two are the same person.
 */
export function orgsWithoutKeyQuery(tx: QueryDb) {
  return tx
    .select({
      id: schema.organizations.id,
      slug: schema.organizations.slug,
      email: schema.users.email,
    })
    .from(schema.organizations)
    .leftJoin(
      schema.assistantModelKeys,
      sql`${schema.assistantModelKeys.orgId} = ${schema.organizations.id}`,
    )
    .innerJoin(
      schema.orgUsers,
      // lower(role), because org_users records the role in both casings and
      // its own CHECK is written `lower(role) IN (...)`. Matching 'owner'
      // exactly skips an organisation whose owner row reads 'Owner', and
      // skips it with no output at all.
      sql`${schema.orgUsers.orgId} = ${schema.organizations.id} and lower(${schema.orgUsers.role}) = 'owner'`,
    )
    .innerJoin(
      schema.users,
      sql`${schema.users.id} = ${schema.orgUsers.userId}`,
    )
    .where(
      and(
        isNull(schema.assistantModelKeys.orgId),
        // A deleted organisation is a retained row, not an absent one.
        // Minting for it would put a live, spendable credential behind an
        // organisation the rest of the product treats as gone.
        ne(schema.organizations.status, "deleted"),
      ),
    );
}

/**
 * Keep the first row for each organisation.
 *
 * An organisation with two owner rows comes back twice from the join, and
 * would otherwise be minted for twice. The second attempt loses the unique
 * index and deletes its own key, which is correct but wasteful and reads like
 * a fault in the output.
 */
export function firstRowPerOrg<T extends { readonly id: string }>(
  rows: readonly T[],
): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.id) && seen.add(r.id));
}

/** A cap that was read, or the reason it could not be. */
export type LimitFlag =
  | { readonly ok: true; readonly limit: number }
  | { readonly ok: false; readonly got: string | undefined };

/**
 * Read `--limit N` out of the argument list.
 *
 * Absent is the only form of "no cap", and it is written by leaving the flag
 * off. Every other unreadable form fails, because this flag bounds a run that
 * mints spendable vendor credentials: a `--limit nope` that falls back to no
 * limit turns a typo into a mint for every eligible organisation.
 */
export function parseLimitFlag(argv: readonly string[]): LimitFlag {
  const at = argv.indexOf("--limit");
  if (at === -1) return { ok: true, limit: Number.POSITIVE_INFINITY };

  const raw = argv[at + 1];
  if (raw === undefined || raw.startsWith("--") || raw.trim() === "") {
    return { ok: false, got: raw };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, got: raw };
  return { ok: true, limit: n };
}

/** What one organisation's provisioning attempt was. */
export type BackfillOutcome = "minted" | "skipped" | "failed";

/**
 * Judge one `ensureAssistantModelKey` result.
 *
 * `already` and `race` are the only normal non-mints: both mean the
 * organisation ends the run with a key. `error` is every vendor and storage
 * failure the provisioner swallows, and `disabled` means the run had no
 * management key at all, so neither one leaves a key behind and neither is a
 * skip. Counting them as skips let an OpenRouter outage mint nothing, print
 * `failed 0`, and exit 0.
 */
export function classifyBackfillOutcome(result: {
  readonly provisioned: boolean;
  readonly reason?: string;
}): BackfillOutcome {
  if (result.provisioned) return "minted";
  if (result.reason === "already" || result.reason === "race") return "skipped";
  return "failed";
}

/** The fields of a vendor key this module needs to judge it. */
export interface VendorKeyFacts {
  readonly hash: string;
  readonly disabled: boolean;
  readonly limit: number | null;
  readonly limitReset: string | null;
}

/**
 * Is this row disabled here while its key still spends at the vendor?
 *
 * The vendor key must be found AND live. Reading a missing key as a live one
 * is what reported a row that is disabled here and deleted at the vendor both
 * as a phantom and as a credential to go and disable, which cannot both be
 * true and sends the operator after something that does not exist.
 */
export function isLiveAtVendorButDisabledHere(
  row: { readonly status: string; readonly keyHash: string },
  vendorKeys: readonly VendorKeyFacts[],
): boolean {
  if (row.status === "active") return false;
  const atVendor = vendorKeys.find((k) => k.hash === row.keyHash);
  return atVendor !== undefined && !atVendor.disabled;
}

/**
 * Has this key's ceiling drifted from the row that records it?
 *
 * The reset window is half the ceiling. A key that keeps its $25 but resets
 * weekly rather than daily has had its blast radius multiplied by seven, and
 * comparing the dollar figure alone calls that synchronised. The production
 * key named "$300/day" that resets weekly is the standing example of a window
 * nobody checked.
 */
export function hasCeilingDrift(
  vendorKey: VendorKeyFacts,
  expectedDailyLimitUsd: number,
): boolean {
  if (vendorKey.limitReset !== "daily") return true;
  return vendorKey.limit !== expectedDailyLimitUsd;
}
