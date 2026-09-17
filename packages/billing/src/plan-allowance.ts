/**
 * plan-allowance.ts — the organisation's governed-action entitlement.
 *
 * One query answering both halves of the allowance question: which tier the
 * organisation is on, and how many governed actions its plan row includes per
 * entitlement year (ADR-052 §4.2, spec §7.3).
 *
 * It is one query on purpose. This sits on the accrual path, which runs after
 * every governed action, and `resolveOrgTier` plus a separate plan read would
 * be two round trips per action for two columns of the same join.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { withSystemDb, schema, type Tx } from "@oxagen/database";
import type { PlanTier } from "@oxagen/oxagen/types";
import { ENTITLED_SUBSCRIPTION_STATUSES } from "./tier";
import { TIER_ACTION_ALLOWANCES } from "./action-metering";

const VALID_TIERS = new Set<PlanTier>(["free", "build", "scale", "enterprise"]);

function isTier(value: unknown): value is PlanTier {
  return typeof value === "string" && VALID_TIERS.has(value as PlanTier);
}

/**
 * What the last probe said about `org.organizations.negotiated_actions_annual`,
 * and when it said it.
 *
 * Deployment and migration are separate manual steps in this repo
 * (`pipeline.yml`: `deploy-node` no longer waits for `db-migrate.yml`), so
 * production can run this code before migration `20260916120000` is applied.
 * An unconditional reference to the column then raises 42703 on EVERY
 * `resolveOrgActionEntitlement` call — and because the kernel catches the
 * recorder's error, successful governed actions go uncounted and unbilled for
 * the whole window, silently.
 *
 * ## Why this asks first rather than trying and recovering
 *
 * The obvious shape — issue the query, catch 42703, retry without the column —
 * cannot work, and its unit test cannot see that. 42703 ABORTS the enclosing
 * transaction, and `withSystemDb` is one. Catching the exception does not
 * restore the transaction, so the retry raises 25P02
 * (`current transaction is aborted`) and the first call in every process still
 * fails. A mock that merely rejects one query and answers the next models the
 * error but not what PostgreSQL does to the transaction around it, so such a
 * test passes while the code does not work.
 *
 * Probing has no error path to get wrong: `information_schema` always answers.
 */
let negotiatedColumn: { present: boolean; probedAtMs: number } | undefined;

/**
 * How long a NEGATIVE probe is trusted before asking again.
 *
 * A positive answer is kept for the life of the process, because a column that
 * exists does not stop existing. A negative one must expire: production
 * migrations are applied by hand, so an instance that started before the
 * migration has to notice it afterwards. Caching the miss forever meant that
 * instance ignored every negotiated allowance until it was recycled, charging
 * enterprise overage against the fallback in the meantime.
 *
 * A minute is short enough that a hand-applied migration takes effect while the
 * operator is still watching, and long enough that the probe is not a per-call
 * round trip on the accrual path.
 */
const NEGATIVE_PROBE_TTL_MS = 60_000;

/** Test seam. Resets the per-process answer above. */
export function resetNegotiatedColumnProbeForTests(): void {
  negotiatedColumn = undefined;
}

/**
 * Whether this database has the negotiated-allowance column, asked at most
 * once per process while the answer is yes, and at most once a minute while it
 * is no.
 */
async function hasNegotiatedColumn(
  tx: Pick<Tx, "execute">,
  nowMs: number,
): Promise<boolean> {
  if (negotiatedColumn?.present === true) return true;
  if (
    negotiatedColumn !== undefined &&
    nowMs - negotiatedColumn.probedAtMs < NEGATIVE_PROBE_TTL_MS
  ) {
    return false;
  }
  const rows = await tx.execute(sql`
    select 1
      from information_schema.columns
     where table_schema = 'org'
       and table_name = 'organizations'
       and column_name = 'negotiated_actions_annual'
     limit 1
  `);
  const present = Array.from(rows as Iterable<unknown>).length > 0;
  negotiatedColumn = { present, probedAtMs: nowMs };
  return present;
}

export interface OrgActionEntitlement {
  tier: PlanTier;
  /**
   * The organisation's recorded governed-action commitment: from
   * `billing.plans.included_actions_annual` when an entitled subscription
   * answered, otherwise from `org.organizations.negotiated_actions_annual` —
   * the legacy leg's place to record a figure for an enterprise organisation
   * that never went through Stripe checkout. Null means "fall back to the tier
   * default" — never "unlimited"; `resolveActionAllowance` enforces that
   * distinction.
   */
  includedActionsAnnual: number | null;
}

