// actions.ts: the writes and reads behind the work intake and triage
// capabilities (P1-03, #5103): manual entry, triage revision, the retry check,
// and the priorities summary. Each opens its own tenant transaction, so the
// handler that calls it runs inside the capability's tenant scope.
//
// A work item grants no authority. The handler checks the caller's role
// first, and every query here names the caller's org and workspace.
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import {
  type PriorityRule,
  type TriageCorrection,
  type TriageCorrectionField,
  type TriageFieldValues,
  type TriageView,
  correctionRows,
  priorityRules,
} from "@oxagen/work";
import { type WorkItemProjection, WorkRecordError } from "@oxagen/work/records";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { appendFacts, readWorkItem, recordSource, type WorkScope } from "../work-records/store";
import { insertManualItem, sourceDedupeKey } from "./items";
import { prioritiesProblem, readPriorities } from "./priorities";
import { screenText } from "./screen";
import { insertCorrections, readTriageView } from "./triage-store";
import { TRIAGE_STATES_OPEN } from "./triage-run";

const items = schema.workItems;

/** A work item row the actions read by public id. */
export interface ItemRef {
  id: string;
  publicId: string;
  number: string;
}

/** The workspace's live item for a public id, or null. */
export async function findItem(tx: Tx, scope: WorkScope, publicId: string): Promise<ItemRef | null> {
  const [row] = await tx
    .select({ id: items.id, publicId: items.publicId, number: items.number, deletedAt: items.deletedAt })
    .from(items)
    .where(and(eq(items.publicId, publicId), eq(items.orgId, scope.orgId), eq(items.workspaceId, scope.workspaceId)))
    .limit(1);
  if (!row || row.deletedAt !== null) return null;
  return { id: row.id, publicId: row.publicId, number: row.number };
}

// ---------------------------------------------------------------------------
// Manual entry
// ---------------------------------------------------------------------------

export interface EnterItemInput {
  subject: string;
  description: string | null;
  labels: string[];
  repository: string | null;
  actorUserId: string;
}

export interface EnteredItem extends ItemRef {
  state: WorkItemProjection["state"];
  revision: number;
  version: number;
}

/**
 * Enter a work item by hand. The subject, description, and labels pass the
 * credential screen before they are stored, and the item records an `entered`
 * fact on revision 1.
 */
export async function enterWorkItem(scope: WorkScope, input: EnterItemInput): Promise<EnteredItem> {
  const subject = screenText(input.subject).text.trim();
  const description = input.description === null ? null : screenText(input.description).text;
  const labels = [...new Set(input.labels.map((label) => screenText(label).text.trim()).filter((label) => label !== ""))];
  if (subject === "") throw new WorkRecordError("invalid_input", "The subject is empty once its control characters are removed.");
  return withTenantDb(async (tx) => {
    const row = await insertManualItem(tx, scope, {
      subject,
      description,
      labels,
      repository: input.repository,
      actorUserId: input.actorUserId,
      requester: null,
    });
    const material = { subject, description, labels };
    const occurredAt = new Date().toISOString();
    const written = await recordSource(tx, scope, {
      itemId: row.id,
      material,
      source: "person",
      actor: input.actorUserId,
      occurredAt,
      dedupeKey: sourceDedupeKey(material, occurredAt),
      actorUserId: input.actorUserId,
    });
    return {
      id: row.id,
      publicId: row.publicId,
      number: row.number,
      state: written.projection.state,
      revision: written.projection.revision,
      version: written.version,
    };
  });
}

// ---------------------------------------------------------------------------
// Triage revision
// ---------------------------------------------------------------------------

/** The fields a revision may set or clear, as revise_work_triage names them. */
export type ReviseFields = Partial<{ [F in TriageCorrectionField]: TriageFieldValues[F] | null }>;

export interface ReviseInput {
  itemPublicId: string;
  expectedVersion: number;
  reason: string;
  fields: ReviseFields;
  /** Undefined leaves the outcome. Null clears a person's override. */
  outcome?: "triaged" | "needs_info" | "duplicate" | "out_of_scope" | null;
  duplicateOf?: string;
  actorUserId: string;
}

export interface ReviseResult {
  item: ItemRef;
  version: number;
  state: WorkItemProjection["state"];
  changed: Array<TriageCorrectionField | "outcome">;
  view: TriageView;
  standing: WorkItemProjection["triage"];
}

/**
 * Apply a person's revision. The outcome goes through the work record store
 * as a triage_overridden fact, which checks the version and moves it. Field
 * corrections are rows against the current decision, and when they are the
 * whole revision they move the version themselves, under the row lock, so a
 * revision made on a stale read is refused either way.
 */
