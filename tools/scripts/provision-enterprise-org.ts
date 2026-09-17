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
 *   - Every --apply confirms, whatever the host looks like: a tunnelled
 *     production cluster reads as `localhost`. `--yes` is the explicit opt-out.
 *   - Every step is idempotent: re-running converges, it does not accumulate.
 *
 * Usage:
 *   pnpm db:provision-enterprise --email mac@oxagen.sh
 *   pnpm db:provision-enterprise --email mac@oxagen.sh --apply
 *   pnpm db:provision-enterprise --org acme --floor-usd 500000 --apply
 *   pnpm db:provision-enterprise --org acme --actions-annual 25000000 --apply
 *   pnpm db:provision-enterprise --org acme --apply --yes   # no prompt (scripted)
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
import type { SQL } from "drizzle-orm";
import { and, count, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { requireEnv } from "@oxagen/config/env";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
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
 * $100,000 is comfortably above any plausible burn for one tenant — it is
 * roughly two hundred years of the $500/month enterprise plan's included credit
 * — while staying a number a human reading the billing page can make sense of.
 * A balance in the billions reads as a bug in the meter rather than a decision
 * someone made, and the first thing anyone does with a figure they cannot
 * believe is stop trusting the page it is on.
 *
 * It does not need to be enormous, because the floor is a floor rather than a
 * one-time gift: {@link topUpCents} grants only the shortfall, so re-running
 * this command tops the balance back up. Running out is a scheduling problem,
 * not a sizing one, and `--floor-usd` raises it for a tenant that needs more.
 *
 * In credit cents that is 1e7 — exact as a JS `number` (the balance crosses
 * `Number()` in log lines and the billing UI) and far below the `bigint`
 * column's ceiling, so no sum of lots can overflow.
 */
export const DEFAULT_FLOOR_USD = 100_000;

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

/**
 * Statuses this script refuses to act on.
 *
 * `org.list` and `workspace.list` hide an organisation specifically while its
 * status is `deleted`, so writing `status: 'active'` over it resurrects the
 * tenant and re-exposes its retained workspaces and data. Deleting an
 * organisation is a decision; undoing it is not something a provisioning run
 * should do on the way past, and the target queries do not filter on status.
 */
export const UNPROVISIONABLE_STATUSES: ReadonlySet<string> = new Set([
  "deleted",
]);

/** Why this organisation cannot be provisioned, or undefined when it can. */
export function unprovisionableReason(status: string): string | undefined {
  return UNPROVISIONABLE_STATUSES.has(status)
    ? `status is '${status}' — provisioning would set it back to 'active' and re-expose the tenant. Restore it deliberately first, then re-run.`
    : undefined;
}

/**
 * The predicate for "this organisation has a human who can still act after the
 * enterprise tier switches the default-deny resolver on".
 *
 * Exported so the shape can be asserted rather than eyeballed. Every clause is
 * load-bearing, and the two easiest to leave out are the ones that were:
 *
 *   - `principal_role_assignments.org_id` — an assignment carries its own org,
 *     and joining through to a role owned by this org does not constrain it.
 *   - `principal_role_assignments.workspace_id IS NULL` — a workspace-scoped
 *     assignment grants Owner inside that workspace only, so a workspace-only
 *     Owner does not stop the ORGANISATION locking itself out.
 *   - `roles.scope_kind = 'org'` — two system roles are named "Owner", and only
 *     the org-scoped one is a super-user under resolver rule 7.5.
 *
 * Mirrors the predicates `packages/iam/src/fetch-authz.ts` applies to the same
 * table, which is the resolver this preflight is predicting the behaviour of.
 */
export function orgWideSystemOwnerWhere(orgId: string, now: Date): SQL {
  const predicate = and(
    eq(schema.principals.orgId, orgId),
    // A human, not an agent or service principal: an agent holding Owner does
    // not keep a person out of the organisation.
    eq(schema.principals.kind, "human"),
    eq(schema.principals.status, "active"),
    eq(schema.principalRoleAssignments.orgId, orgId),
    isNull(schema.principalRoleAssignments.workspaceId),
    isNull(schema.principalRoleAssignments.deletedAt),
    eq(schema.roles.orgId, orgId),
    // The ORG-scoped Owner. `iam-provision.ts` seeds two system roles named
    // "Owner" for every organisation — one `scope_kind = 'org'` from ORG_ROLES
    // and one `scope_kind = 'workspace'` from WORKSPACE_ROLES — both with
    // `is_system_default = true`. The resolver's rule 7.5 grants org-owner
    // super-user only for `scopeKind === "org"`, so without this clause an
    // org-wide assignment to the WORKSPACE Owner satisfied a preflight that the
    // resolver it predicts would refuse, and the tier switch left the
    // organisation under default-deny with nobody able to act.
    //
    // A separate axis from the assignment's scope above: that one asks where
    // the grant applies, this one asks which role was granted.
    eq(schema.roles.scopeKind, "org"),
    eq(schema.roles.name, "Owner"),
    // The system-seeded Owner, not a custom role somebody named Owner.
    eq(schema.roles.isSystemDefault, true),
    or(
      isNull(schema.principalRoleAssignments.expiresAt),
      gt(schema.principalRoleAssignments.expiresAt, now),
    ),
  );
  // `and()` is typed as possibly-undefined because it drops undefined
  // conditions. Every condition above is a literal, so this cannot happen —
  // and a `where()` that silently received `undefined` would match every row,
  // which for this predicate means passing the preflight for any organisation.
  if (!predicate) {
    throw new Error("unreachable: the owner-readiness predicate was empty");
  }
  return predicate;
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

/**
 * Whether a recorded commitment may be overwritten with `actionsAnnual`.
 *
 * The documented recurring top-up command does not pass `--actions-annual`, so
 * without this an org provisioned with a negotiated 25,000,000 had that figure
 * silently replaced by the 1,500,000 default on the next maintenance run — and
 * the org began paying overage on a commitment nobody changed.
 *
 * So: write when the operator asked for a figure, and otherwise only to fill a
 * column that holds nothing. A stored figure and no flag is a signed commitment
 * being left alone, not a difference to reconcile.
 */
export function shouldWriteAllowance(
  stored: bigint | number | null | undefined,
  flagGiven: boolean,
): boolean {
  return flagGiven || stored === null || stored === undefined;
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

/**
 * Is `negotiated_actions_annual` on this database yet?
 *
 * The column arrives with 20260916120000, and a database can legitimately be
 * behind it — production migrates by hand from the app node, so the gap between
 * a merge and an apply is real and can be days. Selecting a column that is not
 * there fails the whole run with a 42703 about a column name, which tells an
 * operator nothing about what to do. Probing lets the run do everything else —
 * including the credit floor, which is the part someone is usually standing
 * there waiting for — and say plainly which one thing it could not do.
 */
async function hasNegotiatedAllowanceColumn(d: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<boolean> {
  const rows = await d.execute(sql`
    select 1
      from information_schema.columns
     where table_schema = 'org'
       and table_name = 'organizations'
       and column_name = 'negotiated_actions_annual'
     limit 1
  `);
  return Array.from(rows as Iterable<unknown>).length > 0;
}

interface TargetOrg {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  planType: string;
  status: string;
  negotiatedActionsAnnual?: bigint | null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const DRY_RUN = !args.includes("--apply");
  const SKIP_CONFIRM = args.includes("--yes");
  const email = flagValue(args, "--email");
  const orgRef = flagValue(args, "--org");
  const floorUsd = parseFloorUsd(flagValue(args, "--floor-usd"));
  const floorCents = usdToCents(floorUsd);
  const actionsAnnualFlag = flagValue(args, "--actions-annual");
  const actionsAnnualGiven = actionsAnnualFlag !== undefined;
  const actionsAnnual = parseActionsAnnual(actionsAnnualFlag);

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

  // Every --apply confirms, not only a remote-looking one.
  //
  // The host string cannot tell you which database you are about to write to.
  // Production Aurora is VPC-only and is reached through an SSM port-forward,
  // so the connection string for the REAL production cluster reads
  // `localhost:15432` — indistinguishable by hostname from a laptop's dev
  // Postgres on 5433, and a check that keyed on that would wave through exactly
  // the run that most needed stopping. So the prompt is unconditional and
  // `--yes` is the explicit opt-out for scripted local use.
  //
  // The fingerprint is there for the same reason: an operator confirming a
  // write needs one fact the hostname cannot give them. A dev database has a
  // handful of organisations and production has whatever it has, so the count
  // is the cheapest thing that distinguishes them at a glance.
  if (!DRY_RUN && !SKIP_CONFIRM) {
    const [fingerprint] = await withSystemDb((tx) =>
      tx.select({ orgs: count() }).from(schema.organizations),
    );
    if (!isLocalHost(host)) {
      console.log(kleur.red("  ⚠  Non-local database in --apply mode."));
    }
    console.log(
      kleur.yellow(
        `  About to WRITE to ${host}/${database} — ${fingerprint?.orgs ?? "?"} organisation(s) in org.organizations.`,
      ),
    );
    console.log(
      kleur.yellow(
        "  A tunnelled production cluster also reads as localhost. Confirm you know which database this is.",
      ),
    );
    const ok = await confirm("  Proceed? [y/N] ");
    if (!ok) {
      console.log(kleur.yellow("  Aborted."));
      await closeDatabase();
      process.exit(0);
    }
    console.log();
  }

  // Every operator query below runs through `withSystemDb`, not the raw handle.
  //
  // `db()` sets neither the tenant GUCs nor `app.rls_bypass`, and `org_users`,
  // the billing settings, the spend budgets, the credit lots and the IAM
  // principals all carry forced RLS. Under enforcement the raw handle found no
  // organisations for `--email` at all, and `--org --apply` wrote the
  // unprotected organisation row and then failed the billing-settings insert on
  // its RLS check, leaving the org half-provisioned. `withSystemDb` is the
  // intentional, audited bypass, and an operator script provisioning across
  // tenants is exactly its caller.
  const canRecordAllowance = await withSystemDb((tx) =>
    hasNegotiatedAllowanceColumn(tx),
  );
  if (!canRecordAllowance) {
    console.log(
      kleur.yellow(
        "  org.organizations.negotiated_actions_annual is missing — this database is behind migration 20260916120000.\n  Everything else still runs; the action commitment is skipped and the org keeps the bounded enterprise fallback.\n",
      ),
    );
  }

  // ── 1. Resolve the target orgs ─────────────────────────────────────────────
  let orgs: TargetOrg[];
  const cols = {
    id: schema.organizations.id,
    publicId: schema.organizations.publicId,
    name: schema.organizations.name,
    slug: schema.organizations.slug,
    planType: schema.organizations.planType,
    status: schema.organizations.status,
    ...(canRecordAllowance
      ? {
          negotiatedActionsAnnual: schema.organizations.negotiatedActionsAnnual,
        }
      : {}),
  };

  if (email) {
    orgs = await withSystemDb((tx) =>
      tx
        .selectDistinct(cols)
        .from(schema.organizations)
        .innerJoin(
          schema.orgUsers,
          eq(schema.orgUsers.orgId, schema.organizations.id),
        )
        .innerJoin(schema.users, eq(schema.users.id, schema.orgUsers.userId))
        .where(eq(schema.users.email, email)),
    );
  } else {
    const ref = orgRef as string;
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        ref,
      );
    orgs = await withSystemDb((tx) =>
      tx
        .select(cols)
        .from(schema.organizations)
        .where(
          isUuid
            ? eq(schema.organizations.id, ref)
            : or(
                eq(schema.organizations.slug, ref),
                eq(schema.organizations.publicId, ref),
              ),
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
      // ── 2. Refusals, BEFORE anything is written ───────────────────────────
      //
      // Both of these used to be discovered after the tier had already been
      // changed: the deleted-org case was never checked at all, and the IAM
      // check ran at the end and only printed a warning while the script still
      // exited zero. A refusal that arrives after the write is not a refusal.
      const refusal = unprovisionableReason(org.status);
      if (refusal) {
        console.log(kleur.red(`      refused         : ${refusal}`));
        failures += 1;
        console.log();
        continue;
      }

      // Enterprise runs the full IAM resolver, whose default effect is deny. An
      // org with no seeded Owner principal therefore loses every governed
      // action the moment the tier lands, and the operator finds out from the
      // customer. Check before the write, and refuse rather than warn.
      const [ownerPrincipal] = await withSystemDb((tx) =>
        tx
          .select({ id: schema.principals.id })
          .from(schema.principals)
          .innerJoin(
            schema.principalRoleAssignments,
            eq(
              schema.principalRoleAssignments.principalId,
              schema.principals.id,
            ),
          )
          .innerJoin(
            schema.roles,
            eq(schema.roles.id, schema.principalRoleAssignments.roleId),
          )
          .where(orgWideSystemOwnerWhere(org.id, new Date()))
          .limit(1),
      );

      if (!ownerPrincipal) {
        console.log(
          kleur.red(
            `      refused         : no active human principal holds an ORG-WIDE system Owner assignment. Enterprise runs the full IAM resolver (default deny), so the tier would lock this organisation out, and a workspace-scoped Owner does not prevent that. Run: pnpm db:backfill-iam -- --apply, then re-run.`,
          ),
        );
        failures += 1;
        console.log();
        continue;
      }
      console.log(
        `      iam             : an active human holds org-wide system Owner`,
      );

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
      const [entitledSub] = await withSystemDb((tx) =>
        tx
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
          .limit(1),
      );

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
        // `resolveOrgActionEntitlement` takes the subscription plan's allowance
        // before it looks at `negotiated_actions_annual`, so a figure written
        // here would be recorded and never read. The script used to write it
        // and report success, which is how a 25,000,000 commitment kept billing
        // overage above the plan's seed.
        if (actionsAnnualGiven) {
          console.log(
            kleur.red(
              `      refused         : --actions-annual cannot apply to an organisation whose allowance comes from plan '${entitledSub.planSlug}'. Change that plan's included_actions_annual, or move the subscription, then re-run.`,
            ),
          );
          failures += 1;
          console.log();
          continue;
        }
      }

      // ── 2b. Tier + recorded action commitment ──────────────────────────────
      // These move together because enterprise is the tier whose allowance the
      // meter refuses to infer: setting the tier without recording a figure is
      // exactly the mis-provisioned state `billing_enterprise_allowance_missing`
      // alerts on, and it would alert on every governed action from here on.
      const tierIsSet =
        org.planType === "enterprise" && org.status === "active";
      // On a database behind 20260916120000 there is no column to compare or to
      // write, so the allowance half is satisfied by definition and the org
      // keeps `resolveActionAllowance`'s bounded enterprise fallback.
      // A stored figure the operator did not ask to change is a signed
      // commitment, not a difference to reconcile. Writing the default over it
      // on the documented recurring top-up run is how a negotiated allowance
      // silently shrank and the org began paying overage.
      const writeAllowance =
        canRecordAllowance &&
        shouldWriteAllowance(org.negotiatedActionsAnnual, actionsAnnualGiven);
      const allowanceIsSet =
        !writeAllowance ||
        Number(org.negotiatedActionsAnnual) === actionsAnnual;
      const recorded = !canRecordAllowance
        ? " (allowance column absent — bounded fallback applies)"
        : writeAllowance
          ? `, ${actionsAnnual.toLocaleString("en-US")} actions/yr recorded`
          : `, ${Number(org.negotiatedActionsAnnual).toLocaleString("en-US")} actions/yr left as recorded (pass --actions-annual to change it)`;

      if (tierIsSet && allowanceIsSet) {
        console.log(
          `      tier            : already enterprise/active${recorded}`,
        );
      } else if (DRY_RUN) {
        console.log(
          kleur.blue(
            `      tier            : would set plan_type '${org.planType}' → 'enterprise', status '${org.status}' → 'active'${
              writeAllowance
                ? `, negotiated_actions_annual ${org.negotiatedActionsAnnual ?? "NULL"} → ${actionsAnnual}`
                : canRecordAllowance
                  ? `, negotiated_actions_annual left at ${org.negotiatedActionsAnnual}`
                  : " (allowance column absent — skipped)"
            }`,
          ),
        );
      } else {
        await withSystemDb((tx) =>
          tx
            .update(schema.organizations)
            .set({
              planType: "enterprise",
              status: "active",
              ...(writeAllowance
                ? { negotiatedActionsAnnual: BigInt(actionsAnnual) }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(schema.organizations.id, org.id)),
        );
        console.log(
          kleur.green(`      tier            : enterprise/active${recorded}`),
        );
      }

      // ── 3. Billing settings: no assistant cap, no dunning hold ─────────────
      const [settings] = await withSystemDb((tx) =>
        tx
          .select({
            id: schema.orgBillingSettings.id,
            assistantSpendCapCents:
              schema.orgBillingSettings.assistantSpendCapCents,
            dunningState: schema.orgBillingSettings.dunningState,
          })
          .from(schema.orgBillingSettings)
          .where(eq(schema.orgBillingSettings.orgId, org.id))
          .limit(1),
      );

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
          await withSystemDb((tx) =>
            tx
              .update(schema.orgBillingSettings)
              .set(clear)
              .where(eq(schema.orgBillingSettings.id, settings.id)),
          );
        } else {
          await withSystemDb((tx) =>
            tx
              .insert(schema.orgBillingSettings)
              .values({ orgId: org.id, ...clear }),
          );
        }
        console.log(
          kleur.green(
            `      billing settings: assistant cap cleared, dunning active, auto-reload off`,
          ),
        );
      }

      // ── 4. Spend-budget ceilings ───────────────────────────────────────────
      const enabledBudgets = await withSystemDb((tx) =>
        tx
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
        await withSystemDb((tx) =>
          tx
            .update(schema.spendBudgets)
            .set({ enabled: false, updatedAt: new Date() })
            .where(
              and(
                eq(schema.spendBudgets.orgId, org.id),
                eq(schema.spendBudgets.enabled, true),
              ),
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
      const lots = await withSystemDb((tx) =>
        tx
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
        const [ws] = await withSystemDb((tx) =>
          tx
            .select({ id: schema.workspaces.id })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.orgId, org.id))
            .limit(1),
        );

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

      // IAM readiness was checked in step 2, before anything was written. A
      // warning printed here could only tell the operator about a lockout the
      // run had already caused.
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