/**
 * Resolve an organisation's tier and stored action allowance together.
 *
 * The entitled-status list is shared with {@link ENTITLED_SUBSCRIPTION_STATUSES}
 * rather than restated. That list is the fix for #1384, where tier resolution
 * counted only `active` while every other subscription query in this package
 * counted a trial too — and because the tier gate switches IAM on, the
 * mismatch switched a security control off. A second copy here would be a
 * second chance to make the same mistake.
 *
 * Falls back to the legacy `organizations.plan_type` leg for pre-billing-table
 * organisations, exactly as `resolveOrgTierDetailed` does, so the two functions
 * cannot disagree about which tier an organisation is on.
 */
export async function resolveOrgActionEntitlement(
  orgId: string,
): Promise<OrgActionEntitlement> {
  // An empty orgId is a real case (`create_org` runs before an org exists) and
  // both columns are `uuid`, which Postgres cannot compare to "". Answer
  // without querying, on the most restricted tier.
  if (!orgId) return { tier: "free", includedActionsAnnual: null };

  const { sub, org } = await withSystemDb(async (tx) => {
    const s = await tx
      .select({
        tier: schema.plans.tier,
        includedActionsAnnual: schema.plans.includedActionsAnnual,
      })
      .from(schema.subscriptions)
      .innerJoin(schema.plans, eq(schema.subscriptions.planId, schema.plans.id))
      .where(
        and(
          eq(schema.subscriptions.orgId, orgId),
          inArray(schema.subscriptions.status, [
            ...ENTITLED_SUBSCRIPTION_STATUSES,
          ]),
        ),
      )
      .limit(1);
    // Selected from a row this query already reads, so the legacy leg costs no
    // extra round trip on the accrual path — when the column is there.
    const withNegotiated = {
      planType: schema.organizations.planType,
      negotiatedActionsAnnual: schema.organizations.negotiatedActionsAnnual,
    };
    const tierOnly = { planType: schema.organizations.planType };
    const readOrg = async (columns: Record<string, unknown>) =>
      tx
        .select(columns as typeof withNegotiated)
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId))
        .limit(1);

    // Asked before the query that would otherwise abort this transaction. When
    // the column is absent the answer is the tier alone, which is all an
    // unmigrated database could have recorded anyway.
    const present = await hasNegotiatedColumn(tx, Date.now());
    return { sub: s, org: await readOrg(present ? withNegotiated : tierOnly) };
  });

  const row = sub[0];
  if (row && isTier(row.tier)) {
    return {
      tier: row.tier,
      includedActionsAnnual:
        row.includedActionsAnnual === null
          ? null
          : Number(row.includedActionsAnnual),
    };
  }

  const orgRow = org[0];
  if (isTier(orgRow?.planType)) {
    // `negotiated_actions_annual` is this leg's equivalent of the plan row's
    // `included_actions_annual`. Without it an enterprise organisation that
    // never went through Stripe checkout had NOWHERE to record its commitment,
    // so `resolveActionAllowance` fell to the scale figure and logged
    // `billing_enterprise_allowance_missing` on every governed action —
    // permanently, with no action an operator could take to clear it. NULL
    // still means "fall back to the tier default", never "unlimited".
    const negotiated = orgRow.negotiatedActionsAnnual;
    const parsed =
      negotiated === null || negotiated === undefined
        ? Number.NaN
        : Number(negotiated);
    return {
      tier: orgRow.planType,
      // A non-finite or negative figure is a corrupt row, not a smaller
      // commitment, and handing it on would put NaN into the allowance the
      // meter compares an action count against. The DB CHECK forbids negatives;
      // this is the belt to its braces, and it lands on the tier default —
      // which for enterprise is the bounded fallback plus its alert, so a
      // corrupt row under-bills visibly rather than running free.
      includedActionsAnnual:
        Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null,
    };
  }
  return { tier: "free", includedActionsAnnual: null };
}

/**
 * The published default allowance for a tier, with no DB read.
 *
 * For quotes and the rate-card capability, where the question is "what does
 * this tier include" rather than "what does this organisation have".
 */
export function publishedAllowanceForTier(tier: PlanTier): number | null {
  return TIER_ACTION_ALLOWANCES[tier];
}
