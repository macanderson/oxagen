#!/usr/bin/env tsx
/**
 * billing-contract-terms: record one organisation's negotiated
 * governed-action terms (ADR-055 §2) through `set_contract_terms`.
 *
 *   pnpm billing:contract-terms --org acme --agreement MSA-2026-014 \
 *     --rate-per-1000-usd 3.00 --block-size 10000 --included-per-month 250000 \
 *     [--from 2026-10-01] [--dry-run]
 *
 * The terms are what an enterprise signed. From `--from` (default: now) they
 * price the admission gate, the recorder, every settlement invoice, and the
 * default rate of a prepaid order; the agreement they replace is closed at
 * that instant. The org's current month bucket keeps the included units it
 * was created with.
 *
 * USD only: the rate flag is in dollars. `set_contract_terms` takes any ISO
 * 4217 currency; invoke it directly for another.
 *
 * Goes through the kernel with a platform-operator binding
 * (lib/platform-operator-run.ts), so the decision leaves the kernel's
 * `capability.invoke_*` row and the handler's `billing.plan_changed` row, both
 * awaited before the process exits. `--dry-run` validates the figures and
 * prints them beside the agreement in force, and writes nothing.
 */
import kleur from "kleur";
import { requireEnv } from "@oxagen/config/env";
import { closeDatabase } from "@oxagen/database";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import { invoke, setSecurityEventEmitter } from "@oxagen/oxagen/kernel";
import { recordSecurityEventAsync } from "@oxagen/telemetry";
import {
  billingContractTermsSet,
  type BillingContractTermsSetOutput,
} from "@oxagen/oxagen/contracts/billing.contract_terms.set";
import {
  assertNegotiatedTerms,
  readPrepaidOrderDefaults,
  type PrepaidOrderDefaults,
} from "@oxagen/billing";
import {
  describeTarget,
  instant,
  invokeAsPlatformOperator,
  readFlags,
  resolveOrgBySlug,
  usdPer1000ToMicros,
  wholeNumber,
  type PlatformOperatorRunDeps,
} from "./lib/platform-operator-run";

const USAGE =
  "usage: pnpm billing:contract-terms --org <slug> --agreement <ref> --rate-per-1000-usd <n> --block-size <n> --included-per-month <n> [--from <date>] [--dry-run]";

export interface ContractTermsFlags {
  orgSlug: string;
  agreementRef: string;
  ratePerGauMicros: bigint;
  blockSizeGau: number;
  includedGauPerMonth: number;
  /** Null: the moment of the call. */
  effectiveFrom: Date | null;
  dryRun: boolean;
}

/** Every figure is required: the operator reading the command back is the only review it gets. */
export function parseContractTermsFlags(argv: string[]): ContractTermsFlags {
  const f = readFlags(
    argv,
    {
      values: [
        "--org",
        "--agreement",
        "--rate-per-1000-usd",
        "--block-size",
        "--included-per-month",
        "--from",
      ],
      switches: ["--dry-run"],
    },
    USAGE,
  );
  const need = (flag: string): string => {
    const v = f.get(flag);
    if (typeof v !== "string") throw new Error(`${flag} is required\n${USAGE}`);
    return v;
  };
  const from = f.get("--from");
  return {
    orgSlug: need("--org"),
    agreementRef: need("--agreement"),
    ratePerGauMicros: usdPer1000ToMicros(
      need("--rate-per-1000-usd"),
      "--rate-per-1000-usd",
    ),
    blockSizeGau: wholeNumber(need("--block-size"), "--block-size", 1),
    includedGauPerMonth: wholeNumber(
      need("--included-per-month"),
      "--included-per-month",
      0,
    ),
    effectiveFrom: typeof from === "string" ? instant(from, "--from") : null,
    dryRun: f.get("--dry-run") === true,
  };
}

export interface ContractTermsRunDeps extends PlatformOperatorRunDeps {
  resolveOrg: (slug: string) => Promise<{ id: string; name: string } | null>;
  /** The agreement in force, for the summary. */
  readDefaults: (orgId: string) => Promise<PrepaidOrderDefaults>;
  log: (line: string) => void;
  now?: () => Date;
}

