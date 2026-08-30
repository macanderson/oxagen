#!/usr/bin/env tsx
/**
 * stripe-sync — reconcile Stripe products/prices + the billing.plans table to
 * the single source of truth in `@oxagen/billing` (packages/billing/src/pricing.ts).
 *
 *   pnpm billing:stripe-sync                 # report + DRY-RUN (no writes)
 *   pnpm billing:stripe-sync --report        # report only (no Stripe/DB calls)
 *   pnpm billing:stripe-sync --apply         # create/update Stripe + plans
 *   pnpm billing:stripe-sync --margin=0.70   # model a different target margin
 *   pnpm billing:stripe-sync --apply --no-db # Stripe only, skip plans upsert
 *
 * The MAIN OBJECTIVE: change the target margin (flag or OXAGEN_TARGET_MARGIN),
 * re-run with --apply, and every Stripe product's pricing config (included
 * credits, target margin, meter markup, realised margin — all stored on the
 * product/price metadata) is rewritten to hit the new objective. The script
 * prints the exact OXAGEN_METER_MARKUP to set so the runtime gate matches.
 *
 * Idempotent: products are keyed by `metadata.oxagen_slug`, prices by
 * `lookup_key`. Re-running reuses unchanged prices and transfers the lookup key
 * to a new price (archiving the old) only when an amount actually changes —
 * Stripe prices are immutable, so this is the supported "edit a price" path.
 *
 * Runs against whatever STRIPE_SECRET_KEY is in scope — sk_test in dev/preview,
 * sk_live in prod. It prints the mode so you always know which account you hit.
 */
import kleur from "kleur";
import type Stripe from "stripe";
import {
  derivePricing,
  resolveTargetMargin,
  stripeClient,
  SUBSCRIPTION_PLANS,
  CREDIT_PACKS,
  PROVIDER_RATE_CARD,
  type DerivedProduct,
} from "@oxagen/billing";
import { db, schema, closeDatabase } from "@oxagen/database";
import { and, eq, notInArray } from "drizzle-orm";

