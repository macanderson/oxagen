/**
 * gau-ledger.ts — the itemised record behind the month bucket (ADR-158).
 *
 * `billing.gau_buckets.used_gau` is the balance the gate reads. On its own it
 * is a number nobody can cite: a customer disputing an invoice line, or asking
 * which agent spent last month's allowance, gets a total and no rows. This
 * file writes one `billing.gau_ledger` row per billed governed action, in the
 * same transaction that adds its units to the bucket, so:
 *
 *   - every unit on an invoice traces to a row naming the capability or tool,
 *     the workspace, the agent, the operator, the run and the tool call;
 *   - `SUM(units)` over a bucket's ledger rows equals what the ledger added to
 *     that bucket, because the two writes commit or roll back together;
 *   - a retried action bills once: rows insert `ON CONFLICT (org_id,
 *     idempotency_key) DO NOTHING` and only the rows that inserted are debited.
 *
 * Three sources feed it: a top-level kernel invoke (`kernel`), a tool call a
 * wrapped harness made and Tacho allowed (`tacho`), and an external MCP tool
 * call Oxagen authorised (`external_tool`). Each builds its idempotency key
 * with the helper below, so keys from different sources can never collide.
 */

import { eq, sql } from "drizzle-orm";
import { schema, type Tx } from "@oxagen/database";
import type { GovernedActionRecord } from "@oxagen/oxagen/kernel";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
import {
  ensureCurrentBucket,
  type GauBucketRow,
  type GauPeriod,
} from "./gau-bucket";
import type { GauTerms } from "./pricing";

export type GauLedgerSource = "kernel" | "tacho" | "external_tool";

/**
 * One billed governed action, as the ledger records it. Every attribution
 * field is optional in fact (null when the source did not know it) and never
 * invented: a fabricated agent or run id would attribute a charge to
 * something that did not incur it.
 */
export interface GovernedActionEntry {
  /** Dedup key, namespaced by source. See {@link ledgerKey}. */
  idempotencyKey: string;
  source: GauLedgerSource;
  /** Canonical capability name, for a kernel action. */
  capability: string | null;
  /** The tool the agent called, for a tool-call action. */
  toolName: string | null;
  mcpServer: string | null;
  surface: string | null;
  harness: string | null;
  workspaceId: string | null;
  agentId: string | null;
  principalId: string | null;
  principalKind: string | null;
  operatorUserId: string | null;
  runId: string | null;
  sessionId: string | null;
  toolCallId: string | null;
  requestId: string | null;
  /** Governed action units this action is worth. Floored at 1. */
  units: number;
  occurredAt: Date;
}

/** The fields a caller may leave out; each defaults to null. */
type OptionalEntryFields = Exclude<
  keyof GovernedActionEntry,
  "idempotencyKey" | "source" | "units" | "occurredAt"
>;

/** Build an entry, defaulting every attribution field it does not name to null. */
export function governedActionEntry(
  required: Pick<
    GovernedActionEntry,
    "idempotencyKey" | "source" | "units" | "occurredAt"
  > &
    Partial<Pick<GovernedActionEntry, OptionalEntryFields>>,
): GovernedActionEntry {
  return {
    capability: null,
    toolName: null,
    mcpServer: null,
    surface: null,
    harness: null,
    workspaceId: null,
    agentId: null,
    principalId: null,
    principalKind: null,
    operatorUserId: null,
    runId: null,
    sessionId: null,
    toolCallId: null,
    requestId: null,
    ...required,
  };
}

/**
 * A ledger key for a tool call, namespaced by source.
 *
 * `scope` is whatever the tool call's id is unique within: the Tacho session
 * for a wrapped harness (`tool_use_id` is unique per session), the run or turn
 * for the in-app agent's model (a provider's tool-call id is unique within a
 * conversation, and promised nothing beyond it).
 */
