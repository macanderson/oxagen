// billing.statement.get.ts — handler for the get_billing_statement capability.
//
// audit-exempt: read-only. Builds the organization's own billing statement
// from its ledgers; no state changes, nothing outside the organization is
// disclosed, and the kernel's capability.invoke_* audit records the access.
//
// The statement is @oxagen/billing's (statements.ts, statement-reads.ts): one
// organisation-wide read transaction (withOrgDb, ADR-086) over the governed
// action ledger, the month buckets, the settlements, reversals, prepaid
// orders and invoices, the credit ledger and the model rollup. This handler
// adds the role gate and turns a period the statement cannot cover into
// `invalid_input` naming the rule it broke.
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner, Admin or Billing, for the
//      signed-in user or the creator of the API key. The kernel's IAM check
//      allows every capability for a non-enterprise org, so the handler owns
//      this check (apps/app/ARCHITECTURE.md §3.2, INV-29).
//   2. Resolve the period: a week, month, quarter or year from its anchor, or
//      a custom range longer than 48 hours and at most 366 days.
//   3. Build the statement.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  billingStatementGet,
  type BillingStatement,
} from "@oxagen/oxagen/contracts/billing.statement.get";
import {
  buildBillingStatement,
  type ResolvedStatementPeriod,
  resolveStatementPeriod,
  StatementPeriodError,
  type StatementPeriodInput,
} from "@oxagen/billing";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";

/** The roles a statement is read under, on every surface. */
export const STATEMENT_ROLES = { org: ["Owner", "Admin", "Billing"] } as const;

/**
 * The contract's period fields as a resolved period, or `invalid_input`
 * whose message opens with the broken rule (`range_too_short: …`).
 */
export function statementPeriodOrRefuse(
  capability: string,
  input: {
    period: StatementPeriodInput["kind"];
    anchor?: string;
    from?: string;
    to?: string;
  },
  now: Date,
): ResolvedStatementPeriod {
  try {
    return resolveStatementPeriod(
      {
        kind: input.period,
        anchor: input.anchor,
        from: input.from,
        to: input.to,
      },
      now,
    );
  } catch (err) {
    if (err instanceof StatementPeriodError)
      throw new CapabilityError(
        capability,
        "invalid_input",
        `${err.reason}: ${err.message}`,
      );
    throw err;
  }
}

export interface StatementGetDeps {
  build: (
    orgId: string,
    period: ResolvedStatementPeriod,
    opts: { now: Date; top: number },
  ) => Promise<BillingStatement>;
  now: () => Date;
}

export function createBillingStatementGetHandler(
  deps: StatementGetDeps,
): CapabilityHandler<typeof billingStatementGet> {
  return async (input, ctx): Promise<BillingStatement> => {
    // ── Role gate ─────────────────────────────────────────────────────────
    await assertOrgRole(
      { ...ctx, userId: await resolveActingUserId(ctx) },
      { org: [...STATEMENT_ROLES.org] },
    );

    // ── Period, then the statement ───────────────────────────────────────
    const now = deps.now();
    const period = statementPeriodOrRefuse(
      billingStatementGet.name,
      input,
      now,
    );
    return deps.build(ctx.orgId, period, { now, top: input.top });
  };
}

export const billingStatementGetHandler = createBillingStatementGetHandler({
  build: buildBillingStatement,
  now: () => new Date(),
});