export async function reviseTriage(scope: WorkScope, input: ReviseInput): Promise<ReviseResult> {
  return withTenantDb(async (tx) => {
    const item = await findItem(tx, scope, input.itemPublicId);
    if (item === null) throw new WorkRecordError("not_found", `This workspace has no work item ${input.itemPublicId}.`);
    // Lock the row so the version read here is the version this write moves.
    await tx.select({ id: items.id }).from(items).where(eq(items.id, item.id)).for("update");
    const record = await readWorkItem(tx, scope, item.id);
    if (record.version !== input.expectedVersion) {
      throw new WorkRecordError(
        "stale_version",
        `You read version ${input.expectedVersion} of the work item, and it is now at version ${record.version}. Read it again.`,
      );
    }
    if (!TRIAGE_STATES_OPEN.includes(record.projection.state)) {
      throw new WorkRecordError(
        "not_allowed",
        `The work item is ${record.projection.state}. Triage can change only while it is new, held, triaged, needs_info, or changed.`,
      );
    }

    const { view, decision } = await readTriageView(tx, scope, item.id);
    const at = new Date().toISOString();
    const rows: TriageCorrection[] = correctionRows(view, input.fields, input.actorUserId, at);
    if (rows.length > 0 && decision === null) {
      throw new WorkRecordError(
        "not_allowed",
        "Triage has no suggestion on this item to correct. Set the outcome, or retry triage first.",
      );
    }

    let duplicateOf: string | null = null;
    if (input.outcome === "duplicate") {
      const target = input.duplicateOf === undefined ? null : await findItem(tx, scope, input.duplicateOf);
      if (target === null || target.id === item.id) {
        throw new WorkRecordError("not_found", `This workspace has no other work item ${input.duplicateOf ?? ""} for this one to repeat.`.trim());
      }
      duplicateOf = target.publicId;
    }

    const changed: ReviseResult["changed"] = rows.map((row) => row.field);
    let version = record.version;
    let projection = record.projection;
    if (input.outcome !== undefined) {
      const written = await appendFacts(tx, scope, {
        itemId: item.id,
        expectedVersion: input.expectedVersion,
        actorUserId: input.actorUserId,
        facts: [
          {
            kind: "triage_overridden",
            source: "person",
            itemRevision: record.projection.revision,
            actor: input.actorUserId,
            occurredAt: at,
            dedupeKey: `triage_overridden:${at}`,
            data: { outcome: input.outcome, duplicate_of: duplicateOf, reason: input.reason },
          },
        ],
      });
      if (!written.repeat) changed.push("outcome");
      version = written.version;
      projection = written.projection;
    }

    if (rows.length > 0) {
      await insertCorrections(tx, scope, decision!.id, rows);
      const priority = rows.find((row) => row.field === "priority");
      const planning =
        priority === undefined
          ? undefined
          : priority.after === null
            ? null
            : { label: priority.after as "P0" | "P1" | "P2" | "P3", by: input.actorUserId, why: input.reason, at };
      await tx
        .update(items)
        .set({
          ...(planning === undefined ? {} : { planningPriority: planning }),
          // With no outcome, the corrections alone are the revision, so they move the version.
          ...(input.outcome === undefined ? { version: sql`${items.version} + 1` } : {}),
          updatedAt: sql`now()`,
          updatedById: input.actorUserId,
        })
        .where(and(eq(items.id, item.id), eq(items.orgId, scope.orgId), eq(items.workspaceId, scope.workspaceId)));
      if (input.outcome === undefined) version += 1;
    }

    const after = await readTriageView(tx, scope, item.id);
    return { item, version, state: projection.state, changed, view: after.view, standing: projection.triage };
  });
}

/** The item's triage view and standing, read without writing. */
export async function readTriageStanding(scope: WorkScope, itemPublicId: string) {
  return withTenantDb(async (tx) => {
    const item = await findItem(tx, scope, itemPublicId);
    if (item === null) return null;
    const record = await readWorkItem(tx, scope, item.id);
    const { view } = await readTriageView(tx, scope, item.id);
    return { item, state: record.projection.state, version: record.version, view, standing: record.projection.triage };
  });
}

// ---------------------------------------------------------------------------
// Priorities
// ---------------------------------------------------------------------------

export interface PrioritiesSummary {
  record: {
    lineage: string;
    recordId: string;
    version: number;
    hash: string;
    rules: PriorityRule[];
    publishedAt: string | null;
  } | null;
  problem: string | null;
  last30Days: { suggestions: number; failures: number; corrections: number };
}

/** The priorities record triage reads, and triage's last 30 days in the workspace. */
export async function prioritiesSummary(scope: WorkScope, now: Date = new Date()): Promise<PrioritiesSummary> {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return withTenantDb(async (tx) => {
    const read = await readPriorities(tx, scope);
    const facts = schema.workItemFacts;
    const kinds = await tx
      .select({ kind: facts.kind, n: count() })
      .from(facts)
      .where(
        and(
          eq(facts.orgId, scope.orgId),
          eq(facts.workspaceId, scope.workspaceId),
          inArray(facts.kind, ["triage_recorded", "triage_failed"]),
          gte(facts.createdAt, since),
        ),
      )
      .groupBy(facts.kind);
    const corrections = schema.workTriageCorrections;
    const [corrected] = await tx
      .select({ n: count() })
      .from(corrections)
      .where(and(eq(corrections.orgId, scope.orgId), eq(corrections.workspaceId, scope.workspaceId), gte(corrections.at, since)));
    const countOf = (kind: string) => Number(kinds.find((row) => row.kind === kind)?.n ?? 0);
    return {
      record:
        read.kind === "found"
          ? {
              lineage: read.record.lineage,
              recordId: read.record.recordId,
              version: read.record.version,
              hash: read.record.hash,
              rules: priorityRules(read.record.body),
              publishedAt: read.record.publishedAt,
            }
          : null,
      problem: read.kind === "found" ? null : prioritiesProblem(read),
      last30Days: {
        suggestions: countOf("triage_recorded"),
        failures: countOf("triage_failed"),
        corrections: Number(corrected?.n ?? 0),
      },
    };
  });
}
