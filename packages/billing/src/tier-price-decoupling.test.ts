/**
 * The two orderings must stay apart (#3157).
 *
 * `TIER_ORDER` in `entitlements.ts` answers *does this plan include that
 * feature?* The prices in `pricing.ts` answer *is this plan more expensive?*
 * `changeOrgPlan` read the first as if it were the second, so Enterprise→Scale
 * doubled a customer's bill and raised no invoice, while Scale→Enterprise
 * halved it and charged one.
 *
 * There is a THIRD value, and it disagrees with both. Provider prices are
 * immutable, so `tools/scripts/stripe-sync.ts` mints a new price on a reprice
 * and overwrites the plan row while live subscriptions stay on the price they
 * were created with. What a given subscriber pays is therefore a property of
 * their subscription, and the plan row is a proxy for it in exactly the way
 * the tier rank was a proxy for the plan row — right until a reprice, then
 * inverted (PR #3171 review).
 *
 * Three guards live here:
 *
 *  1. A catalogue check proving the orderings genuinely disagree, so nobody can
 *     re-derive one from the other by inspection and be right by luck.
 *  2. A source scan over `packages/` and `apps/` failing any file that decides
 *     a proration behaviour and reads the tier ordering in the same breath.
 *  3. A check that the proration path takes its current price from the
 *     subscription rather than the plan row.
 *
 * The scan is the standing check the DoD asks for: it holds for code that does
 * not exist yet, not just for the two call sites this change fixed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { SUBSCRIPTION_PLANS } from "./pricing";

// packages/billing/src → repo root
const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const SCAN_ROOTS = ["packages", "apps"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".git",
]);

/** The ordering that answers "is this plan more expensive". */
const PRICE_DECISION = /proration_behavior|prorationBehavior/;
/**
 * The ordering that answers "does this plan include that feature", matched
 * where it is USED — a call or a lookup. Prose naming it (this file, and the
 * comments that keep the two questions apart) is the point, not a violation.
 */
