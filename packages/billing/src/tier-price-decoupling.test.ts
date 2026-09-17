/**
 * The two orderings must stay apart (#3157).
 *
 * `TIER_ORDER` in `entitlements.ts` answers *does this plan include that
 * feature?* The prices in `pricing.ts` answer *is this plan more expensive?*
 * `changeOrgPlan` read the first as if it were the second, so Enterprise→Scale
 * doubled a customer's bill and raised no invoice, while Scale→Enterprise
 * halved it and charged one.
 *
 * Two guards live here:
 *
 *  1. A catalogue check proving the orderings genuinely disagree, so nobody can
 *     re-derive one from the other by inspection and be right by luck.
 *  2. A source scan over `packages/` and `apps/` failing any file that decides
 *     a proration behaviour and reads the tier ordering in the same breath.
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
