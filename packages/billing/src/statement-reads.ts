/**
 * statement-reads.ts — the Postgres reads behind a billing statement
 * (statements.ts, ADR-165).
 *
 * Every read runs on the one transaction `withOrgDb` opens (ADR-086): the
 * organisation-wide read seam, which admits the org_only billing tables and
 * the org's agents in every workspace, and nothing of another organisation.
 * Each query ALSO names org_id: a local stack runs with the RLS bypass on, and
 * another organisation's rows must still stay out of the statement.
 *
 * The ledger reads select on `billed_at` over the (org_id, billed_at) index,
 * and aggregate in the database: a year of an active organisation is millions
 * of rows, and the statement carries sums, never rows. The line items for the
 * CSV are read a page at a time on a keyset over (billed_at, id).
 *
 * Every read that crosses into a money record lists it when it was created or
 * paid in the period. Invoices reach their settlement or prepaid order through
 * a scalar subquery rather than a join, because `gau_settlements.
 * stripe_invoice_id` has no unique index and a join could double a row.
 */

import {
  type AnyColumn,
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  getTableConfig,
  type PgColumn,
  type PgTable,
} from "drizzle-orm/pg-core";
import { schema, type Tx, withOrgDb } from "@oxagen/database";
import { readGauEntitlement } from "./contract-terms";
import { CREDIT_REASONS } from "./constants";
import {
  assembleBillingStatement,
  type BuildStatementOptions,
  type CreditMovementRead,
  decodeLineItemCursor,
  encodeLineItemCursor,
  type LedgerDimension,
  type LineItemPosition,
  type PeriodBounds,
  type ResolvedStatementPeriod,
  type StatementLabels,
  type StatementLineItem,
  type StatementReads,
} from "./statements";
import type { BillingStatement } from "@oxagen/oxagen/contracts/billing.statement.get";

/**
 * The tables, read from `schema` when a query is built and never at import.
 * `@oxagen/billing`'s index re-exports this module, and hundreds of test files
 * mock `@oxagen/database` with a partial schema; a module-scope
 * `schema.gauLedger` would fail every one of them at collection (the incident
 * `gauRemainingSql()` in gau-bucket.ts records).
 */
