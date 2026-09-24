/**
 * platform-operator-run.ts: what an operator script needs to invoke a
 * `platformOnly` capability, in one place.
 *
 * `pnpm billing:contract-terms` and `pnpm billing:prepaid-invoice` each make
 * one commercial decision for one organisation, through the kernel, so the
 * decision leaves the same audit rows as every other governed write. That
 * takes four steps every such script repeats, and each one is load-bearing:
 *
 *   1. resolve the organisation by slug on withSystemDb (the operator is not
 *      inside the tenant);
 *   2. register the kernel's security-event emitter before the invoke (the API
 *      and MCP servers register theirs at bootstrap; nothing does it for a
 *      script, and without it the kernel's `capability.invoke_*` row is never
 *      written);
 *   3. mint a platform-operator binding for the run and invoke with
 *      `surface: "runner"` on the context and no `opts.surface`, which a
 *      contract with `surfaces: []` would refuse;
 *   4. await every audit row before the run settles, on the deny path too,
 *      because the script closes the pool and exits right after.
 *
 * This module is the one place outside packages/oxagen besides
 * billing-terms.ts and run-outcomes-access.ts that mints the binding
 * (INV-31, packages/oxagen/src/test/platform-operator-field.test.ts).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import type { CapabilityContext } from "@oxagen/oxagen";
import type { KernelSecurityEvent } from "@oxagen/oxagen/kernel";
import { createPlatformOperatorContext } from "@oxagen/oxagen/platform-operator";
import type { SecurityEventInput } from "@oxagen/telemetry";

// ── Flags ─────────────────────────────────────────────────────────────────────

/**
 * Read `--flag value` pairs and bare `--switch`es. Every flag must be named in
 * `known`; a value may not start with `--`, so a forgotten value is refused
 * rather than swallowing the next flag.
 */
export function readFlags(
  argv: string[],
  known: { values: readonly string[]; switches?: readonly string[] },
  usage: string,
): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (known.switches?.includes(arg)) {
      out.set(arg, true);
      continue;
    }
    if (!known.values.includes(arg)) {
      throw new Error(`unknown flag: ${arg}\n${usage}`);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${arg} needs a value\n${usage}`);
    }
    out.set(arg, next);
    i += 1;
  }
  return out;
}

/**
 * A decimal string scaled to an integer, exactly: `scaled("3.25", 2)` is
 * 325n. More fraction digits than `scale` is refused, never rounded: a figure
 * an operator types for an invoice is either exact or wrong.
 */
export function scaledDecimal(
  raw: string,
  scale: number,
  flag: string,
): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw.replace(/,/g, ""));
  if (!match) {
    throw new Error(
      `${flag} must be a number like 1200 or 1200.50; got "${raw}"`,
    );
  }
  const fraction = match[2] ?? "";
  if (fraction.length > scale) {
    throw new Error(
      `${flag} allows at most ${scale} decimal places; got "${raw}"`,
    );
  }
  return BigInt(match[1]! + fraction.padEnd(scale, "0"));
}

/** Dollars as whole cents: `"5000"` → 500000. */
export function usdToCents(raw: string, flag: string): number {
  const cents = scaledDecimal(raw, 2, flag);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${flag} is too large; got "${raw}"`);
  }
  return Number(cents);
}

/**
 * A price per 1,000 units in dollars as micro-dollars per unit: $3.00 per
 * 1,000 is 3,000 micros each. Three decimal places, because a micro-dollar
 * rate times 1,000 is exact in thousandths of a dollar.
 */
export function usdPer1000ToMicros(raw: string, flag: string): bigint {
  return scaledDecimal(raw, 3, flag);
}

/** A whole number, at least `min`. */
export function wholeNumber(raw: string, flag: string, min: number): number {
  const n = Number(raw.replace(/,/g, ""));
  if (!Number.isSafeInteger(n) || n < min) {
    throw new Error(`${flag} must be a whole number >= ${min}; got "${raw}"`);
  }
  return n;
}

/**
 * A date or an instant as an instant. A bare `YYYY-MM-DD` is midnight UTC, so
 * `--licence-to 2027-10-01` ends the period as 30 Sep closes.
 */
export function instant(raw: string, flag: string): Date {
  const value = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    throw new Error(
      `${flag} must be a date like 2026-10-01 or an ISO instant; got "${raw}"`,
    );
  }
  return date;
}

// ── The run ───────────────────────────────────────────────────────────────────

/** What a platform-operator run needs from the outside. */
export interface PlatformOperatorRunDeps {
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
 * decision is about: the context carries no tenant, and the column is a
 * non-null uuid.
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
 * Register the kernel's audit emitter, mint a binding for this run, and
 * invoke `capability` with `input`. Every audit row the kernel emits is
 * awaited before the run settles, on the deny path too.
 */
export async function invokeAsPlatformOperator(
  args: { capability: string; input: unknown; orgId: string },
  deps: PlatformOperatorRunDeps,
): Promise<{ output: unknown; requestId: string }> {
  const audits: Promise<void>[] = [];
  deps.setSecurityEventEmitter((event) => {
    audits.push(deps.recordSecurityEvent(kernelAuditRow(event, args.orgId)));
  });

  const requestId = deps.requestId ?? randomUUID();
  const ctx: CapabilityContext = {
    // No tenant: the capability is unscoped and the operator is not a member
    // of the organisation it acts on.
    orgId: "",
    workspaceId: "",
    userId: null,
    apiKeyId: null,
    requestId,
    surface: "runner",
    messageId: null,
    platformOperator: createPlatformOperatorContext({ requestId }),
  };
  try {
    return {
      output: await deps.invoke(args.capability, args.input, ctx),
      requestId,
    };
  } finally {
    await Promise.all(audits);
  }
}

// ── The target ────────────────────────────────────────────────────────────────

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

/** The organisation a slug names, or null. */
export async function resolveOrgBySlug(
  slug: string,
): Promise<{ id: string; name: string } | null> {
  // tenancy: platform-operator lookup with no tenant scope, filtered by the slug the
  // operator typed; it returns only the orgId and name the run then acts on.
  const row = await withSystemDb((tx) =>
    tx.query.organizations.findFirst({
      where: eq(schema.organizations.slug, slug),
      columns: { id: true, name: true },
    }),
  );
  return row ?? null;
}
