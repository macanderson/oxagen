#!/usr/bin/env tsx
/**
 * billing-terms — set one organisation's commercial billing terms
 * (apps/app/ARCHITECTURE.md §3.9 item 12, ADR-055 §5).
 *
 *   pnpm billing:terms --org acme --invoice-billing on  --invoice-gau-max 250000
 *   pnpm billing:terms --org acme --invoice-billing off --invoice-gau-max 100000
 *   pnpm billing:terms --org acme --assistant-cap-usd 6000
 *   pnpm billing:terms --org acme --assistant-cap-usd none
 *
 * `--assistant-cap-usd` sets the org's monthly cap on assistant tokens the
 * platform key pays for (ADR-053 §3): dollars a month, or `none` for no cap.
 * The column defaults to $20 and the app has no control for it, so an
 * enterprise that prepays assistant credits needs an operator to raise it.
 * A run sets the billing mode (its two flags together), the cap, or both.
 *
 * Approving an organisation for invoice billing is a credit decision: from
 * then on it consumes governed action units without a cap and is invoiced
 * afterwards. There is no customer-facing path to it and no admin console —
 * the decision is made by a person at Oxagen, and this script is how they make
 * it, run against the production DATABASE_URL from Parameter Store the way
 * `pnpm billing:stripe-sync` and db-migrate.yml are.
 *
 * It goes through the kernel rather than writing the row itself, so the
 * decision leaves the same two audit rows as every other governed write: the
 * kernel's `capability.invoke_allowed` / `invoke_denied` row, written by the
 * emitter this script registers (the API and MCP servers register theirs at
 * bootstrap; nothing does it for a script), and the handler's
 * `billing.plan_changed` row. The run awaits both before the pool closes and
 * the process exits. The capability (`set_org_billing_terms`) is
 * `platformOnly`, which the kernel refuses without a binding minted by
 * `createPlatformOperatorContext`; this script is the only place that mints
 * one (INV-31, packages/oxagen/src/test/platform-operator-field.test.ts).
 *
 * `surface` is the CapabilityContext field, not `opts.surface`: the contract
 * declares `surfaces: []`, and any `opts.surface` would be refused as
 * `surface_denied` before the handler ran.
 *
 * The organisation is named by slug, because a slug is what a person has; the
 * lookup runs on withSystemDb, since the operator is not inside the tenant.
 */
import { randomUUID } from "node:crypto";
import kleur from "kleur";
import { requireEnv } from "@oxagen/config/env";
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { makeSecurityEventInserter } from "@oxagen/database/security";
import {
  invoke,
  setSecurityEventEmitter,
  type KernelSecurityEvent,
} from "@oxagen/oxagen/kernel";
import { createPlatformOperatorContext } from "@oxagen/oxagen/platform-operator";
import {
  recordSecurityEventAsync,
  type SecurityEventInput,
} from "@oxagen/telemetry";
import {
  billingOrgTermsSet,
  type BillingOrgTermsSetOutput,
} from "@oxagen/oxagen/contracts/billing.org_terms.set";
import type { CapabilityContext } from "@oxagen/oxagen";
import { usdToCents } from "./lib/platform-operator-run";

// ── Flags ─────────────────────────────────────────────────────────────────────

export interface BillingTermsFlags {
  /** The organisation's slug, as a person knows it. */
  orgSlug: string;
  /** `--invoice-billing on|off`; given with `invoiceGauMax` or not at all. */
  approvedForInvoiceBilling?: boolean;
  /** `--invoice-gau-max <n>`; the contract bounds it at 1…100,000,000. */
  invoiceGauMax?: number;
  /** `--assistant-cap-usd <n|none>` in cents; null is no cap; absent leaves it alone. */
  assistantSpendCapCents?: number | null;
}

const USAGE =
  "usage: pnpm billing:terms --org <slug> [--invoice-billing on|off --invoice-gau-max <n>] [--assistant-cap-usd <n|none>]";

/**
 * Parse the flags. The billing mode's two flags are given together: a mode
 * without its ceiling would make "what did I just set" depend on the stored
 * row, and the operator reading the command back is the only review this
 * decision gets. The cap stands on its own. A run sets at least one.
 */
