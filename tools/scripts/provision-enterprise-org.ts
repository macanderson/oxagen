#!/usr/bin/env tsx
/**
 * provision-enterprise-org.ts — put an organisation on the enterprise tier and
 * hold its credit balance above a floor, so neither the in-app agent nor the
 * governed-action meter can refuse work for want of funds.
 *
 * WHY this exists.
 *
 * Credits only enter the platform two ways today: `grantFreeCredits` at signup
 * ($5, once) and a Stripe purchase. There is no operator path to provision an
 * organisation that is not a self-serve customer — Oxagen's own tenant, a
 * design partner on a signed enterprise agreement, an internal demo org. Doing
 * it by hand means three tables that must move together (`credit_lots`,
 * `credit_ledger`, `credit_balances`), and getting that wrong leaves the cached
 * balance disagreeing with the lots it mirrors. So the write goes through
 * {@link createCreditLot}, the same audited path a Stripe purchase takes.
 *
 * WHAT "cannot run out" means here — and what it deliberately does NOT mean.
 *
 * Nothing is bypassed. No gate is disabled, no billing-exempt flag is
 * introduced, and every governed action is still metered, priced and written to
 * the ledger exactly as it is for a paying customer. The record is the product;
 * an org that stops producing one is an org Oxagen cannot demo itself on. What
 * changes is only the *funding*: the balance is held so far above any plausible
 * burn that {@link assertCanStartTurn}'s three affirmative refusals can never
 * fire. Read the resulting ledger and you see a true account of what this org
 * spent — it simply never reaches zero.
 *
 * The four things that can refuse a turn, and what this script does to each
 * (see `packages/billing/src/metering.ts` → `assertCanStartTurn`, and
 * `spend-budget-gate.ts` → `assertWithinSpendBudget`):
 *
 *   1. `BillingSuspendedError`   — dunning_state = 'suspended'.
 *      → reset to 'active' and clear delinquent_since/grace_ends_at/suspended_at.
 *   2. `InsufficientCreditsError`— effective balance <= 0 after auto-reload.
 *      → top up to `--floor-usd` with a NON-EXPIRING lot. Re-running tops back
 *        up, so this is also the maintenance command, not just the setup one.
 *   3. `AssistantSpendCapError`  — the month's platform-paid assistant spend has
 *      reached `assistant_spend_cap_cents` (default $20 — ADR-053 §3).
 *      → set to NULL, which the cap check reads as "no cap" and which the
 *        module docstring names as an operator's choice, never a default.
 *   4. `BudgetExceededError`     — an enabled `billing.spend_budgets` ceiling.
 *      → disable the org's ceilings (the rows are kept, so the configuration is
 *        recoverable by flipping `enabled` back).
 *
 * Plus the tier itself: `org.organizations.plan_type = 'enterprise'`. This is
 * the SECOND leg of `resolveOrgTierDetailed`, so the script first checks
 * whether an entitled subscription already answers the tier question — that leg
 * wins, and writing `plan_type` under one would print green while changing
 * nothing. It reports the conflict and exits 2 rather than claiming a success
 * that is not one. The legacy leg is still the right one to write —
 * the subscription leg requires a real `stripe_subscription_id`, and minting a
 * synthetic one would put a row in front of Stripe reconciliation that no
 * Stripe object backs — `cancelOrgSubscription` and `startSubscriptionUpgrade`
 * would then call Stripe with an id it has never issued.
 *
 * Taking that leg has one cost the script pays rather than leaves behind: the
 * plan row is also where the governed-action allowance lives, so an enterprise
 * org without one falls to `ENTERPRISE_FALLBACK_ALLOWANCE` and logs
 * `billing_enterprise_allowance_missing` on EVERY governed action. The figure
 * therefore goes on `org.organizations.negotiated_actions_annual`, the legacy
 * leg's equivalent column, which `resolveOrgActionEntitlement` reads from a row
 * it already selects. The default is the same number the fallback used, so
 * provisioning changes no org's billing — it changes the allowance from ABSENT
 * to RECORDED, which is the distinction ADR-052 §4.2 exists to draw.
 *
 * ONE CONSEQUENCE WORTH KNOWING. Enterprise is the only tier whose orgs run the
 * full IAM resolver (`check-iam.ts` fast-paths every lower tier). Upgrading
 * therefore switches a security control ON, and an org whose IAM was never
 * seeded would start denying by default. The script refuses to leave that
 * state: it verifies the org has IAM principals and a system-default org Owner
 * (rule 7.5 — the Owner super-user allow that keeps a root principal from being
 * locked out of a capability nobody seeded), and tells you to run
 * `pnpm db:backfill-iam --apply` if not.
 *
 * Safety:
 *   - Defaults to --dry-run; pass --apply to write.
 *   - Prints the sanitized target host + database at startup.
 *   - Requires explicit confirmation before --apply against a non-local host.
 *   - Every step is idempotent: re-running converges, it does not accumulate.
 *
 * Usage:
 *   pnpm db:provision-enterprise --email mac@oxagen.sh
 *   pnpm db:provision-enterprise --email mac@oxagen.sh --apply
 *   pnpm db:provision-enterprise --org acme --floor-usd 5000000 --apply
 *   pnpm db:provision-enterprise --org acme --actions-annual 25000000 --apply
 *
 * Env:
 *   DATABASE_URL — required. `tsx --env-file` does NOT override a shell-set
 *   DATABASE_URL, so `unset DATABASE_URL` before targeting production and read
 *   the printed host before answering the confirmation prompt.
 */

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { URL, pathToFileURL } from "node:url";
import kleur from "kleur";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { requireEnv } from "@oxagen/config/env";
import { db, closeDatabase, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  createCreditLot,
  CREDIT_REASONS,
  ENTITLED_SUBSCRIPTION_STATUSES,
} from "@oxagen/billing";
import { formatError } from "./lib/format-error";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * The default balance floor, in whole USD.
 *
 * One billion dollars is not a guess at anyone's spend — it is chosen to be so
 * far outside the range of one tenant's plausible burn that the balance check
 * stops being a variable in operating the platform, while staying an exact
 * integer in every layer that touches it. In credit cents that is 1e11, which
 * is exactly representable as a JS `number` (well under 2^53, which the balance
 * crosses `Number()` for in log lines and the billing UI) and eleven orders of
 * magnitude below the `bigint` column's ceiling, so no sum of lots can overflow.
 *
 * A bigger number would buy nothing and start costing precision; a smaller one
 * would eventually need a human. This is the smallest number that needs neither.
 */