function tables() {
  return {
    gl: schema.gauLedger,
    gb: schema.gauBuckets,
    gs: schema.gauSettlements,
    gr: schema.gauReversals,
    po: schema.prepaidOrders,
    inv: schema.invoices,
    cl: schema.creditLedger,
    dt: schema.dailyTotals,
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A count or sum the driver hands back as text. */
function num(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function big(value: string | number | bigint | null | undefined): bigint {
  return value === null || value === undefined ? 0n : BigInt(value);
}

function ledgerInPeriod(orgId: string, p: PeriodBounds): SQL | undefined {
  const gl = schema.gauLedger;
  return and(
    eq(gl.orgId, orgId),
    gte(gl.billedAt, p.start),
    lt(gl.billedAt, p.end),
  );
}

/** A timestamptz parameter for a raw fragment, which has no column to encode it. */
function ts(at: Date): SQL {
  return sql`${at.toISOString()}::timestamptz`;
}

/** Created in the period, or `paidCol` in the period. */
function createdOrPaid(
  createdCol: AnyColumn,
  paidCol: AnyColumn,
  p: PeriodBounds,
): SQL | undefined {
  return or(
    and(gte(createdCol, p.start), lt(createdCol, p.end)),
    and(gte(paidCol, p.start), lt(paidCol, p.end)),
  );
}

/** The aggregate columns every ledger read selects. */
function aggregates() {
  const gl = schema.gauLedger;
  return {
    units: sql<string>`coalesce(sum(${gl.units}), 0)::text`,
    actions: sql<string>`count(*)::text`,
    /** In a grouped query: how many groups there are before the LIMIT. */
    groups: sql<string>`(count(*) over ())::text`,
  };
}

function dimensionColumn(dimension: LedgerDimension): SQL {
  const gl = schema.gauLedger;
  if (dimension === "workspace") return sql`${gl.attributedWorkspaceId}::text`;
  if (dimension === "agent") return sql`${gl.agentId}`;
  return sql`${gl.operatorUserId}`;
}

/**
 * An outer column, schema- and table-qualified, for a correlated subquery.
 *
 * Drizzle renders a column interpolated into a SELECT field unqualified
 * (`"id"`), and inside a subquery an unqualified name binds to the INNER
 * table first: `where l.bucket_id = "id"` compares the ledger row with
 * itself and `"stripe_invoice_id" = "stripe_invoice_id"` is always true.
 * Every correlated subquery here aliases its inner table and names the outer
 * column through this.
 */
function outer(column: PgColumn): SQL {
  const table = getTableConfig(column.table as PgTable);
  return sql.raw(
    `"${table.schema ?? "public"}"."${table.name}"."${column.name}"`,
  );
}

/**
 * The invoice a money record names, as a scalar subquery per column, fenced
 * to the record's own organisation. `invoices.stripe_invoice_id` is unique, so
 * each subquery answers one row or none.
 */
function invoiceColumns(stripeInvoiceId: PgColumn, orgId: PgColumn) {
  const inv = schema.invoices;
  const pick = (col: string) =>
    sql`(select i.${sql.raw(col)} from ${inv} i where i.stripe_invoice_id = ${outer(stripeInvoiceId)} and i.org_id = ${outer(orgId)} limit 1)`;
  return {
    invoiceNumber: sql<string | null>`${pick("number")}`,
    invoiceStatus: sql<string | null>`${pick("status")}`,
    invoiceUrl: sql<string | null>`${pick("hosted_invoice_url")}`,
  };
}

function invoiceRef(row: {
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  invoiceUrl: string | null;
}) {
  return row.invoiceStatus === null
    ? null
    : {
        number: row.invoiceNumber,
        status: row.invoiceStatus,
        hostedInvoiceUrl: row.invoiceUrl,
      };
}

/** `StatementReads` on one transaction. */
export function postgresStatementReads(tx: Tx): StatementReads {
  const { gl, gb, gs, gr, po, inv, cl, dt } = tables();
  const { units, actions, groups } = aggregates();
  return {
    async org(orgId) {
      const [row] = await tx
        .select({
          id: schema.organizations.id,
          name: schema.organizations.name,
          slug: schema.organizations.slug,
        })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId))
        .limit(1);
      return row
        ? { id: row.id, name: row.name, slug: String(row.slug) }
        : null;
    },

    entitlement: (orgId, asOf) => readGauEntitlement(tx, orgId, asOf),

    async agreements(orgId, p) {
      const ct = schema.contractTerms;
      const rows = await tx
        .select({
          agreementRef: ct.agreementRef,
          currency: ct.currency,
          ratePerGauMicros: ct.ratePerGauMicros,
          includedGauPerMonth: ct.includedGauPerMonth,
          blockSizeGau: ct.blockSizeGau,
          effectiveFrom: ct.effectiveFrom,
          effectiveTo: ct.effectiveTo,
        })
        .from(ct)
        .where(
          and(
            eq(ct.orgId, orgId),
            lt(ct.effectiveFrom, p.end),
            or(isNull(ct.effectiveTo), gt(ct.effectiveTo, p.start)),
          ),
        )
        .orderBy(asc(ct.effectiveFrom));
      return rows.map((r) => ({
        agreementRef: r.agreementRef,
        currency: r.currency,
        ratePerGauMicros: big(r.ratePerGauMicros),
        includedGauPerMonth: num(r.includedGauPerMonth),
        blockSizeGau: num(r.blockSizeGau),
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
      }));
    },

    async ledgerBySource(orgId, p) {
      const rows = await tx
        .select({ source: gl.source, units, actions })
        .from(gl)
        .where(ledgerInPeriod(orgId, p))
        .groupBy(gl.source);
      return rows.map((r) => ({
        source: r.source,
        units: num(r.units),
        actions: num(r.actions),
      }));
    },

    async ledgerBy(orgId, p, dimension, top) {
      const key = dimensionColumn(dimension);
      const rows = await tx
        .select({ key: sql<string | null>`${key}`, units, actions, groups })
        .from(gl)
        .where(ledgerInPeriod(orgId, p))
        .groupBy(key)
        .orderBy(sql`sum(${gl.units}) desc`, sql`${key} asc nulls last`)
        .limit(top);
      return {
        rows: rows.map((r) => ({
          key: r.key,
          units: num(r.units),
          actions: num(r.actions),
        })),
        groups: num(rows[0]?.groups),
      };
    },

    async ledgerBySubject(orgId, p, top) {
      const rows = await tx
        .select({
          capability: gl.capability,
          toolName: gl.toolName,
          mcpServer: gl.mcpServer,
          units,
          actions,
          groups,
        })
        .from(gl)
        .where(ledgerInPeriod(orgId, p))
        .groupBy(gl.capability, gl.toolName, gl.mcpServer)
        .orderBy(
          sql`sum(${gl.units}) desc`,
          sql`${gl.capability} asc nulls last`,
          sql`${gl.toolName} asc nulls last`,
          sql`${gl.mcpServer} asc nulls last`,
        )
        .limit(top);
      return {
        rows: rows.map((r) => ({
          capability: r.capability,
          toolName: r.toolName,
          mcpServer: r.mcpServer,
          units: num(r.units),
          actions: num(r.actions),
        })),
        groups: num(rows[0]?.groups),
      };
    },

    async ledgerDaily(orgId, p) {
      const date = sql<string>`to_char(${gl.billedAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const rows = await tx
        .select({ date, units, actions })
        .from(gl)
        .where(ledgerInPeriod(orgId, p))
        .groupBy(date)
        .orderBy(date);
      return rows.map((r) => ({
        date: r.date,
        units: num(r.units),
        actions: num(r.actions),
      }));
    },

    async buckets(orgId, p) {
      const rows = await tx
        .select({
          periodStart: gb.periodStart,
          periodEnd: gb.periodEnd,
          includedGau: gb.includedGau,
          purchasedGau: gb.purchasedGau,
          carriedGau: gb.carriedGau,
          usedGau: gb.usedGau,
          overageInvoicedGau: gb.overageInvoicedGau,
          closedAt: gb.closedAt,
          ledgerUnits: sql<string>`(select coalesce(sum(l.units), 0)::text from ${gl} l where l.bucket_id = ${outer(gb.id)})`,
          unitsInPeriod: sql<string>`(select coalesce(sum(l.units), 0)::text from ${gl} l where l.bucket_id = ${outer(gb.id)} and l.billed_at >= ${ts(p.start)} and l.billed_at < ${ts(p.end)})`,
        })
        .from(gb)
        .where(
          and(
            eq(gb.orgId, orgId),
            lt(gb.periodStart, p.end),
            gt(gb.periodEnd, p.start),
          ),
        )
        .orderBy(asc(gb.periodStart));
      return rows.map((r) => ({
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        includedGau: num(r.includedGau),
        purchasedGau: num(r.purchasedGau),
        carriedGau: num(r.carriedGau),
        usedGau: num(r.usedGau),
        overageInvoicedGau: num(r.overageInvoicedGau),
        closedAt: r.closedAt,
        ledgerUnits: num(r.ledgerUnits),
        unitsInPeriod: num(r.unitsInPeriod),
      }));
    },

    async settlements(orgId, p) {
      const rows = await tx
        .select({
          id: gs.id,
          kind: gs.kind,
          status: gs.status,
          quantityGau: gs.quantityGau,
          ratePerGauMicros: gs.ratePerGauMicros,
          chargedCents: gs.chargedCents,
          currency: gs.currency,
          createdAt: gs.createdAt,
          settledAt: gs.settledAt,
          ...invoiceColumns(gs.stripeInvoiceId, gs.orgId),
        })
        .from(gs)
        .where(
          and(
            eq(gs.orgId, orgId),
            createdOrPaid(gs.createdAt, gs.settledAt, p),
          ),
        )
        .orderBy(asc(gs.createdAt), asc(gs.id));
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        quantityGau: num(r.quantityGau),
        ratePerGauMicros: big(r.ratePerGauMicros),
        chargedCents: r.chargedCents === null ? null : num(r.chargedCents),
        currency: r.currency,
        createdAt: r.createdAt,
        settledAt: r.settledAt,
        invoice: invoiceRef(r),
      }));
    },

    async reversals(orgId, p) {
      const rows = await tx
        .select({
          id: gr.id,
          kind: gr.kind,
          settlementId: gr.settlementId,
          requestedGau: gr.requestedGau,
          reversedGau: gr.reversedGau,
          unrecoveredGau: gr.unrecoveredGau,
          amountCents: gr.amountCents,
          currency: gr.currency,
          createdAt: gr.createdAt,
        })
        .from(gr)
        .where(
          and(
            eq(gr.orgId, orgId),
            gte(gr.createdAt, p.start),
            lt(gr.createdAt, p.end),
          ),
        )
        .orderBy(asc(gr.createdAt), asc(gr.id));
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        settlementId: r.settlementId,
        requestedGau: num(r.requestedGau),
        reversedGau: num(r.reversedGau),
        unrecoveredGau: num(r.unrecoveredGau),
        amountCents: num(r.amountCents),
        currency: r.currency,
        createdAt: r.createdAt,
      }));
    },

    async prepaidOrders(orgId, p) {
      const rows = await tx
        .select({
          id: po.id,
          status: po.status,
          agreementRef: po.agreementRef,
          poNumber: po.poNumber,
          currency: po.currency,
          licenceCents: po.licenceCents,
          licencePeriodStart: po.licencePeriodStart,
          licencePeriodEnd: po.licencePeriodEnd,
          gauQuantity: po.gauQuantity,
          ratePerGauMicros: po.ratePerGauMicros,
          creditCents: po.creditCents,
          createdAt: po.createdAt,
          paidAt: po.paidAt,
          ...invoiceColumns(po.stripeInvoiceId, po.orgId),
        })
        .from(po)
        .where(
          and(
            eq(po.orgId, orgId),
            // A draft has not been sent to the customer.
            ne(po.status, "draft"),
            createdOrPaid(po.createdAt, po.paidAt, p),
          ),
        )
        .orderBy(asc(po.createdAt), asc(po.id));
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        agreementRef: r.agreementRef,
        poNumber: r.poNumber,
        currency: r.currency,
        licenceCents: num(r.licenceCents),
        licencePeriodStart: r.licencePeriodStart,
        licencePeriodEnd: r.licencePeriodEnd,
        gauQuantity: num(r.gauQuantity),
        ratePerGauMicros: big(r.ratePerGauMicros),
        creditCents: num(r.creditCents),
        createdAt: r.createdAt,
        paidAt: r.paidAt,
        invoice: invoiceRef(r),
      }));
    },

    async invoices(orgId, p) {
      const rows = await tx
        .select({
          publicId: inv.publicId,
          number: inv.number,
          status: inv.status,
          settlementKind: sql<
            string | null
          >`(select s.kind from ${gs} s where s.stripe_invoice_id = ${outer(inv.stripeInvoiceId)} and s.org_id = ${outer(inv.orgId)} order by s.created_at limit 1)`,
          prepaid: sql<boolean>`exists (select 1 from ${po} o where o.stripe_invoice_id = ${outer(inv.stripeInvoiceId)} and o.org_id = ${outer(inv.orgId)})`,
          amountDueCents: inv.amountDueCents,
          amountPaidCents: inv.amountPaidCents,
          amountRemainingCents: inv.amountRemainingCents,
          currency: inv.currency,
          periodStart: inv.periodStart,
          periodEnd: inv.periodEnd,
          createdAt: inv.createdAt,
          dueAt: inv.dueAt,
          paidAt: inv.paidAt,
          hostedInvoiceUrl: inv.hostedInvoiceUrl,
          invoicePdfUrl: inv.invoicePdfUrl,
        })
        .from(inv)
        .where(
          and(
            eq(inv.orgId, orgId),
            // Drafts are not collectable and were never presented.
            ne(inv.status, "draft"),
            createdOrPaid(inv.createdAt, inv.paidAt, p),
          ),
        )
        .orderBy(asc(inv.createdAt), asc(inv.id));
      return rows.map((r) => ({ ...r, prepaid: Boolean(r.prepaid) }));
    },

    async creditBalanceBefore(orgId, at) {
      const [row] = await tx
        .select({
          cents: sql<string>`coalesce(sum(${cl.deltaCents}), 0)::text`,
        })
        .from(cl)
        .where(and(eq(cl.orgId, orgId), lt(cl.createdAt, at)));
      return big(row?.cents);
    },

    async creditMovements(orgId, p) {
      const positive = sql<boolean>`${cl.deltaCents} > 0`;
      const rows = await tx
        .select({
          reason: cl.reason,
          positive,
          cents: sql<string>`sum(${cl.deltaCents})::text`,
          entries: actions,
        })
        .from(cl)
        .where(
          and(
            eq(cl.orgId, orgId),
            gte(cl.createdAt, p.start),
            lt(cl.createdAt, p.end),
          ),
        )
        .groupBy(cl.reason, positive);
      const additions: CreditMovementRead[] = [];
      const deductions: CreditMovementRead[] = [];
      for (const r of rows) {
        const m = {
          reason: r.reason,
          cents: big(r.cents),
          entries: num(r.entries),
        };
        if (r.positive) additions.push(m);
        else deductions.push(m);
      }
      return { additions, deductions };
    },

    async assistantByOperator(orgId, p) {
      const rows = await tx
        .select({
          key: sql<string | null>`${cl.createdById}::text`,
          cents: sql<string>`(-sum(${cl.deltaCents}))::text`,
          entries: actions,
        })
        .from(cl)
        .where(
          and(
            eq(cl.orgId, orgId),
            eq(cl.reason, CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS),
            lt(cl.deltaCents, 0n),
            gte(cl.createdAt, p.start),
            lt(cl.createdAt, p.end),
          ),
        )
        .groupBy(cl.createdById);
      return rows.map((r) => ({
        key: r.key,
        cents: big(r.cents),
        entries: num(r.entries),
      }));
    },

    async modelUsage(orgId, days) {
      const token = (name: string) =>
        sql`coalesce((${dt.tokens} ->> ${name})::bigint, 0)`;
      const rows = await tx
        .select({
          provider: dt.provider,
          model: dt.groupKey,
          currency: dt.currency,
          calls: sql<string>`sum(${dt.calls})::text`,
          inputTokens: sql<string>`sum(${token("input_uncached")} + ${token("cache_read")} + ${token("cache_write_5m")} + ${token("cache_write_1h")})::text`,
          outputTokens: sql<string>`sum(${token("output")} + ${token("reasoning")})::text`,
          costMicros: sql<string | null>`sum(${dt.costMicros})::text`,
        })
        .from(dt)
        .where(
          and(
            eq(dt.orgId, orgId),
            eq(dt.groupKind, "model"),
            gte(dt.day, days.first),
            sql`${dt.day} <= ${days.last}`,
          ),
        )
        .groupBy(dt.provider, dt.groupKey, dt.currency);
      return rows.map((r) => ({
        provider: r.provider,
        model: r.model,
        currency: r.currency,
        calls: num(r.calls),
        inputTokens: num(r.inputTokens),
        outputTokens: num(r.outputTokens),
        costMicros: r.costMicros === null ? null : big(r.costMicros),
      }));
    },

    labels: (orgId, ids) => readLabels(tx, orgId, ids),
  };
}

/**
 * Human labels for the ids a statement names: a workspace's name, an agent's
 * name, a person's display name or email. The ledger records an agent by its
 * public id (`agt_…`) and a person by user id; both are matched by public id
 * and by row id, since older rows carry either.
 */
async function readLabels(
  tx: Tx,
  orgId: string,
  ids: { workspaces: string[]; agents: string[]; users: string[] },
): Promise<StatementLabels> {
  const uniq = (xs: string[]) => [...new Set(xs)];
  const uuids = (xs: string[]) => uniq(xs).filter((x) => UUID_RE.test(x));
  const others = (xs: string[]) => uniq(xs).filter((x) => !UUID_RE.test(x));

  const workspaces = new Map<string, string>();
  const wsIds = uuids(ids.workspaces);
  if (wsIds.length > 0) {
    const rows = await tx
      .select({ id: schema.workspaces.id, name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.orgId, orgId),
          inArray(schema.workspaces.id, wsIds),
        ),
      );
    for (const r of rows) workspaces.set(r.id, r.name);
  }

  const agents = new Map<string, string>();
  const agentUuids = uuids(ids.agents);
  const agentPublic = others(ids.agents);
  if (agentUuids.length + agentPublic.length > 0) {
    const a = schema.agents;
    const match = [
      agentUuids.length > 0 ? inArray(a.id, agentUuids) : undefined,
      agentPublic.length > 0 ? inArray(a.publicId, agentPublic) : undefined,
    ].filter((m): m is SQL => m !== undefined);
    const rows = await tx
      .select({ id: a.id, publicId: a.publicId, name: a.name })
      .from(a)
      .where(and(eq(a.orgId, orgId), or(...match)));
    for (const r of rows) {
      agents.set(r.id, r.name);
      agents.set(r.publicId, r.name);
    }
  }

  const users = new Map<string, string>();
  const userUuids = uuids(ids.users);
  const userPublic = others(ids.users);
  if (userUuids.length + userPublic.length > 0) {
    const u = schema.users;
    const match = [
      userUuids.length > 0 ? inArray(u.id, userUuids) : undefined,
      userPublic.length > 0 ? inArray(u.publicId, userPublic) : undefined,
    ].filter((m): m is SQL => m !== undefined);
    const rows = await tx
      .select({
        id: u.id,
        publicId: u.publicId,
        displayName: u.displayName,
        email: u.email,
      })
      .from(u)
      .where(or(...match));
    for (const r of rows) {
      const label = r.displayName?.trim() ? r.displayName : String(r.email);
      users.set(r.id, label);
      users.set(r.publicId, label);
    }
  }

  return { workspaces, agents, users };
}

/**
 * The organisation's statement for `period`, read in one organisation-wide
 * transaction. Runs inside the caller's tenant scope: the kernel enters it
 * for a capability, and the operator script enters an org-only one.
 */
export async function buildBillingStatement(
  orgId: string,
  period: ResolvedStatementPeriod,
  opts: BuildStatementOptions = {},
): Promise<BillingStatement> {
  return withOrgDb((tx) =>
    assembleBillingStatement(postgresStatementReads(tx), orgId, period, opts),
  );
}

// ── Line items ──────────────────────────────────────────────────────────────

/** One page of ledger rows, oldest first, after `after`. */
export async function readLineItemPage(
  tx: Tx,
  orgId: string,
  period: PeriodBounds,
  after: LineItemPosition | null,
  limit: number,
): Promise<{ items: StatementLineItem[]; next: LineItemPosition | null }> {
  const gl = schema.gauLedger;
  /** Microsecond RFC 3339 in UTC: exact, so the keyset never skips a row. */
  const billedAtMicros = sql<string>`to_char(${gl.billedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const rows = await tx
    .select({
      id: gl.id,
      billedAt: billedAtMicros,
      occurredAt: gl.occurredAt,
      source: gl.source,
      capability: gl.capability,
      toolName: gl.toolName,
      mcpServer: gl.mcpServer,
      surface: gl.surface,
      harness: gl.harness,
      workspaceId: sql<string | null>`${gl.attributedWorkspaceId}::text`,
      agentId: gl.agentId,
      operatorUserId: gl.operatorUserId,
      principalId: gl.principalId,
      principalKind: gl.principalKind,
      runId: gl.runId,
      sessionId: gl.sessionId,
      toolCallId: gl.toolCallId,
      requestId: gl.requestId,
      units: gl.units,
    })
    .from(gl)
    .where(
      and(
        ledgerInPeriod(orgId, period),
        after === null
          ? undefined
          : sql`(${gl.billedAt}, ${gl.id}) > (${after.billedAt}::timestamptz, ${after.id}::uuid)`,
      ),
    )
    .orderBy(asc(gl.billedAt), asc(gl.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const labels = await readLabels(tx, orgId, {
    workspaces: page.map((r) => r.workspaceId).filter((x): x is string => !!x),
    agents: page.map((r) => r.agentId).filter((x): x is string => !!x),
    users: page.map((r) => r.operatorUserId).filter((x): x is string => !!x),
  });
  const items = page.map((r) => ({
    ...r,
    occurredAt: r.occurredAt.toISOString(),
    workspace: r.workspaceId
      ? (labels.workspaces.get(r.workspaceId) ?? null)
      : null,
    agent: r.agentId ? (labels.agents.get(r.agentId) ?? null) : null,
    operator: r.operatorUserId
      ? (labels.users.get(r.operatorUserId) ?? null)
      : null,
  }));
  const last = page.at(-1);
  return {
    items,
    next:
      rows.length > limit && last
        ? { billedAt: last.billedAt, id: last.id }
        : null,
  };
}

/**
 * One page of line items for the CSV, from an opaque cursor bound to the
 * period. A cursor this module did not write for this period is refused
 * with a RangeError the handler maps to `invalid_input`.
 */
export async function readStatementLineItems(
  orgId: string,
  period: PeriodBounds,
  q: { cursor: string | null; limit: number },
): Promise<{ items: StatementLineItem[]; nextCursor: string | null }> {
  const after =
    q.cursor === null ? null : decodeLineItemCursor(q.cursor, period);
  if (q.cursor !== null && after === null)
    throw new RangeError("invalid_cursor");
  const page = await withOrgDb((tx) =>
    readLineItemPage(tx, orgId, period, after, q.limit),
  );
  return {
    items: page.items,
    nextCursor:
      page.next === null ? null : encodeLineItemCursor(period, page.next),
  };
}
