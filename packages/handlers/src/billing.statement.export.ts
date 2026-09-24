// billing.statement.export.ts — handler for the export_billing_statement
// capability.
//
// audit-exempt: read-only. Renders the organization's own billing statement
// as a file; no state changes, nothing outside the organization is
// disclosed, and the kernel's capability.invoke_* audit records the access.
//
// Two formats, both rendered by @oxagen/billing (statement-render.ts):
//
//   csv   The first call builds the statement for its header block and
//         reads the first page of ledger rows; a period with more rows than
//         `limit` answers `nextCursor`. A call with a cursor reads the next
//         page only, rows without the header, so the pages concatenate into
//         one file. The cursor is bound to the period it was written for, and
//         any other cursor is `invalid_input`. The keyset is (billed_at, id)
//         over the ledger's (org_id, billed_at) index, so a year of millions of
//         rows is read one page at a time and never loaded whole.
//   html  One printable document of the whole statement. It carries the
//         summaries; the rows are the CSV's.
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner, Admin or Billing, as
//      get_billing_statement (INV-29).
//   2. Resolve the period; a period the statement cannot cover is
//      invalid_input naming the rule.
//   3. Render the format.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  billingStatementExport,
  type BillingStatementExportOutput,
} from "@oxagen/oxagen/contracts/billing.statement.export";
import {
  buildBillingStatement,
  readStatementLineItems,
  renderLineItemsCsv,
  renderStatementCsv,
  renderStatementHtml,
  statementReference,
} from "@oxagen/billing";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  STATEMENT_ROLES,
  type StatementGetDeps,
  statementPeriodOrRefuse,
} from "./billing.statement.get";

export interface StatementExportDeps extends StatementGetDeps {
  lineItems: typeof readStatementLineItems;
}

export function createBillingStatementExportHandler(
  deps: StatementExportDeps,
): CapabilityHandler<typeof billingStatementExport> {
  return async (input, ctx): Promise<BillingStatementExportOutput> => {
    // ── Role gate ─────────────────────────────────────────────────────────
    await assertOrgRole(
      { ...ctx, userId: await resolveActingUserId(ctx) },
      { org: [...STATEMENT_ROLES.org] },
    );

    // ── Period ────────────────────────────────────────────────────────────
    const now = deps.now();
    const period = statementPeriodOrRefuse(
      billingStatementExport.name,
      input,
      now,
    );
    const reference = statementReference(ctx.orgId, period);

    // ── HTML ──────────────────────────────────────────────────────────────
    if (input.format === "html") {
      if (input.cursor !== undefined)
        throw new CapabilityError(
          billingStatementExport.name,
          "invalid_input",
          "cursor_not_paged: the HTML statement is one document; a cursor pages the CSV only.",
        );
      const statement = await deps.build(ctx.orgId, period, { now, top: 25 });
      return {
        reference,
        format: "html",
        filename: `${reference}.html`,
        mediaType: "text/html",
        content: renderStatementHtml(statement),
        lines: 0,
        nextCursor: null,
      };
    }

    // ── CSV ───────────────────────────────────────────────────────────────
    let page: Awaited<ReturnType<typeof readStatementLineItems>>;
    try {
      page = await deps.lineItems(ctx.orgId, period, {
        cursor: input.cursor ?? null,
        limit: input.limit,
      });
    } catch (err) {
      if (err instanceof RangeError && err.message === "invalid_cursor")
        throw new CapabilityError(
          billingStatementExport.name,
          "invalid_input",
          "invalid_cursor: pass back the nextCursor this export returned, with the same period.",
        );
      throw err;
    }
    const content =
      input.cursor === undefined
        ? renderStatementCsv(
            await deps.build(ctx.orgId, period, { now, top: 25 }),
            page.items,
          )
        : renderLineItemsCsv(page.items);
    return {
      reference,
      format: "csv",
      filename: `${reference}.csv`,
      mediaType: "text/csv",
      content,
      lines: page.items.length,
      nextCursor: page.nextCursor,
    };
  };
}

export const billingStatementExportHandler =
  createBillingStatementExportHandler({
    build: buildBillingStatement,
    lineItems: readStatementLineItems,
    now: () => new Date(),
  });
