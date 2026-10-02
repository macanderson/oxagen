// triage-store.ts: the triage decisions and corrections a work item holds
// (P1-03, #5103; ADR-244 maps them).
//
// work.triage_decisions and work.triage_corrections are append only. A new
// triage run adds a decision and points work.items.triage_id at it. A
// person's correction adds one row per changed field, against the decision
// that was current when they made it. effectiveTriage (@oxagen/work) applies
// every correction the item holds to its latest decision, so a later decision
// never undoes a person's edit.
//
// Every function takes the caller's tenant transaction.
import { schema, type Tx } from "@oxagen/database";
import type { Sha256Digest } from "@oxagen/run-evidence";
import {
  type TriageCorrection,
  type TriageCorrectionField,
  type TriageDecision,
  type TriageView,
  effectiveTriage,
} from "@oxagen/work";
import { and, asc, desc, eq } from "drizzle-orm";
import type { WorkScope } from "../work-records/store";

const decisions = schema.workTriageDecisions;
const corrections = schema.workTriageCorrections;
const items = schema.workItems;

/** One stored triage decision. */
export interface StoredDecision {
  id: string;
  publicId: string;
  output: TriageDecision;
  model: string | null;
  prioritiesHash: string;
  itemRevision: number | null;
  costUsd: number | null;
  createdAt: string;
}

function toDecision(row: typeof decisions.$inferSelect): StoredDecision {
  return {
    id: row.id,
    publicId: row.publicId,
    output: row.output as unknown as TriageDecision,
    model: row.model,
    prioritiesHash: row.prioritiesHash,
    itemRevision: row.itemRevision,
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
    createdAt: row.createdAt.toISOString(),
  };
}

/** The item's latest decision, or null when triage has not decided. */
export async function latestDecision(tx: Tx, scope: WorkScope, itemId: string): Promise<StoredDecision | null> {
  const [row] = await tx
    .select()
    .from(decisions)
    .where(and(eq(decisions.itemId, itemId), eq(decisions.orgId, scope.orgId), eq(decisions.workspaceId, scope.workspaceId)))
    .orderBy(desc(decisions.createdAt), desc(decisions.id))
    .limit(1);
  return row ? toDecision(row) : null;
}

/** Every correction the item holds, oldest first, across all its decisions. */
export async function itemCorrections(tx: Tx, scope: WorkScope, itemId: string): Promise<TriageCorrection[]> {
  const rows = await tx
    .select({
      field: corrections.field,
      before: corrections.before,
      after: corrections.after,
      by: corrections.by,
      at: corrections.at,
    })
    .from(corrections)
    .innerJoin(decisions, eq(decisions.id, corrections.decisionId))
    .where(and(eq(decisions.itemId, itemId), eq(corrections.orgId, scope.orgId), eq(corrections.workspaceId, scope.workspaceId)))
    .orderBy(asc(corrections.at), asc(corrections.id));
  return rows.map((row) => ({
    field: row.field as TriageCorrectionField,
    before: row.before as TriageCorrection["before"],
    after: row.after as TriageCorrection["after"],
    by: row.by,
    at: row.at.toISOString(),
  }));
}

/** The item's triage suggestion with every correction in force. */
export async function readTriageView(tx: Tx, scope: WorkScope, itemId: string): Promise<{ view: TriageView; decision: StoredDecision | null }> {
  const decision = await latestDecision(tx, scope, itemId);
  const rows = await itemCorrections(tx, scope, itemId);
  return { view: effectiveTriage(decision?.output ?? null, decision?.publicId ?? null, rows), decision };
}

/** What a triage run stores beside its output. */
export interface NewDecision {
  itemId: string;
  output: TriageDecision;
  /** The model the client called. Null when it could not say. */
  model: string | null;
  promptDigest: Sha256Digest;
  prioritiesHash: Sha256Digest;
  inputDigest: Sha256Digest;
  /** Null when the cost is unknown. Never 0 in its place. */
  costUsd: number | null;
  itemRevision: number;
}

/** Store a decision and make it the item's current one. */
export async function insertDecision(tx: Tx, scope: WorkScope, input: NewDecision): Promise<{ id: string; publicId: string }> {
  const [row] = await tx
    .insert(decisions)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      itemId: input.itemId,
      output: input.output as unknown as Record<string, unknown>,
      model: input.model,
      promptDigest: input.promptDigest,
      prioritiesHash: input.prioritiesHash,
      inputDigest: input.inputDigest,
      costUsd: input.costUsd === null ? null : input.costUsd.toFixed(6),
      itemRevision: input.itemRevision,
    })
    .returning({ id: decisions.id, publicId: decisions.publicId });
  await tx
    .update(items)
    .set({ triageId: row!.id })
    .where(and(eq(items.id, input.itemId), eq(items.orgId, scope.orgId), eq(items.workspaceId, scope.workspaceId)));
  return { id: row!.id, publicId: row!.publicId };
}

/** Store a person's corrections against the decision they read. */
export async function insertCorrections(tx: Tx, scope: WorkScope, decisionId: string, rows: readonly TriageCorrection[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(corrections).values(
    rows.map((row) => ({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      decisionId,
      field: row.field,
      before: row.before,
      after: row.after,
      by: row.by,
      at: new Date(row.at),
    })),
  );
}
