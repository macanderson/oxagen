#!/usr/bin/env tsx
/**
 * billing-prepaid-invoice: issue an enterprise's prepaid order on a Stripe
 * invoice through `create_prepaid_invoice` (ADR-158).
 *
 *   pnpm billing:prepaid-invoice --org acme --agreement MSA-2026-014 --po PO-7781 \
 *     --licence-usd 120000 --licence-from 2026-10-01 --licence-to 2027-10-01 \
 *     --gau 2000000 --credits-usd 5000 --assistant-cap-usd 6000 \
 *     --days-until-due 30 [--grant-on issue] [--dry-run]
 *
 * One order, up to three lines: the platform licence for a period
 * (`--licence-to` is the first day after it), governed action units at the
 * contracted rate (`--gau-rate-per-1000-usd` overrides it, and is required
 * when the org has no negotiated terms), and usage credits for the in-app
 * assistant. The units and credits are granted when the invoice is paid, or
 * at once with `--grant-on issue`.
 *
 * The assistant spend cap. Platform-paid assistant turns stop at the org's
 * monthly cap, $20 unless an operator changed it. `--assistant-cap-usd <n>`
 * sets it when the credits are granted, `--assistant-cap-usd none` removes it,
 * and without the flag the cap is left as it is. The summary prints the
 * current cap and warns when the order's credits exceed it.
 *
 * Every run prints the order id before it calls Stripe. If a run fails, re-run
 * the same command with `--order-id <id>`: the order resumes where it stopped
 * and no second invoice is created.
 *
 * USD only: the amount flags are dollars. `create_prepaid_invoice` takes any
 * ISO 4217 currency; invoke it directly for another.
 *
 * `--dry-run` resolves the org's defaults, validates the order and prints its
 * lines and total. It writes nothing and does not call Stripe.
 */
import { randomUUID } from "node:crypto";
import kleur from "kleur";
import { requireEnv } from "@oxagen/config/env";
import { closeDatabase } from "@oxagen/database";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { invoke, setSecurityEventEmitter } from "@oxagen/oxagen/kernel";
import { recordSecurityEventAsync } from "@oxagen/telemetry";
import {
  billingPrepaidInvoiceCreate,
  type BillingPrepaidInvoiceCreateOutput,
} from "@oxagen/oxagen/contracts/billing.prepaid_invoice.create";
import {
  assertPrepaidOrder,
  PREPAID_INVOICE_FOOTER,
  prepaidOrderFigures,
  prepaidOrderLines,
  readAssistantSpendCap,
  readPrepaidOrderDefaults,
  resolvePrepaidOrderSpec,
  type PrepaidOrderDefaults,
  type PrepaidOrderRequest,
} from "@oxagen/billing";
import {
  describeTarget,
  instant,
  invokeAsPlatformOperator,
  readFlags,
  resolveOrgBySlug,
  usdPer1000ToMicros,
  usdToCents,
  wholeNumber,
  type PlatformOperatorRunDeps,
} from "./lib/platform-operator-run";

const USAGE =
  "usage: pnpm billing:prepaid-invoice --org <slug> [--agreement <ref>] [--po <n>] " +
  "[--licence-usd <n> --licence-from <date> --licence-to <date>] [--gau <n> [--gau-rate-per-1000-usd <n>]] " +
  "[--credits-usd <n>] [--assistant-cap-usd <n|none>] [--days-until-due <n>] [--grant-on paid|issue] " +
  "[--memo <text>] [--order-id <uuid>] [--dry-run]";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PrepaidInvoiceFlags {
  orgSlug: string;
  /** The order without its org, which the run resolves from the slug. */
  request: Omit<PrepaidOrderRequest, "orgId">;
  orderId: string | null;
  dryRun: boolean;
}