const FEATURE_ORDERING =
  /meetsMinimumTier\s*\(|checkPlanTier\s*\(|requireTier\s*\(|TIER_ORDER\s*\[/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("plan price order and TIER_ORDER stay separate (#3157)", () => {
  it("the catalogue is not monotonic in price under the feature ordering", () => {
    const priceBySlug = new Map(
      SUBSCRIPTION_PLANS.map((p) => [p.slug, p.monthlyCents]),
    );
    const scale = priceBySlug.get("scale-v2");
    const enterprise = priceBySlug.get("enterprise-v2");
    expect(scale).toBeDefined();
    expect(enterprise).toBeDefined();

    // Enterprise outranks Scale on features (ACLs, SSO, SCIM, immutable audit)
    // and costs less. Anything deriving one ordering from the other is wrong
    // about this pair, in both directions.
    expect(enterprise).toBeLessThan(scale as number);
  });

  it("the proration direction is measured from a previewed invoice, not from any price field", () => {
    const src = readFileSync(
      join(REPO_ROOT, "packages/billing/src/subscriptions.ts"),
      "utf8",
    );

    // The measurement: a preview, taken under create_prorations so that asking
    // the question raises no invoice.
    expect(src).toMatch(/planChangeDirection/);
    expect(src).toMatch(/previewPlanChange\(/);
    expect(src).toMatch(/create_prorations/);

    // No amount reaches the decision. Whatever a caller has lying around, the
    // helper takes a subscription and a target price id and asks the provider
    // — so there is nothing to pass in that could be the wrong number.
    const signature = src.slice(
      src.indexOf("async function planChangeDirection("),
      src.indexOf("): Promise<PlanChangeDirection>"),
    );
    expect(signature.length).toBeGreaterThan(0);
    expect(signature).not.toMatch(/Cents|micros|Micros/);

    // And none of the stand-ins that have each inverted in turn. Every one was,
    // at the time, "exactly the figure a proration decision needs"; each was
    // wrong for a case nobody had hit yet.
    expect(src).not.toMatch(/unitAmountCents/);
    expect(src).not.toMatch(/planPriceMicros|planPriceDirection/);

    // `monthlyCents` survives in this file for one honest reason: an org with
    // no subscription has no invoice to preview, so its checkout quote is the
    // catalogue price. It must not appear in either in-place swap path, which
    // is where a figure would become a decision.
    for (const marker of [
      "// Active subscription \u2014 swap the price in-place",
      "// Active subscription \u2014 in-place swap preview",
    ]) {
      const from = src.indexOf(marker);
      expect(from).toBeGreaterThan(-1);
      const region = src.slice(from, from + 2_000);
      expect(region).not.toMatch(/monthlyCents|annualCents/);
    }
  });

  it("no price field is persisted on the subscription for something to decide from", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "packages/database/src/schema/billing.ts"),
      "utf8",
    );
    const subsTable = schema.slice(
      schema.indexOf("export const subscriptions"),
      schema.indexOf("export const paymentMethods"),
    );
    expect(subsTable.length).toBeGreaterThan(0);
    // An identity is fine — it says WHICH price, and cannot be wrong about a
    // number it does not carry. An amount is what invites the next inversion.
    expect(subsTable).toMatch(/stripe_price_id/);
    expect(subsTable).not.toMatch(
      /unit_amount_cents|monthly_cents|amount_cents/,
    );
  });

  it("the previewed proration is netted of discounts", () => {
    const provider = readFileSync(
      join(REPO_ROOT, "packages/billing/src/stripe-provider.ts"),
      "utf8",
    );
    // A line's `amount` is pre-discount; `discount_amounts` is what comes off
    // it. Summing the gross figure is how a discounted increase reads as a
    // decrease, and it also overstates the customer's quote.
    expect(provider).toMatch(/discount_amounts/);
    expect(provider).not.toMatch(/amountCents: l\.amount,/);
  });

  it("the previewed proration is isolated to the anchor this preview was taken at", () => {
    const provider = readFileSync(
      join(REPO_ROOT, "packages/billing/src/stripe-provider.ts"),
      "utf8",
    );
    // `proration === true` alone selects everything pending on the upcoming
    // invoice, so an unrelated credit can cancel a real upgrade and drop the
    // charge. The proration_date the preview was anchored at is what makes a
    // line this change's.
    expect(provider).toMatch(/l\.period\?\.start === prorationDate/);
    // …and an invoice whose prorations all belong to something else must not
    // be summed to zero, which reads as "this change is free".
    expect(provider).toMatch(/ProrationAttributionError/);
  });

  it("the credit grant is not gated on the invoice direction", () => {
    const subs = readFileSync(
      join(REPO_ROOT, "packages/billing/src/subscriptions.ts"),
      "utf8",
    );
    // Whether money is owed and whether the allowance went up are different
    // questions. `direction` answers the first; the grant's own delta guard
    // answers the second, and a preview that failed answers neither.
    expect(subs).not.toMatch(/if \(isUpgrade\) \{[\s\S]{0,200}grantProrated/);
    expect(subs).toMatch(/grantProratedPlanUpgradeCredits\(/);
  });

  it("the already-applied guard reads the provider's active price, not the synced column", () => {
    const subs = readFileSync(
      join(REPO_ROOT, "packages/billing/src/subscriptions.ts"),
      "utf8",
    );
    // The local column is written by the sync that runs after the mutation,
    // so it cannot see a swap whose response was lost.
    expect(subs).toMatch(/resolveActiveProviderState\(/);
    expect(subs).not.toMatch(/activeSubRow\.stripePriceId === newPriceId/);
  });

  it("neither plan-change path derives the current interval from the synced column", () => {
    const subs = readFileSync(
      join(REPO_ROOT, "packages/billing/src/subscriptions.ts"),
      "utf8",
    );
    // `billing_interval` is stale in exactly the failure the guard above
    // exists for, and it decides whether the change resets the billing-cycle
    // anchor — so it is read only as the fallback INSIDE the resolver, never
    // as the value a proration decision is made from (#3157, PR #3171
    // review). Behaviour is asserted in
    // `plan-change-provider-interval.test.ts`; this catches the reversion.
    expect(subs).not.toMatch(
      /currentInterval[^\n]*=[\s\S]{0,80}?(activeSub|activeSubRow)\.billingInterval/,
    );
    expect(subs).toMatch(
      /billingInterval: currentInterval[\s\S]{0,200}?resolveActiveProviderState\(/,
    );
  });

  it("no source file decides a proration behaviour from the tier ordering", () => {
    const files = SCAN_ROOTS.flatMap((root) =>
      sourceFiles(join(REPO_ROOT, root)),
    );
    // A scan that found nothing proves nothing.
    expect(files.length).toBeGreaterThan(0);

    const prorationFiles: string[] = [];
    const offenders: string[] = [];

    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!PRICE_DECISION.test(text)) continue;
      const rel = relative(REPO_ROOT, file);
      prorationFiles.push(rel);
      // This file is the standing guard; naming both orderings is its job.
      if (rel.endsWith("tier-price-decoupling.test.ts")) continue;
      if (FEATURE_ORDERING.test(text)) offenders.push(rel);
    }

    // The scan has to be looking at the code that makes this decision.
    expect(prorationFiles).toContain("packages/billing/src/subscriptions.ts");
    expect(offenders).toEqual([]);
  });
});