export function parseFlags(argv: string[]): BillingTermsFlags {
  let orgSlug: string | null = null;
  let invoiceBilling: string | null = null;
  let invoiceGauMaxRaw: string | null = null;
  let assistantCapRaw: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${arg} needs a value\n${USAGE}`);
      }
      i += 1;
      return next;
    };
    if (arg === "--org") orgSlug = value();
    else if (arg === "--invoice-billing") invoiceBilling = value();
    else if (arg === "--invoice-gau-max") invoiceGauMaxRaw = value();
    else if (arg === "--assistant-cap-usd") assistantCapRaw = value();
    else throw new Error(`unknown flag: ${arg}\n${USAGE}`);
  }

  if (!orgSlug) throw new Error(`--org is required\n${USAGE}`);
  const flags: BillingTermsFlags = { orgSlug };

  if (invoiceBilling !== null || invoiceGauMaxRaw !== null) {
    if (invoiceBilling === null || invoiceGauMaxRaw === null) {
      throw new Error(
        `--invoice-billing and --invoice-gau-max are given together\n${USAGE}`,
      );
    }
    if (invoiceBilling !== "on" && invoiceBilling !== "off") {
      throw new Error(`--invoice-billing must be "on" or "off"\n${USAGE}`);
    }
    const invoiceGauMax = Number(invoiceGauMaxRaw);
    if (!Number.isInteger(invoiceGauMax) || invoiceGauMax < 1) {
      throw new Error(
        `--invoice-gau-max must be a whole number >= 1; got "${invoiceGauMaxRaw}"\n${USAGE}`,
      );
    }
    flags.approvedForInvoiceBilling = invoiceBilling === "on";
    flags.invoiceGauMax = invoiceGauMax;
  }

  if (assistantCapRaw !== null) {
    flags.assistantSpendCapCents =
      assistantCapRaw === "none"
        ? null
        : usdToCents(assistantCapRaw, "--assistant-cap-usd");
  }

  if (
    flags.approvedForInvoiceBilling === undefined &&
    flags.assistantSpendCapCents === undefined
  ) {
    throw new Error(
      `nothing to set: give --invoice-billing and --invoice-gau-max, --assistant-cap-usd, or both\n${USAGE}`,
    );
  }
  return flags;
}

// ── The run ───────────────────────────────────────────────────────────────────

/**
 * What the run needs from the outside: the slug lookup, the kernel, the
 * kernel's emitter hook and the audit inserter.
 */
interface BillingTermsDeps {
  resolveOrgId: (slug: string) => Promise<string | null>;
  invoke: (
    name: string,
    input: unknown,
    ctx: CapabilityContext,
  ) => Promise<unknown>;
  /** The kernel's `setSecurityEventEmitter`; the run registers before it invokes. */
  setSecurityEventEmitter: (
    emitter: (event: KernelSecurityEvent) => void,
  ) => void;
  /** Writes one `security_events` row; the run awaits every row it produces. */
  recordSecurityEvent: (event: SecurityEventInput) => Promise<void>;
  /** Injected so a test can pin the correlation key. */
  requestId?: string;
}

/**
 * The kernel's authz outcome as a `security_events` row, the mapping
 * apps/api/src/bootstrap.ts registers. `orgId` is the organisation the
 * decision is about: the context carries no tenant (`ctx.orgId` is ""), and
 * the column is a non-null uuid.
 */
function kernelAuditRow(
  event: KernelSecurityEvent,
  orgId: string,
): SecurityEventInput {
  return {
    eventType:
      event.outcome === "allow"
        ? "capability.invoke_allowed"
        : event.outcome === "deny"
          ? "capability.invoke_denied"
          : "capability.invoke_error",
    actorUserId: event.actorUserId,
    orgId,
    workspaceId: null,
    capability: event.capability,
    outcome: event.outcome,
    ip: null,
    userAgent: null,
    requestId: event.requestId,
  };
}

/**
 * Resolve the slug, register the kernel's audit emitter, mint a
 * platform-operator binding, and invoke the capability. Every audit row the
 * kernel emits is awaited before the run settles, on the deny path too. The
 * returned row is what the database holds afterwards.
 */
export async function runBillingTerms(
  flags: BillingTermsFlags,
  deps: BillingTermsDeps,
): Promise<BillingOrgTermsSetOutput> {
  const orgId = await deps.resolveOrgId(flags.orgSlug);
  if (!orgId) throw new Error(`no organisation with slug "${flags.orgSlug}"`);

  const audits: Promise<void>[] = [];
  deps.setSecurityEventEmitter((event) => {
    audits.push(deps.recordSecurityEvent(kernelAuditRow(event, orgId)));
  });

  const requestId = deps.requestId ?? randomUUID();
  const ctx: CapabilityContext = {
    // No tenant: the capability is unscoped and the operator is not a member
    // of the organisation whose terms are being set.
    orgId: "",
    workspaceId: "",
    userId: null,
    apiKeyId: null,
    requestId,
    surface: "runner",
    messageId: null,
    platformOperator: createPlatformOperatorContext({ requestId }),
  };

  let output: unknown;
  try {
    output = await deps.invoke(
      billingOrgTermsSet.name,
      {
        orgId,
        ...(flags.approvedForInvoiceBilling !== undefined
          ? {
              approvedForInvoiceBilling: flags.approvedForInvoiceBilling,
              invoiceGauMax: flags.invoiceGauMax,
            }
          : {}),
        ...(flags.assistantSpendCapCents !== undefined
          ? { assistantSpendCapCents: flags.assistantSpendCapCents }
          : {}),
      },
      ctx,
    );
  } finally {
    await Promise.all(audits);
  }
  return billingOrgTermsSet.output.parse(output);
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

/** A cap in cents as the operator typed it: dollars a month, or no cap. */
export function formatCap(capCents: number | null): string {
  return capCents === null
    ? "no cap"
    : `$${(capCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} a month`;
}

/** Host and database of the target, with any credentials stripped. */
export function describeTarget(raw: string): string {
  try {
    const url = new URL(raw);
    const database = url.pathname.replace(/^\//, "") || "(default)";
    return `${url.hostname}:${url.port || "5432"}/${database}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const env = requireEnv(["DATABASE_URL"]);

  // Echo the target before the write: this script is run against production by
  // hand, and a shell DATABASE_URL beats --env-file.
  console.log(
    `  Target database: ${kleur.yellow(describeTarget(env.DATABASE_URL))}`,
  );
  console.log(`  Organisation   : ${kleur.yellow(flags.orgSlug)}`);
  if (flags.approvedForInvoiceBilling !== undefined) {
    console.log(
      `  Invoice billing: ${flags.approvedForInvoiceBilling ? kleur.red("ON") : kleur.green("off")}\n` +
        `  Interim ceiling: ${kleur.yellow((flags.invoiceGauMax ?? 0).toLocaleString("en-US"))} GAUs`,
    );
  }
  if (flags.assistantSpendCapCents !== undefined) {
    console.log(
      `  Assistant cap  : ${kleur.yellow(formatCap(flags.assistantSpendCapCents))}`,
    );
  }
  console.log("");

  // The kernel dispatches through the handler registry; without this import
  // the capability has a contract and no handler.
  await import("@oxagen/handlers/register");

  const insert = makeSecurityEventInserter();
  const stored = await runBillingTerms(flags, {
    resolveOrgId: async (slug) => {
      const row = await withSystemDb((tx) =>
        tx.query.organizations.findFirst({
          where: eq(schema.organizations.slug, slug),
          columns: { id: true },
        }),
      );
      return row?.id ?? null;
    },
    invoke: (name, input, ctx) => invoke(name, input, ctx),
    setSecurityEventEmitter,
    recordSecurityEvent: (event) => recordSecurityEventAsync(insert, event),
  });

  console.log(
    kleur.bold().cyan("  Stored:") +
      ` org ${stored.orgId}, invoice billing ${stored.approvedForInvoiceBilling ? "on" : "off"}, ceiling ${stored.invoiceGauMax.toLocaleString("en-US")} GAUs, assistant cap ${formatCap(stored.assistantSpendCapCents)}\n`,
  );
}

// Run only when invoked directly, so a test can import parseFlags and
// runBillingTerms without the script reconciling anything as a side effect
// (the same guard stripe-sync.ts carries, and for the same reason).
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch(async (err: unknown) => {
      console.error(
        kleur.red("\nbilling-terms failed:"),
        err instanceof Error ? err.message : err,
      );
      await closeDatabase().catch(() => {});
      process.exit(1);
    });
}