export function parsePrepaidInvoiceFlags(argv: string[]): PrepaidInvoiceFlags {
  const f = readFlags(
    argv,
    {
      values: [
        "--org",
        "--agreement",
        "--po",
        "--licence-usd",
        "--licence-from",
        "--licence-to",
        "--gau",
        "--gau-rate-per-1000-usd",
        "--credits-usd",
        "--assistant-cap-usd",
        "--days-until-due",
        "--grant-on",
        "--memo",
        "--order-id",
      ],
      switches: ["--dry-run"],
    },
    USAGE,
  );
  const get = (flag: string): string | undefined => {
    const v = f.get(flag);
    return typeof v === "string" ? v : undefined;
  };

  const orgSlug = get("--org");
  if (!orgSlug) throw new Error(`--org is required\n${USAGE}`);

  const licenceFlags = ["--licence-usd", "--licence-from", "--licence-to"].map(
    get,
  );
  const licenceGiven = licenceFlags.filter((v) => v !== undefined).length;
  if (licenceGiven !== 0 && licenceGiven !== 3) {
    throw new Error(
      `--licence-usd, --licence-from and --licence-to are given together\n${USAGE}`,
    );
  }
  const [licenceUsd, licenceFrom, licenceTo] = licenceFlags;

  const gau = get("--gau");
  const gauRate = get("--gau-rate-per-1000-usd");
  if (gauRate !== undefined && gau === undefined) {
    throw new Error(`--gau-rate-per-1000-usd needs --gau\n${USAGE}`);
  }

  const cap = get("--assistant-cap-usd");
  const grantOn = get("--grant-on") ?? "paid";
  if (grantOn !== "paid" && grantOn !== "issue") {
    throw new Error(`--grant-on must be "paid" or "issue"\n${USAGE}`);
  }
  const orderId = get("--order-id") ?? null;
  if (orderId !== null && !UUID_RE.test(orderId)) {
    throw new Error(
      `--order-id must be the uuid an earlier run printed; got "${orderId}"`,
    );
  }
  const credits = get("--credits-usd");
  const agreementRef = get("--agreement");
  const poNumber = get("--po");
  const memo = get("--memo");

  return {
    orgSlug,
    orderId,
    dryRun: f.get("--dry-run") === true,
    request: {
      ...(agreementRef !== undefined ? { agreementRef } : {}),
      ...(poNumber !== undefined ? { poNumber } : {}),
      currency: "usd",
      ...(licenceGiven === 3
        ? {
            licence: {
              amountCents: usdToCents(licenceUsd!, "--licence-usd"),
              periodStart: instant(licenceFrom!, "--licence-from"),
              periodEnd: instant(licenceTo!, "--licence-to"),
            },
          }
        : {}),
      ...(gau !== undefined
        ? {
            gau: {
              quantity: wholeNumber(gau, "--gau", 1),
              ...(gauRate !== undefined
                ? {
                    ratePerGauMicros: usdPer1000ToMicros(
                      gauRate,
                      "--gau-rate-per-1000-usd",
                    ),
                  }
                : {}),
            },
          }
        : {}),
      ...(credits !== undefined
        ? { creditsCents: usdToCents(credits, "--credits-usd") }
        : {}),
      daysUntilDue: wholeNumber(
        get("--days-until-due") ?? "30",
        "--days-until-due",
        0,
      ),
      grantOn,
      ...(memo !== undefined ? { memo } : {}),
      ...(cap !== undefined
        ? {
            assistantSpendCapCents:
              cap === "none" ? null : usdToCents(cap, "--assistant-cap-usd"),
          }
        : {}),
    },
  };
}

export interface PrepaidInvoiceRunDeps extends PlatformOperatorRunDeps {
  resolveOrg: (slug: string) => Promise<{ id: string; name: string } | null>;
  readDefaults: (orgId: string) => Promise<PrepaidOrderDefaults>;
  readAssistantSpendCap: (orgId: string) => Promise<number | null>;
  newOrderId: () => string;
  log: (line: string) => void;
}

const usd = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * The lines about the assistant cap: what it is now, what the order will do
 * to it, and a warning when the order's credits outrun a cap it leaves alone.
 */
export function assistantCapLines(
  creditCents: number,
  currentCapCents: number | null,
  requested: number | null | undefined,
): string[] {
  const now =
    currentCapCents === null ? "no cap" : `${usd(currentCapCents)} a month`;
  const lines = [`  Assistant cap: ${now} now`];
  if (requested !== undefined) {
    lines.push(
      `                 set to ${requested === null ? "no cap" : `${usd(requested)} a month`} when the credits are granted`,
    );
    return lines;
  }
  lines.push("                 unchanged by this order");
  if (
    creditCents > 0 &&
    currentCapCents !== null &&
    creditCents > currentCapCents
  ) {
    lines.push(
      `  Warning      : the order grants ${usd(creditCents)} of assistant credits and the cap stops platform-paid turns at ${usd(currentCapCents)} a month. Pass --assistant-cap-usd <n|none> to change it, or set it later with pnpm billing:terms --assistant-cap-usd.`,
    );
  }
  return lines;
}

/**
 * Resolve, validate, print, and (unless `dryRun`) issue the order. Returns
 * the issued order, or null for a dry run.
 */