export function ledgerKey(
  source: Exclude<GauLedgerSource, "kernel">,
  scope: string,
  toolCallId: string,
): string {
  return `${source}:${scope}:${toolCallId}`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A workspace id worth recording: a real uuid, and not the org-only sentinel
 * an org-scoped context carries in place of one.
 */
export function attributableWorkspaceId(
  workspaceId: string | null | undefined,
): string | null {
  if (!workspaceId || workspaceId === ORG_ONLY_WORKSPACE_ID) return null;
  return UUID_RE.test(workspaceId) ? workspaceId : null;
}

/** The ledger entry for one kernel-recorded governed action. */
export function entryFromKernelRecord(
  record: GovernedActionRecord,
): GovernedActionEntry {
  return governedActionEntry({
    idempotencyKey: record.idempotencyKey,
    source: "kernel",
    units: record.actions,
    occurredAt: record.occurredAt,
    capability: record.capability,
    surface: record.surface ?? null,
    workspaceId: attributableWorkspaceId(record.workspaceId),
    agentId: record.agentId ?? null,
    principalId: record.principalId ?? null,
    principalKind: record.principalKind ?? null,
    operatorUserId: record.operatorUserId ?? null,
    runId: record.runId ?? null,
    toolCallId: record.toolCallId ?? null,
    requestId: record.requestId ?? null,
  });
}

/** Rows per INSERT. A Tacho batch can carry hundreds of tool calls. */
const INSERT_CHUNK = 500;

export interface LedgerDebitResult {
  /** The bucket after the debit (unchanged when every entry was a duplicate). */
  bucket: GauBucketRow;
  /** Units the ledger added to the bucket in this call. */
  billedUnits: number;
  /** Entries whose key was already on the ledger, so billed nothing. */
  duplicates: number;
}

/**
 * Record `entries` on the ledger and add the units of the ones that are new
 * to the organisation's month bucket, on the caller's transaction.
 *
 *   1. `ensureCurrentBucket` with zero deltas: the lazy create, and the row
 *      lock that serialises this organisation's concurrent debits.
 *   2. INSERT the rows ON CONFLICT (org_id, idempotency_key) DO NOTHING
 *      RETURNING units — only what inserted comes back.
 *   3. UPDATE used_gau by exactly that sum.
 *
 * Entries sharing a key within one call are collapsed to the first, as a
 * second INSERT of the same key in one statement would raise rather than
 * conflict.
 */
export async function debitWithLedger(
  tx: Tx,
  orgId: string,
  args: {
    period: GauPeriod;
    terms: GauTerms;
    entries: readonly GovernedActionEntry[];
    billedAt: Date;
  },
): Promise<LedgerDebitResult> {
  const bucket = await ensureCurrentBucket(tx, orgId, {
    period: args.period,
    terms: args.terms,
    usedDelta: 0,
    purchasedDelta: 0,
  });

  const seen = new Set<string>();
  const unique: GovernedActionEntry[] = [];
  for (const entry of args.entries) {
    if (seen.has(entry.idempotencyKey)) continue;
    seen.add(entry.idempotencyKey);
    unique.push(entry);
  }

  let billedUnits = 0;
  let inserted = 0;
  for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
    const chunk = unique.slice(i, i + INSERT_CHUNK);
    const rows = await tx
      .insert(schema.gauLedger)
      .values(
        chunk.map((e) => ({
          orgId,
          bucketId: bucket.id,
          idempotencyKey: e.idempotencyKey,
          source: e.source,
          capability: e.capability,
          toolName: e.toolName,
          mcpServer: e.mcpServer,
          surface: e.surface,
          harness: e.harness,
          attributedWorkspaceId: e.workspaceId,
          agentId: e.agentId,
          principalId: e.principalId,
          principalKind: e.principalKind,
          operatorUserId: e.operatorUserId,
          runId: e.runId,
          sessionId: e.sessionId,
          toolCallId: e.toolCallId,
          requestId: e.requestId,
          units: Math.max(1, Math.floor(e.units)),
          occurredAt: e.occurredAt,
          billedAt: args.billedAt,
        })),
      )
      .onConflictDoNothing({
        target: [schema.gauLedger.orgId, schema.gauLedger.idempotencyKey],
      })
      .returning({ units: schema.gauLedger.units });
    inserted += rows.length;
    for (const r of rows) billedUnits += r.units;
  }

  if (billedUnits === 0) {
    return {
      bucket,
      billedUnits: 0,
      duplicates: args.entries.length - inserted,
    };
  }

  const updated = await tx
    .update(schema.gauBuckets)
    .set({
      usedGau: sql`${schema.gauBuckets.usedGau} + ${billedUnits}`,
      updatedAt: sql`now()`,
    })
    .where(eq(schema.gauBuckets.id, bucket.id))
    .returning();
  const row = updated[0];
  if (!row) {
    // The row was created or locked two statements ago in this transaction;
    // only a driver fault reaches here, and a silent zero would under-bill.
    throw new Error("billing: gau_buckets debit returned no row");
  }
  return {
    bucket: row,
    billedUnits,
    duplicates: args.entries.length - inserted,
  };
}