export const DEFAULT_FLOOR_USD = 1_000_000_000;

/** Credit cents per USD. One credit is one cent (`packages/billing/src/pricing.ts`). */
const CENTS_PER_USD = 100n;

/**
 * The default recorded governed-action commitment, per entitlement year.
 *
 * Deliberately the SAME figure `resolveActionAllowance` already falls back to
 * for an enterprise org with no plan row (`ENTERPRISE_FALLBACK_ALLOWANCE`), so
 * provisioning changes no org's billing by default. What changes is that the
 * number is now RECORDED rather than ABSENT — which is the whole distinction
 * ADR-052 §4.2 draws, and the reason the fallback logs
 * `billing_enterprise_allowance_missing` on every single governed action until
 * someone writes a figure down. Raise it with --actions-annual when the
 * commitment is actually larger.
 */
export const DEFAULT_ACTIONS_ANNUAL = 1_500_000;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

export function sanitizeUrl(raw: string): { host: string; database: string } {
  try {
    const u = new URL(raw);
    return {
      host: `${u.hostname}:${u.port || "5432"}`,
      database: u.pathname.replace(/^\//, "") || "(default)",
    };
  } catch {
    return { host: "(unparseable)", database: "(unparseable)" };
  }
}

export function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|::1)(:\d+)?$/.test(host);
}

/**
 * How much to grant so the balance reaches `floorCents`, or 0n when it already
 * does.
 *
 * Idempotency lives here rather than in a "have I run before?" marker. A marker
 * would make the second run a no-op even after the balance had been spent down,
 * which is the one case a top-up command exists for. Converging on a floor
 * means this script is safe to run on a schedule and safe to run twice by hand.
 */