function dollarsPer1000(micros: bigint): string {
  return `$${(Number(micros) / 1_000).toFixed(Number(micros) % 10 === 0 ? 2 : 3)} per 1,000`;
}

/**
 * Validate, print, and (unless `dryRun`) invoke `set_contract_terms`.
 * Returns the stored terms, or null for a dry run.
 */
export async function runContractTerms(
  flags: ContractTermsFlags,
  deps: ContractTermsRunDeps,
): Promise<BillingContractTermsSetOutput | null> {
  const org = await deps.resolveOrg(flags.orgSlug);
  if (!org) throw new Error(`no organisation with slug "${flags.orgSlug}"`);
  const effectiveFrom = flags.effectiveFrom ?? deps.now?.() ?? new Date();

  // The same check the handler runs, before anything is written.
  assertNegotiatedTerms({
    orgId: org.id,
    agreementRef: flags.agreementRef,
    currency: "usd",
    ratePerGauMicros: flags.ratePerGauMicros,
    blockSizeGau: flags.blockSizeGau,
    includedGauPerMonth: flags.includedGauPerMonth,
    effectiveFrom,
  });

  const current = await deps.readDefaults(org.id);
  const blockCents = Number(
    (flags.ratePerGauMicros * BigInt(flags.blockSizeGau)) / 10_000n,
  );
  deps.log(`  Organisation : ${org.name} (${flags.orgSlug})`);
  deps.log(
    `  In force     : ${current.agreementRef ?? "published tier terms, no agreement"}`,
  );
  deps.log(`  Agreement    : ${flags.agreementRef}`);
  deps.log(
    `  Rate         : ${dollarsPer1000(flags.ratePerGauMicros)} (${flags.ratePerGauMicros} micros a unit)`,
  );
  deps.log(
    `  Block        : ${flags.blockSizeGau.toLocaleString("en-US")} units for $${(blockCents / 100).toFixed(2)}`,
  );
  deps.log(
    `  Included     : ${flags.includedGauPerMonth.toLocaleString("en-US")} units a month, from the next month's bucket`,
  );
  deps.log(`  Effective    : ${effectiveFrom.toISOString()}`);

  if (flags.dryRun) {
    deps.log("\n  Dry run: nothing written.");
    return null;
  }

  const { output } = await invokeAsPlatformOperator(
    {
      capability: billingContractTermsSet.name,
      orgId: org.id,
      input: {
        orgId: org.id,
        agreementRef: flags.agreementRef,
        currency: "usd",
        ratePerGauMicros: flags.ratePerGauMicros.toString(),
        blockSizeGau: flags.blockSizeGau,
        includedGauPerMonth: flags.includedGauPerMonth,
        effectiveFrom: effectiveFrom.toISOString(),
      },
    },
    deps,
  );
  const stored = billingContractTermsSet.output.parse(output);
  deps.log(
    stored.changed
      ? `\n  Stored: ${stored.agreementRef} from ${stored.effectiveFrom}${stored.previous ? `, closing ${stored.previous.agreementRef}` : ""}.`
      : `\n  ${stored.agreementRef} already carries these terms; nothing written.`,
  );
  return stored;
}

async function main(): Promise<void> {
  const flags = parseContractTermsFlags(process.argv.slice(2));
  const env = requireEnv(["DATABASE_URL"]);
  // Echo the target first: this runs against production by hand, and a shell
  // DATABASE_URL beats --env-file.
  console.log(
    `  Target database: ${kleur.yellow(describeTarget(env.DATABASE_URL))}`,
  );
  await import("@oxagen/handlers/register");
  const insert = makeSecurityEventInserter();
  await runContractTerms(flags, {
    resolveOrg: resolveOrgBySlug,
    readDefaults: (orgId) => readPrepaidOrderDefaults(orgId),
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
        kleur.red("\nbilling-contract-terms failed:"),
        err instanceof Error ? err.message : err,
      );
      await closeDatabase().catch(() => {});
      process.exit(1);
    });
}