export async function runPrepaidInvoice(
  flags: PrepaidInvoiceFlags,
  deps: PrepaidInvoiceRunDeps,
): Promise<BillingPrepaidInvoiceCreateOutput | null> {
  const org = await deps.resolveOrg(flags.orgSlug);
  if (!org) throw new Error(`no organisation with slug "${flags.orgSlug}"`);

  const [defaults, currentCap] = await Promise.all([
    deps.readDefaults(org.id),
    deps.readAssistantSpendCap(org.id),
  ]);
  if (defaults.currency !== "usd") {
    throw new Error(
      `the org's terms are in ${defaults.currency}; this script invoices in USD. Invoke create_prepaid_invoice directly.`,
    );
  }
  // The same resolution and checks the handler runs, before anything is written.
  const spec = resolvePrepaidOrderSpec(
    { orgId: org.id, ...flags.request },
    defaults,
  );
  assertPrepaidOrder(spec);
  const lines = prepaidOrderLines(prepaidOrderFigures(spec));
  const total = lines.reduce((sum, l) => sum + l.amountCents, 0);

  deps.log(`  Organisation : ${org.name} (${flags.orgSlug})`);
  deps.log(`  Agreement    : ${spec.agreementRef ?? "(none)"}`);
  deps.log(`  PO number    : ${spec.poNumber ?? "(none)"}`);
  for (const line of lines) {
    deps.log(`  Line         : ${line.description}  ${usd(line.amountCents)}`);
  }
  deps.log(
    `  Total        : ${usd(total)}, due ${spec.daysUntilDue} days after it is sent`,
  );
  deps.log(
    `  Grant        : ${spec.grantOn === "issue" ? "when the invoice is sent" : "when the invoice is paid"}`,
  );
  for (const line of assistantCapLines(
    spec.creditCents,
    currentCap,
    flags.request.assistantSpendCapCents,
  )) {
    deps.log(line);
  }
  deps.log(`  Footer       : ${PREPAID_INVOICE_FOOTER}`);

  if (flags.dryRun) {
    deps.log("\n  Dry run: nothing written, Stripe not called.");
    return null;
  }

  const orderId = flags.orderId ?? deps.newOrderId();
  deps.log(
    `\n  Order id     : ${orderId}\n  If this run fails, re-run the same command with --order-id ${orderId} to resume it.`,
  );

  const r = flags.request;
  const { output } = await invokeAsPlatformOperator(
    {
      capability: billingPrepaidInvoiceCreate.name,
      orgId: org.id,
      input: {
        orgId: org.id,
        orderId,
        ...(r.agreementRef !== undefined
          ? { agreementRef: r.agreementRef }
          : {}),
        ...(r.poNumber !== undefined ? { poNumber: r.poNumber } : {}),
        currency: "usd",
        ...(r.licence
          ? {
              licence: {
                amountCents: r.licence.amountCents,
                periodStart: r.licence.periodStart.toISOString(),
                periodEnd: r.licence.periodEnd.toISOString(),
              },
            }
          : {}),
        ...(r.gau
          ? {
              gau: {
                quantity: r.gau.quantity,
                ...(r.gau.ratePerGauMicros !== undefined
                  ? { ratePerGauMicros: r.gau.ratePerGauMicros.toString() }
                  : {}),
              },
            }
          : {}),
        ...(r.creditsCents !== undefined
          ? { creditsCents: r.creditsCents }
          : {}),
        daysUntilDue: r.daysUntilDue,
        grantOn: r.grantOn,
        ...(r.memo !== undefined ? { memo: r.memo } : {}),
        ...(r.assistantSpendCapCents !== undefined
          ? { assistantSpendCapCents: r.assistantSpendCapCents }
          : {}),
      },
    },
    deps,
  );
  const issued = billingPrepaidInvoiceCreate.output.parse(output);
  deps.log(
    `\n  ${issued.resumed ? "Resumed" : "Issued"}: invoice ${issued.invoiceNumber ?? issued.stripeInvoiceId ?? "(none)"}, ${issued.status}`,
  );
  if (issued.hostedInvoiceUrl)
    deps.log(`  Hosted page  : ${issued.hostedInvoiceUrl}`);
  if (issued.grant) {
    deps.log(
      `  Granted      : ${issued.grant.unitsGranted.toLocaleString("en-US")} units, ${usd(issued.grant.creditsGrantedCents)} of credits`,
    );
  }
  return issued;
}

async function main(): Promise<void> {
  const flags = parsePrepaidInvoiceFlags(process.argv.slice(2));
  const env = requireEnv(["DATABASE_URL"]);
  console.log(
    `  Target database: ${kleur.yellow(describeTarget(env.DATABASE_URL))}`,
  );
  await import("@oxagen/handlers/register");
  const insert = makeSecurityEventInserter();
  await runPrepaidInvoice(flags, {
    resolveOrg: resolveOrgBySlug,
    readDefaults: (orgId) => readPrepaidOrderDefaults(orgId),
    readAssistantSpendCap,
    newOrderId: randomUUID,
    invoke: (name, input, ctx) => invoke(name, input, ctx),
    setSecurityEventEmitter,
    recordSecurityEvent: (event) => recordSecurityEventAsync(insert, event),
    log: (line) => console.log(line),
  });
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch(async (err: unknown) => {
      console.error(
        kleur.red("\nbilling-prepaid-invoice failed:"),
        err instanceof Error ? err.message : err,
      );
      await closeDatabase().catch(() => {});
      process.exit(1);
    });
}