export function topUpCents(currentCents: bigint, floorCents: bigint): bigint {
  if (floorCents <= 0n) return 0n;
  if (currentCents >= floorCents) return 0n;
  return floorCents - currentCents;
}

/**
 * `Number()` alone is not a parser for a CLI flag.
 *
 * `Number("")` and `Number("  ")` are both 0, so `--actions-annual ""` — which
 * is what a shell hands over for an unset variable, `--actions-annual "$N"` —
 * would have been read as a deliberate commitment of ZERO included actions
 * rather than as a missing value. This insists on digits before converting.
 */
function parseWholeNumberFlag(raw: string, flag: string, min: number): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `${flag} must be a ${min > 0 ? "positive" : "non-negative"} whole number, got: ${JSON.stringify(raw)}`,
    );
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < min) {
    throw new Error(
      `${flag} must be a ${min > 0 ? "positive" : "non-negative"} whole number, got: ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** Parse `--floor-usd`. Rejects anything that is not a positive whole number. */
export function parseFloorUsd(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_FLOOR_USD;
  return parseWholeNumberFlag(raw, "--floor-usd", 1);
}

/** Parse `--actions-annual`. Rejects anything that is not a non-negative whole number. */
export function parseActionsAnnual(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ACTIONS_ANNUAL;
  return parseWholeNumberFlag(raw, "--actions-annual", 0);
}

export function usdToCents(usd: number): bigint {
  return BigInt(usd) * CENTS_PER_USD;
}

/** `12345678` credit cents → `$123,456.78`, for the console summary. */
export function formatCents(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}$${whole}.${frac}`;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

interface TargetOrg {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  planType: string;
  status: string;
  negotiatedActionsAnnual: bigint | null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const DRY_RUN = !args.includes("--apply");
  const email = flagValue(args, "--email");
  const orgRef = flagValue(args, "--org");
  const floorUsd = parseFloorUsd(flagValue(args, "--floor-usd"));
  const floorCents = usdToCents(floorUsd);
  const actionsAnnual = parseActionsAnnual(flagValue(args, "--actions-annual"));

  if (!email && !orgRef) {
    console.error(
      kleur.red(
        "  Pass --email <address> (every org the user belongs to) or --org <slug|uuid|public_id>.",
      ),
    );
    process.exit(1);
  }

  const env = requireEnv(["DATABASE_URL"]);
  const { host, database } = sanitizeUrl(env.DATABASE_URL);

  console.log(
    kleur.cyan("┌─────────────────────────────────────────────────────────┐"),
  );
  console.log(
    kleur.cyan("│   provision-enterprise-org — tier + credit floor        │"),
  );
  console.log(
    kleur.cyan("└─────────────────────────────────────────────────────────┘"),
  );
  console.log();
  console.log(`  Target host  : ${kleur.yellow(host)}`);
  console.log(`  Database     : ${kleur.yellow(database)}`);
  console.log(
    `  Selector     : ${kleur.yellow(email ? `email=${email}` : `org=${orgRef}`)}`,
  );
  console.log(`  Balance floor: ${kleur.yellow(formatCents(floorCents))}`);
  console.log(
    `  Actions/yr   : ${kleur.yellow(actionsAnnual.toLocaleString("en-US"))} (recorded commitment)`,
  );
  console.log(
    `  Mode         : ${DRY_RUN ? kleur.blue("DRY RUN (read-only)") : kleur.red("APPLY (will write)")}`,
  );
  console.log();

  if (!DRY_RUN && !isLocalHost(host)) {
    console.log(kleur.red("  ⚠  Non-local database detected in --apply mode."));
    const ok = await confirm(
      `  Proceed with write to ${host}/${database}? [y/N] `,
    );
    if (!ok) {
      console.log(kleur.yellow("  Aborted."));
      await closeDatabase();
      process.exit(0);
    }
    console.log();
  }

  const d = db();

  // ── 1. Resolve the target orgs ─────────────────────────────────────────────
  let orgs: TargetOrg[];
  const cols = {
    id: schema.organizations.id,
    publicId: schema.organizations.publicId,
    name: schema.organizations.name,
    slug: schema.organizations.slug,
    planType: schema.organizations.planType,
    status: schema.organizations.status,
    negotiatedActionsAnnual: schema.organizations.negotiatedActionsAnnual,
  };

  if (email) {
    orgs = await d
      .selectDistinct(cols)
      .from(schema.organizations)
      .innerJoin(
        schema.orgUsers,
        eq(schema.orgUsers.orgId, schema.organizations.id),
      )
      .innerJoin(schema.users, eq(schema.users.id, schema.orgUsers.userId))
      .where(eq(schema.users.email, email));
  } else {
    const ref = orgRef as string;
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        ref,
      );
    orgs = await d
      .select(cols)
      .from(schema.organizations)
      .where(
        isUuid
          ? eq(schema.organizations.id, ref)
          : or(
              eq(schema.organizations.slug, ref),
              eq(schema.organizations.publicId, ref),
            ),
      );
  }

  if (orgs.length === 0) {
    console.error(kleur.red("  No organisation matched. Nothing to do."));
    await closeDatabase();
    process.exit(1);
  }

  console.log(kleur.cyan(`  ${orgs.length} organisation(s) matched.`));
  console.log();

  let failures = 0;
  let subscriptionOverrides = 0;

  for (const org of orgs) {
    const label = `${org.name} (${org.slug} · ${org.publicId})`;
    console.log(kleur.bold(`  ▸ ${label}`));

    try {
      // ── 2a. Does a subscription already answer the tier question? ──────────
      //
      // `resolveOrgTierDetailed` reads the subscription leg FIRST and only then
      // `organizations.plan_type`. So for an org with an entitled subscription
      // the writes below are inert — they would land in the column, the script
      // would print green, and the org would still resolve to whatever its plan
      // row says. The same is true of the action allowance, which
      // `resolveOrgActionEntitlement` also takes from the plan row when a
      // subscription answers. Say so instead of claiming a success that is not
      // one; changing the plan row itself is not this script's call, because a
      // plan row is shared by every org subscribed to it.
      const [entitledSub] = await d
        .select({
          stripeSubscriptionId: schema.subscriptions.stripeSubscriptionId,
          status: schema.subscriptions.status,
          planSlug: schema.plans.slug,
          planTier: schema.plans.tier,
        })
        .from(schema.subscriptions)
        .innerJoin(
          schema.plans,
          eq(schema.subscriptions.planId, schema.plans.id),
        )
        .where(
          and(
            eq(schema.subscriptions.orgId, org.id),
            inArray(schema.subscriptions.status, [
              ...ENTITLED_SUBSCRIPTION_STATUSES,
            ]),
          ),
        )
        .limit(1);

      if (entitledSub && entitledSub.planTier !== "enterprise") {
        console.log(
          kleur.yellow(
            `      subscription    : entitled '${entitledSub.status}' subscription on plan '${entitledSub.planSlug}' (tier '${entitledSub.planTier}') WINS over plan_type — the tier write below will not take effect. Move the subscription to an enterprise plan in Stripe, or cancel it, then re-run.`,
          ),
        );
        subscriptionOverrides += 1;
      } else if (entitledSub) {
        console.log(
          `      subscription    : entitled '${entitledSub.status}' subscription already on an enterprise plan ('${entitledSub.planSlug}')`,
        );
      }

      // ── 2b. Tier + recorded action commitment ──────────────────────────────
      // These move together because enterprise is the tier whose allowance the
      // meter refuses to infer: setting the tier without recording a figure is
      // exactly the mis-provisioned state `billing_enterprise_allowance_missing`
      // alerts on, and it would alert on every governed action from here on.
      const tierIsSet =
        org.planType === "enterprise" && org.status === "active";
      const allowanceIsSet =
        org.negotiatedActionsAnnual !== null &&
        Number(org.negotiatedActionsAnnual) === actionsAnnual;

      if (tierIsSet && allowanceIsSet) {
        console.log(
          `      tier            : already enterprise/active, ${actionsAnnual.toLocaleString("en-US")} actions/yr recorded`,
        );
      } else if (DRY_RUN) {
        console.log(
          kleur.blue(
            `      tier            : would set plan_type '${org.planType}' → 'enterprise', status '${org.status}' → 'active', negotiated_actions_annual ${org.negotiatedActionsAnnual ?? "NULL"} → ${actionsAnnual}`,
          ),
        );
      } else {
        await d
          .update(schema.organizations)
          .set({
            planType: "enterprise",
            status: "active",
            negotiatedActionsAnnual: BigInt(actionsAnnual),
            updatedAt: new Date(),
          })
          .where(eq(schema.organizations.id, org.id));
        console.log(
          kleur.green(
            `      tier            : enterprise/active, ${actionsAnnual.toLocaleString("en-US")} actions/yr recorded`,
          ),
        );
      }

      // ── 3. Billing settings: no assistant cap, no dunning hold ─────────────
      const [settings] = await d
        .select({
          id: schema.orgBillingSettings.id,
          assistantSpendCapCents:
            schema.orgBillingSettings.assistantSpendCapCents,
          dunningState: schema.orgBillingSettings.dunningState,
        })
        .from(schema.orgBillingSettings)
        .where(eq(schema.orgBillingSettings.orgId, org.id))
        .limit(1);

      const capIsClear = settings?.assistantSpendCapCents === null;
      const dunningIsClear = settings?.dunningState === "active";

      if (settings && capIsClear && dunningIsClear) {
        console.log(`      billing settings: already uncapped, dunning active`);
      } else if (DRY_RUN) {
        console.log(
          kleur.blue(
            `      billing settings: would set assistant_spend_cap_cents=NULL (currently ${
              settings
                ? (settings.assistantSpendCapCents ?? "NULL")
                : "no row — default $20"
            }), dunning_state='active' (currently ${settings?.dunningState ?? "no row"})`,
          ),
        );
      } else {
        const clear = {
          assistantSpendCapCents: null,
          dunningState: "active",
          delinquentSince: null,
          graceEndsAt: null,
          suspendedAt: null,
          // A balance held at the floor never dips below the reload threshold,
          // so auto-reload could not fire anyway. Disabling it says so
          // explicitly rather than leaving a card wired to a trigger that is
          // now unreachable.
          autoReloadEnabled: false,
          updatedAt: new Date(),
        };
        if (settings) {
          await d
            .update(schema.orgBillingSettings)
            .set(clear)
            .where(eq(schema.orgBillingSettings.id, settings.id));
        } else {
          await d
            .insert(schema.orgBillingSettings)
            .values({ orgId: org.id, ...clear });
        }
        console.log(
          kleur.green(
            `      billing settings: assistant cap cleared, dunning active, auto-reload off`,
          ),
        );
      }

      // ── 4. Spend-budget ceilings ───────────────────────────────────────────
      const enabledBudgets = await d
        .select({
          id: schema.spendBudgets.id,
          workspaceId: schema.spendBudgets.workspaceId,
          limitMicros: schema.spendBudgets.limitMicros,
        })
        .from(schema.spendBudgets)
        .where(
          and(
            eq(schema.spendBudgets.orgId, org.id),
            eq(schema.spendBudgets.enabled, true),
          ),
        );

      if (enabledBudgets.length === 0) {
        console.log(`      spend budgets   : none enabled`);
      } else if (DRY_RUN) {
        console.log(
          kleur.blue(
            `      spend budgets   : would disable ${enabledBudgets.length} enabled ceiling(s)`,
          ),
        );
      } else {
        await d
          .update(schema.spendBudgets)
          .set({ enabled: false, updatedAt: new Date() })
          .where(
            and(
              eq(schema.spendBudgets.orgId, org.id),
              eq(schema.spendBudgets.enabled, true),
            ),
          );
        console.log(
          kleur.green(
            `      spend budgets   : disabled ${enabledBudgets.length} ceiling(s) (rows kept)`,
          ),
        );
      }

      // ── 5. Credit floor ────────────────────────────────────────────────────
      // Read the balance the same way the gate does: sum the lots that have not
      // expired, not the `credit_balances` mirror — the mirror drifts ABOVE the
      // spendable balance once an expiring lot lapses, and topping up from a
      // number that reads high is how an org with a "positive" balance gets
      // refused.
      const now = new Date();
      const lots = await d
        .select({ remaining: schema.creditLots.remainingCents })
        .from(schema.creditLots)
        .where(
          and(
            eq(schema.creditLots.orgId, org.id),
            or(
              isNull(schema.creditLots.expiresAt),
              gt(schema.creditLots.expiresAt, now),
            ),
          ),
        );
      const current = lots.reduce(
        (acc, r) =>
          acc +
          (typeof r.remaining === "bigint" ? r.remaining : BigInt(r.remaining)),
        0n,
      );
      const topUp = topUpCents(current, floorCents);

      if (topUp === 0n) {
        console.log(
          `      credits         : ${formatCents(current)} — already at or above floor`,
        );
      } else if (DRY_RUN) {
        console.log(
          kleur.blue(
            `      credits         : ${formatCents(current)} → would grant ${formatCents(topUp)} (non-expiring) to reach ${formatCents(floorCents)}`,
          ),
        );
      } else {
        // The credit tables are org-scoped (their RLS policy reads
        // app.current_org_id alone), but runInTenantScope asserts a uuid for
        // workspaceId too. Use a real workspace when the org has one so the GUC
        // is truthful; an org with no workspace yet gets its own id, which no
        // policy on this write path consults.
        const [ws] = await d
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.orgId, org.id))
          .limit(1);

        const { effectiveBalanceCents } = await runInTenantScope(
          { orgId: org.id, workspaceId: ws?.id ?? org.id },
          () =>
            createCreditLot({
              orgId: org.id,
              amountCents: topUp,
              source: "free_grant",
              expiresAt: null,
              reason: CREDIT_REASONS.GRANT_MANUAL,
              referenceType: "provision_enterprise_org",
              // A FRESH reference per top-up, not a stable one keyed on the
              // org. `credit_ledger_grant_idempotency_idx` makes
              // (org, reason, reference_type, reference_id) unique for every
              // `grant_%` reason, and `createCreditLot` inserts plainly rather
              // than ON CONFLICT DO NOTHING — so a stable reference would make
              // the SECOND top-up throw a constraint violation instead of
              // topping up. Each top-up genuinely is a distinct grant, so it
              // gets a distinct identifier; the floor check above is what keeps
              // a re-run from granting twice for the same shortfall.
              referenceId: randomUUID(),
            }),
        );
        console.log(
          kleur.green(
            `      credits         : granted ${formatCents(topUp)} → balance ${formatCents(effectiveBalanceCents)}`,
          ),
        );
      }

      // ── 6. IAM readiness (enterprise runs the full resolver) ───────────────
      const [principal] = await d
        .select({ id: schema.principals.id })
        .from(schema.principals)
        .where(eq(schema.principals.orgId, org.id))
        .limit(1);

      if (principal) {
        console.log(`      iam             : principals present`);
      } else {
        console.log(
          kleur.yellow(
            `      iam             : NO principals — enterprise runs the full IAM resolver. Run: pnpm db:backfill-iam -- --apply`,
          ),
        );
      }
    } catch (err) {
      failures += 1;
      console.log(kleur.red(`      failed: ${formatError(err)}`));
    }

    console.log();
  }

  await closeDatabase();

  if (DRY_RUN) {
    console.log(
      kleur.blue("  Dry run complete — nothing written. Re-run with --apply."),
    );
  } else {
    console.log(kleur.green("  Done."));
  }
  if (subscriptionOverrides > 0) {
    console.log(
      kleur.yellow(
        `  ${subscriptionOverrides} organisation(s) still resolve to a non-enterprise tier through an entitled subscription — the credit floor applies, the tier does not.`,
      ),
    );
  }
  if (failures > 0) {
    console.log(kleur.red(`  ${failures} organisation(s) failed.`));
    process.exit(1);
  }
  // A tier that did not take is not a success, even though every write
  // succeeded. Exit non-zero so a scripted caller notices.
  if (subscriptionOverrides > 0) process.exit(2);
}

// Only run when invoked directly (`tsx provision-enterprise-org.ts`), never on
// import — a unit test importing the pure helpers below must not open a
// database connection or call process.exit and take the runner down with it.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(async (err: unknown) => {
    console.error(kleur.red(formatError(err)));
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
}