interface Flags {
  apply: boolean;
  report: boolean;
  noDb: boolean;
  margin: number | null;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    apply: false,
    report: false,
    noDb: false,
    margin: null,
  };
  for (const arg of argv) {
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--report") flags.report = true;
    else if (arg === "--no-db") flags.noDb = true;
    else if (arg.startsWith("--margin=")) {
      const m = Number.parseFloat(arg.slice("--margin=".length));
      if (!Number.isFinite(m) || m <= 0 || m >= 1) {
        throw new Error(`--margin must be in (0,1); got "${arg}"`);
      }
      flags.margin = m;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return flags;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const lookupKey = (slug: string, suffix: string) =>
  `${slug.replace(/-/g, "_")}_${suffix}`;

// ── Report ──────────────────────────────────────────────────────────────────

function printReport(margin: number): ReturnType<typeof derivePricing> {
  const d = derivePricing(margin);

  console.log(kleur.bold().cyan("\n══ Oxagen pricing model ══\n"));
  console.log(
    `  Credit value         ${kleur.bold(`$${d.creditValueUsd.toFixed(4)}`)} (1 credit = 1 cent, locked)`,
  );
  console.log(`  Target blended margin ${kleur.bold(pct(d.targetMargin))}`);
  console.log(
    `  ${kleur.yellow().bold(`Meter markup         ${d.meterMarkup.toFixed(4)}×`)}  (the gate burns credits this fast)`,
  );
  console.log(
    `  Blended margin (calc) ${kleur.bold(pct(d.blendedMargin))}  (== target by construction)\n`,
  );

  console.log(
    kleur.bold("  Cost meter — provider rate card (USD / 1M tokens):"),
  );
  for (const [model, r] of Object.entries(PROVIDER_RATE_CARD)) {
    console.log(
      `    ${model.padEnd(26)} in ${`$${r.inputPer1M}`.padStart(7)}  out ${`$${r.outputPer1M}`.padStart(7)}  cRead ${`$${r.cachedInputPer1M}`.padStart(6)}  cWrite ${`$${r.cacheWritePer1M}`.padStart(6)}  [${r.provider}]`,
    );
  }

  const header = `\n  ${"Product".padEnd(22)}${"Kind".padEnd(14)}${"Price".padStart(9)}${"Credits".padStart(10)}${"cr/¢".padStart(8)}${"Margin".padStart(9)}`;
  console.log(kleur.bold(header));
  console.log("  " + "─".repeat(70));
  for (const p of d.products) {
    const price =
      p.kind === "subscription" ? `${usd(p.priceCents)}/mo` : usd(p.priceCents);
    const marginColor = p.marginPct >= d.targetMargin ? kleur.green : kleur.red;
    console.log(
      `  ${p.displayName.padEnd(22)}${p.kind.padEnd(14)}${price.padStart(9)}${String(p.credits).padStart(10)}${p.creditsPerCent.toFixed(2).padStart(8)}${marginColor(pct(p.marginPct).padStart(9))}`,
    );
  }
  console.log("  " + "─".repeat(70));

  console.log(
    kleur.bold("\n  Set these so the runtime gate matches this report:"),
  );
  console.log(kleur.green(`    OXAGEN_TARGET_MARGIN=${d.targetMargin}`));
  console.log(
    kleur.green(`    OXAGEN_METER_MARKUP=${d.meterMarkup.toFixed(4)}`),
  );
  console.log();
  return d;
}

// ── Stripe reconcile ──────────────────────────────────────────────────────────

const SyncAction = {
  CREATE: "create",
  UPDATE: "update",
  REUSE: "reuse",
} as const;
type SyncAction = (typeof SyncAction)[keyof typeof SyncAction];

function actionLabel(a: SyncAction): string {
  if (a === "create") return kleur.green("CREATE");
  if (a === "update") return kleur.yellow("UPDATE");
  return kleur.dim("reuse ");
}

async function findProductBySlug(
  stripe: Stripe,
  slug: string,
): Promise<Stripe.Product | null> {
  try {
    const found = await stripe.products.search({
      query: `metadata['oxagen_slug']:'${slug}'`,
      limit: 1,
    });
    if (found.data[0]) return found.data[0];
  } catch {
    // Search API unavailable / not indexed yet — fall back to a bounded list scan.
  }
  for await (const product of stripe.products.list({
    limit: 100,
    active: true,
  })) {
    if (product.metadata?.oxagen_slug === slug) return product;
  }
  return null;
}

async function ensureProduct(
  stripe: Stripe,
  args: {
    slug: string;
    name: string;
    metadata: Record<string, string>;
    apply: boolean;
  },
): Promise<{ id: string; action: SyncAction }> {
  const existing = await findProductBySlug(stripe, args.slug);
  const params: Stripe.ProductUpdateParams & Stripe.ProductCreateParams = {
    name: args.name,
    active: true,
    metadata: {
      oxagen_slug: args.slug,
      oxagen_version: "v2",
      ...args.metadata,
    },
  };
  if (existing) {
    if (args.apply) await stripe.products.update(existing.id, params);
    return { id: existing.id, action: SyncAction.UPDATE };
  }
  if (!args.apply)
    return { id: `prod_DRYRUN_${args.slug}`, action: SyncAction.CREATE };
  const created = await stripe.products.create(params);
  return { id: created.id, action: SyncAction.CREATE };
}

async function ensurePrice(
  stripe: Stripe,
  args: {
    productId: string;
    lookupKey: string;
    unitAmount: number;
    recurring?: Stripe.PriceCreateParams.Recurring;
    metadata: Record<string, string>;
    apply: boolean;
  },
): Promise<{ id: string; action: SyncAction }> {
  const found = await stripe.prices.list({
    lookup_keys: [args.lookupKey],
    active: true,
    limit: 1,
  });
  const existing = found.data[0];
  const intervalMatches =
    (existing?.recurring?.interval ?? undefined) ===
    (args.recurring?.interval ?? undefined);
  if (existing && existing.unit_amount === args.unitAmount && intervalMatches) {
    return { id: existing.id, action: SyncAction.REUSE };
  }
  if (!args.apply) {
    return {
      id: existing?.id ?? `price_DRYRUN_${args.lookupKey}`,
      action: existing ? SyncAction.UPDATE : SyncAction.CREATE,
    };
  }
  const created = await stripe.prices.create({
    product: args.productId,
    currency: "usd",
    unit_amount: args.unitAmount,
    recurring: args.recurring,
    lookup_key: args.lookupKey,
    // Stripe prices are immutable; move the lookup key off the stale price.
    transfer_lookup_key: Boolean(existing),
    metadata: args.metadata,
  });
  if (existing) await stripe.prices.update(existing.id, { active: false });
  return {
    id: created.id,
    action: existing ? SyncAction.UPDATE : SyncAction.CREATE,
  };
}

interface SyncedPlan {
  slug: string;
  productId: string;
  priceIdMonthly: string;
  priceIdAnnual: string;
}

async function syncStripe(
  stripe: Stripe,
  derivation: ReturnType<typeof derivePricing>,
  apply: boolean,
): Promise<SyncedPlan[]> {
  const bySlug = new Map(derivation.products.map((p) => [p.slug, p]));
  // derivePricing() is expected to cover every catalog slug. If it ever stops
  // doing so, say which slug went missing — the alternative is a bare
  // "Cannot read properties of undefined (reading 'marginPct')" halfway through
  // a --apply run that has already written to Stripe.
  const derived = (slug: string): DerivedProduct => {
    const d = bySlug.get(slug);
    if (!d) {
      throw new Error(
        `pricing model has no derived product for slug "${slug}" — ` +
          "packages/billing/src/pricing.ts and the plan/pack catalog have diverged",
      );
    }
    return d;
  };
  const sharedMeta = {
    oxagen_target_margin: String(derivation.targetMargin),
    oxagen_meter_markup: derivation.meterMarkup.toFixed(6),
  };
  console.log(
    kleur.bold().cyan(`\n══ Stripe ${apply ? "APPLY" : "DRY-RUN"} ══\n`),
  );
  const synced: SyncedPlan[] = [];

  for (const plan of SUBSCRIPTION_PLANS) {
    const d = derived(plan.slug);
    const product = await ensureProduct(stripe, {
      slug: plan.slug,
      name: plan.displayName,
      apply,
      metadata: {
        ...sharedMeta,
        oxagen_kind: "subscription",
        oxagen_tier: plan.tier,
        included_credits: String(plan.includedCredits),
        margin_pct: d.marginPct.toFixed(4),
      },
    });
    const priceMeta = {
      ...sharedMeta,
      included_credits: String(plan.includedCredits),
    };
    const monthly = await ensurePrice(stripe, {
      productId: product.id,
      lookupKey: lookupKey(plan.slug, "month"),
      unitAmount: plan.monthlyCents,
      recurring: { interval: "month" },
      metadata: priceMeta,
      apply,
    });
    const annual = await ensurePrice(stripe, {
      productId: product.id,
      lookupKey: lookupKey(plan.slug, "year"),
      unitAmount: plan.annualCents,
      recurring: { interval: "year" },
      metadata: priceMeta,
      apply,
    });
    console.log(
      `  ${actionLabel(product.action)} ${kleur.bold(plan.displayName.padEnd(20))} ${kleur.dim(plan.slug)}\n` +
        `         monthly ${actionLabel(monthly.action)} ${usd(plan.monthlyCents)}  annual ${actionLabel(annual.action)} ${usd(plan.annualCents)}  · ${plan.includedCredits} cr/mo · margin ${pct(d.marginPct)}`,
    );
    synced.push({
      slug: plan.slug,
      productId: product.id,
      priceIdMonthly: monthly.id,
      priceIdAnnual: annual.id,
    });
  }

  for (const pack of CREDIT_PACKS) {
    const d = derived(pack.slug);
    const product = await ensureProduct(stripe, {
      slug: pack.slug,
      name: pack.displayName,
      apply,
      metadata: {
        ...sharedMeta,
        oxagen_kind: "credit_pack",
        credits: String(pack.credits),
        margin_pct: d.marginPct.toFixed(4),
      },
    });
    const price = await ensurePrice(stripe, {
      productId: product.id,
      lookupKey: lookupKey(pack.slug, "onetime"),
      unitAmount: pack.priceCents,
      // No `recurring` → one-time price.
      metadata: { ...sharedMeta, credits: String(pack.credits) },
      apply,
    });
    console.log(
      `  ${actionLabel(product.action)} ${kleur.bold(pack.displayName.padEnd(20))} ${kleur.dim(pack.slug)}\n` +
        `         one-time ${actionLabel(price.action)} ${usd(pack.priceCents)}  · ${pack.credits} credits · margin ${pct(d.marginPct)}`,
    );
  }

  return synced;
}

// ── billing.plans upsert ──────────────────────────────────────────────────────

async function upsertPlans(
  synced: SyncedPlan[],
  apply: boolean,
): Promise<void> {
  console.log(
    kleur
      .bold()
      .cyan(`\n══ billing.plans ${apply ? "UPSERT" : "DRY-RUN"} ══\n`),
  );
  const d = db();
  for (const plan of SUBSCRIPTION_PLANS) {
    const s = synced.find((x) => x.slug === plan.slug);
    if (!s) continue;
    const row = {
      name: plan.displayName,
      slug: plan.slug,
      tier: plan.tier,
      stripeProductId: s.productId,
      stripePriceIdMonthly: s.priceIdMonthly,
      stripePriceIdAnnual: s.priceIdAnnual,
      monthlyCents: plan.monthlyCents,
      annualCents: plan.annualCents,
      // 1 credit = 1 cent → included credit count == included credit cents.
      includedCreditCents: plan.includedCredits,
      includedSeats: plan.seats,
      features: plan.features,
      isPublic: true,
    };
    if (!apply) {
      console.log(
        `  ${kleur.dim("would upsert")} ${plan.slug} → product ${s.productId}`,
      );
      continue;
    }
    await d
      .insert(schema.plans)
      .values(row)
      .onConflictDoUpdate({
        target: schema.plans.slug,
        set: {
          name: row.name,
          tier: row.tier,
          stripeProductId: row.stripeProductId,
          stripePriceIdMonthly: row.stripePriceIdMonthly,
          stripePriceIdAnnual: row.stripePriceIdAnnual,
          monthlyCents: row.monthlyCents,
          annualCents: row.annualCents,
          includedCreditCents: row.includedCreditCents,
          includedSeats: row.includedSeats,
          features: row.features,
          updatedAt: new Date(),
        },
      });
    // Confirm the write landed.
    const back = await d.query.plans.findFirst({
      where: eq(schema.plans.slug, plan.slug),
      columns: { id: true, stripeProductId: true },
    });
    console.log(
      `  ${kleur.green("upserted")} ${plan.slug} → plan ${back?.id} (product ${back?.stripeProductId})`,
    );
  }

  // Reconcile deletions. upsertPlans only ever *adds* the canonical plans, so
  // without this step any row that drops out of the source of truth — a legacy
  // pre-`-v2` slug, the seeded `free` tier, an e2e-test plan — lingers with
  // is_public = true and surfaces in the billing UI as a duplicate/unrelated
  // plan. Tombstone (is_public = false) rather than DELETE: subscriptions FK
  // billing.plans, and the row is still needed to name historical plans.
  const canonicalSlugs = SUBSCRIPTION_PLANS.map((p) => p.slug);
  if (apply) {
    const hidden = await d
      .update(schema.plans)
      .set({ isPublic: false, updatedAt: new Date() })
      .where(
        and(
          eq(schema.plans.isPublic, true),
          notInArray(schema.plans.slug, canonicalSlugs),
        ),
      )
      .returning({ slug: schema.plans.slug });
    for (const row of hidden) {
      console.log(
        `  ${kleur.yellow("hidden")}   ${row.slug} (not in source of truth → is_public=false)`,
      );
    }
    if (hidden.length === 0) {
      console.log(kleur.dim("  no stale public plans to hide"));
    }
  } else {
    console.log(
      kleur.dim(
        `  would hide any public plan whose slug ∉ {${canonicalSlugs.join(", ")}}`,
      ),
    );
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const margin = flags.margin ?? resolveTargetMargin();

  const derivation = printReport(margin);
  if (flags.report) return;

  const stripe = stripeClient();
  // Surface which Stripe account we're about to touch — test vs live.
  const mode = process.env.STRIPE_SECRET_KEY?.startsWith("sk_live")
    ? kleur.red().bold("LIVE")
    : kleur.green("test");
  console.log(`  Stripe account mode: ${mode}`);
  if (!flags.apply) {
    console.log(
      kleur.dim(
        "  (dry-run — pass --apply to write. Stripe reads below are non-mutating.)",
      ),
    );
  }

  const synced = await syncStripe(stripe, derivation, flags.apply);

  if (!flags.noDb) {
    await upsertPlans(synced, flags.apply);
  }

  console.log(
    kleur.bold().cyan("\n══ Done ══\n") +
      (flags.apply
        ? "  Stripe + billing.plans now match the pricing model.\n"
        : "  No writes made. Re-run with --apply to reconcile.\n") +
      `  Remember to set OXAGEN_METER_MARKUP=${derivation.meterMarkup.toFixed(4)} in the runtime env.\n`,
  );
}

main()
  .then(() => closeDatabase())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(
      kleur.red("\nstripe-sync failed:"),
      err instanceof Error ? err.message : err,
    );
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
