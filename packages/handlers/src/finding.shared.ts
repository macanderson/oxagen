// finding.shared.ts — what the finding handlers share: the Postgres reads and
// the one decision write over `cost.findings`, and the mapping from a row to
// the contract's finding and evidence shapes (ADR-062).
//
// The kernel enters the tenant scope before a handler runs, so every
// statement goes through withTenantDb, whose RLS is the tenant filter; the
// queries also name org_id and workspace_id, since a local stack runs with
// the RLS bypass on. The saving and its basis are the findings job's figures
// as stored (INV-09, INV-10): nothing here re-estimates them.
import type { FindingEvidence as StoredEvidence } from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import {
  findingValuesSchema,
  type Finding,
  type FindingEvidence,
  type FindingRunCitation,
  type FindingValues,
} from "@oxagen/oxagen/contracts/finding.shared";
import { FINDINGS_LIST_MAX } from "@oxagen/oxagen/contracts/finding.list";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  and,
  arrayContains,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { isCursorInstant } from "./lib/cursor-instant";

export type FindingScope = { orgId: string; workspaceId: string };
export type FindingRow = typeof schema.findings.$inferSelect;
export type FindingStatus = Finding["status"];
type FindingLevel = Finding["level"];

/**
 * Which findings a list reads: one status, and optionally only those citing
 * one run, only those at one level, and only those about one subject (#5303).
 */
export type FindingFilter = {
  status: FindingStatus;
  runId?: string;
  level?: FindingLevel;
  subject?: string;
};

const findings = schema.findings;

export function findingScope(ctx: FindingScope): FindingScope {
  return { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
}

function money(micros: string, currency: string) {
  return { micros, currency };
}

/**
 * The kind's figures as the findings job stored them (#5023). A row written
 * before the job stored them carries none, and so does a blob that does not
 * parse or names another kind: the card then shows the detector's own text,
 * and one bad row cannot fail the whole list.
 */
function valuesOf(
  row: FindingRow,
  evidence: StoredEvidence,
): FindingValues | undefined {
  if (evidence.values === undefined) return undefined;
  const parsed = findingValuesSchema.safeParse(evidence.values);
  if (!parsed.success || parsed.data.kind !== row.kind) return undefined;
  return parsed.data;
}

export function toFinding(row: FindingRow): Finding {
  const evidence = row.citedFrames as StoredEvidence;
  const values = valuesOf(row, evidence);
  return {
    id: row.publicId,
    kind: row.kind as Finding["kind"],
    level: row.level as Finding["level"],
    subject: row.subject,
    saving: {
      micros: row.estimatedSavingMicros.toString(),
      currency: row.currency,
      basis: row.savingBasis as Finding["saving"]["basis"],
    },
    confidence: row.confidence as Finding["confidence"],
    window: {
      from: row.windowStart.toISOString(),
      to: row.windowEnd.toISOString(),
    },
    why: row.why,
    fix: row.fix,
    // A row written before a detector named a setting carries none.
    ...(evidence.recommendation === undefined
      ? {}
      : { recommendation: { ...evidence.recommendation } }),
    ...(values === undefined ? {} : { values }),
    runs: row.citedRuns.length,
    calls: evidence.calls,
    status: row.status as FindingStatus,
    detectedAt: row.detectedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    appliedActionId: row.appliedActionId,
  };
}

/** The runs the row's evidence itemises, in its order. */
export function evidenceRunIds(row: FindingRow): string[] {
  return (row.citedFrames as StoredEvidence).runs.map((r) => r.runId);
}

/**
 * The stored arithmetic as the contract's money shapes. `names` holds each
 * itemised run's session name, and a run missing from it reads as unnamed.
 */
export function toEvidence(
  row: FindingRow,
  names: ReadonlyMap<string, string | null>,
): FindingEvidence {
  const e = row.citedFrames as StoredEvidence;
  return {
    calls: e.calls,
    coveredCalls: e.coveredCalls,
    measuredTokens: e.measuredTokens,
    counterfactualTokens: e.counterfactualTokens,
    measured: money(e.measuredMicros, row.currency),
    counterfactual: money(e.counterfactualMicros, row.currency),
    runs: e.runs.map((r) => ({
      runId: r.runId,
      name: names.get(r.runId) ?? null,
      startedAt: r.startedAt,
      calls: r.calls,
      measuredTokens: r.measuredTokens,
      counterfactualTokens: r.counterfactualTokens,
      measured: money(r.measuredMicros, row.currency),
      counterfactual: money(r.counterfactualMicros, row.currency),
    })),
  };
}

/**
 * The kinds whose detectors cite each run as a whole and store no frames:
 * cache writes never read, the standing context every request re-sends, and
 * the model class a run could have used. Each prices the run, not a call.
 */
const RUN_LEVEL_KINDS: ReadonlySet<string> = new Set([
  "cache_writes_never_read",
  "standing_context",
  "model_class_fit",
]);

/**
 * What a finding cites in one run (#4001). A finding of a
 * {@link RUN_LEVEL_KINDS} kind cites the run as a whole and pins no turn. A
 * tool-call finding answers the frames the findings job stored for the run,
 * or null frames on a row written before frames were stored. Its total then falls back to the calls the
 * evidence counted in the run. That evidence itemises only the ten runs with
 * the largest saving, so a run past them has no total and answers null.
 */
export function citationOf(row: FindingRow, runId: string): FindingRunCitation {
  if (RUN_LEVEL_KINDS.has(row.kind))
    return { runId, runLevel: true, frames: [], framesTotal: 0 };
  const evidence = row.citedFrames as StoredEvidence;
  const cited = evidence.frames?.[runId];
  if (cited === undefined)
    return {
      runId,
      runLevel: false,
      frames: null,
      framesTotal:
        evidence.runs.find((r) => r.runId === runId)?.calls ?? null,
    };
  return {
    runId,
    runLevel: false,
    frames: cited.seqs.map((f) =>
      f.sessionUuid === undefined
        ? { seq: f.seq }
        : { seq: f.seq, sessionUuid: f.sessionUuid },
    ),
    framesTotal: cited.total,
  };
}

/**
 * The findings a list matches: one status, with a run only those citing it,
 * and with a level or a subject only those at that level or about that key.
 */
function matching(scope: FindingScope, filter: FindingFilter) {
  return and(
    eq(findings.orgId, scope.orgId),
    eq(findings.workspaceId, scope.workspaceId),
    eq(findings.status, filter.status),
    filter.runId === undefined
      ? undefined
      : arrayContains(findings.citedRuns, [filter.runId]),
    filter.level === undefined ? undefined : eq(findings.level, filter.level),
    filter.subject === undefined
      ? undefined
      : eq(findings.subject, filter.subject),
  );
}

/**
 * The decision instant at millisecond precision. A cursor carries the
 * instant as a JavaScript date, which holds milliseconds, so the order and
 * the cursor compare the same value. Postgres keeps microseconds, and two
 * decisions in one millisecond then fall back to the id.
 */
const decidedAtMs = sql`date_trunc('milliseconds', ${findings.decidedAt})`;

/**
 * A list's order: open by saving, decided by most recent decision. The id
 * breaks ties, so the findings past FINDINGS_LIST_MAX are the same on every
 * read, and a cursor holds one place in the order (#5303). The table's
 * decision check gives every decided row a decision instant. Were one
 * missing, Postgres would sort it first, and the cursor allows for that.
 */
function listOrder(filter: FindingFilter) {
  return [
    filter.status === "open"
      ? desc(findings.estimatedSavingMicros)
      : desc(decidedAtMs),
    asc(findings.id),
  ];
}

/**
 * Where a page ended (#5303): the last finding's place in the list order,
 * and how many findings the pages up to it held. `key` is the saving in
 * micros for an open list, and the decision instant for a decided list.
 */
export type FindingCursor = {
  status: FindingStatus;
  key: string | null;
  id: string;
  /** The findings before the page this cursor reads. */
  offset: number;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A saving in micros: a positive bigint, as the column's check holds it. */
const MICROS_RE = /^[1-9]\d{0,18}$/;
const BIGINT_MAX = 9_223_372_036_854_775_807n;
const STATUSES: readonly string[] = ["open", "applied", "dismissed"];

function isStatus(value: unknown): value is FindingStatus {
  return typeof value === "string" && STATUSES.includes(value);
}

/** The cursor that reads the page after `row`, the last finding of a page. */
export function cursorAfter(
  status: FindingStatus,
  row: Pick<FindingRow, "id" | "estimatedSavingMicros" | "decidedAt">,
  offset: number,
): string {
  const key =
    status === "open"
      ? row.estimatedSavingMicros.toString()
      : (row.decidedAt?.toISOString() ?? null);
  return Buffer.from(
    JSON.stringify([status, key, row.id, offset]),
    "utf8",
  ).toString("base64url");
}

/** Null for anything that is not a cursor this handler wrote. */
export function decodeFindingCursor(raw: string): FindingCursor | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (!Array.isArray(value) || value.length !== 4) return null;
    const [status, key, id, offset] = value as unknown[];
    if (
      !isStatus(status) ||
      typeof id !== "string" ||
      !UUID_RE.test(id) ||
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      return null;
    if (status === "open") {
      // Past the bigint range, Postgres would refuse the value with a 500.
      if (
        typeof key !== "string" ||
        !MICROS_RE.test(key) ||
        BigInt(key) > BIGINT_MAX
      )
        return null;
      return { status, key, id, offset };
    }
    if (key === null) return { status, key: null, id, offset };
    if (typeof key !== "string" || !isCursorInstant(key)) return null;
    return { status, key, id, offset };
  } catch {
    // Not base64url JSON: a hand-edited or foreign cursor.
    return null;
  }
}

/** The findings after the cursor in the list order: the next page's rows. */
function afterCursor(cursor: FindingCursor | null): SQL | undefined {
  if (cursor === null) return undefined;
  if (cursor.status === "open") {
    const saving = BigInt(cursor.key ?? "0");
    return or(
      lt(findings.estimatedSavingMicros, saving),
      and(
        eq(findings.estimatedSavingMicros, saving),
        gt(findings.id, cursor.id),
      ),
    );
  }
  // A row with no decision instant sorts before every row with one.
  if (cursor.key === null)
    return or(
      and(isNull(findings.decidedAt), gt(findings.id, cursor.id)),
      isNotNull(findings.decidedAt),
    );
  const at = new Date(cursor.key);
  return or(
    lt(decidedAtMs, at),
    and(eq(decidedAtMs, at), gt(findings.id, cursor.id)),
  );
}

/**
 * One page of a workspace's findings in one status, in list order: at most
 * FINDINGS_LIST_MAX, plus one more when a later page exists. With a cursor,
 * the page starts after the finding it names. The filter narrows the page
 * as `matching` says.
 */
export async function readFindingRows(
  scope: FindingScope,
  filter: FindingFilter,
  after: FindingCursor | null = null,
): Promise<FindingRow[]> {
  return withTenantDb((tx) =>
    tx
      .select()
      .from(findings)
      .where(and(matching(scope, filter), afterCursor(after)))
      .orderBy(...listOrder(filter))
      .limit(FINDINGS_LIST_MAX + 1),
  );
}

/**
 * What a list's counts and totals read from one finding: its figures, and
 * the operators its cited runs name. The evidence stays unread, since a
 * workspace can hold more findings than one answer lists (#5262).
 */
export type FindingTotalRow = Pick<
  FindingRow,
  | "confidence"
  | "estimatedSavingMicros"
  | "currency"
  | "savingBasis"
  | "windowStart"
  | "windowEnd"
> & { operatorKeys: readonly string[] };

/** The operator keys the stored evidence lists, from their JSON text. */
function keysOf(text: string | null): string[] {
  if (text === null) return [];
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed)
    ? parsed.filter((key): key is string => typeof key === "string")
    : [];
}

/**
 * Every finding a list matches, in list order and with no limit or cursor,
 * as the figures its counts and totals read. A page answers at most
 * FINDINGS_LIST_MAX findings, and its counts and totals still cover all of
 * them, on every page.
 */
export async function readFindingTotals(
  scope: FindingScope,
  filter: FindingFilter,
): Promise<FindingTotalRow[]> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        confidence: findings.confidence,
        estimatedSavingMicros: findings.estimatedSavingMicros,
        currency: findings.currency,
        savingBasis: findings.savingBasis,
        windowStart: findings.windowStart,
        windowEnd: findings.windowEnd,
        // As JSON text, so any stored shape parses.
        operatorKeys: sql<
          string | null
        >`(${findings.citedFrames} -> 'operatorKeys')::text`,
      })
      .from(findings)
      .where(matching(scope, filter))
      .orderBy(...listOrder(filter)),
  );
  return rows.map(({ operatorKeys, ...row }) => ({
    ...row,
    operatorKeys: keysOf(operatorKeys),
  }));
}

export async function readFindingRow(
  scope: FindingScope,
  publicId: string,
): Promise<FindingRow | null> {
  const rows = await withTenantDb((tx) =>
    tx
      .select()
      .from(findings)
      .where(
        and(
          eq(findings.orgId, scope.orgId),
          eq(findings.workspaceId, scope.workspaceId),
          eq(findings.publicId, publicId),
        ),
      )
      .limit(1),
  );
  return rows[0] ?? null;
}

export interface FindingDecision {
  status: "applied" | "dismissed";
  decidedAt: Date;
  decidedByUserId: string | null;
  appliedActionId: string | null;
}

/** Decide an open finding; null when no open finding has the id. */
export async function decideFindingRow(
  scope: FindingScope,
  publicId: string,
  decision: FindingDecision,
): Promise<FindingRow | null> {
  const rows = await withTenantDb((tx) =>
    tx
      .update(findings)
      .set(decision)
      .where(
        and(
          eq(findings.orgId, scope.orgId),
          eq(findings.workspaceId, scope.workspaceId),
          eq(findings.publicId, publicId),
          eq(findings.status, "open"),
        ),
      )
      .returning(),
  );
  return rows[0] ?? null;
}

export const findingNotFound = () =>
  new HandlerError({
    code: "not_found",
    reason: "finding_not_found",
    message: "No finding with this id in the workspace",
  });

export type FindingDecisionDeps = {
  decide: typeof decideFindingRow;
  read: typeof readFindingRow;
  now: () => Date;
};

export const findingDecisionDeps: FindingDecisionDeps = {
  decide: decideFindingRow,
  read: readFindingRow,
  now: () => new Date(),
};

/**
 * Take a decision on an open finding. A finding someone already applied or
 * dismissed is a conflict, so two people deciding at once leave one decision
 * and one refusal.
 */
export async function decideFinding(
  deps: FindingDecisionDeps,
  scope: FindingScope,
  findingId: string,
  decision: Omit<FindingDecision, "decidedAt">,
): Promise<{ finding: Finding }> {
  const row = await deps.decide(scope, findingId, {
    ...decision,
    decidedAt: deps.now(),
  });
  if (row) return { finding: toFinding(row) };
  if (!(await deps.read(scope, findingId))) throw findingNotFound();
  throw new HandlerError({
    code: "conflict",
    reason: "finding_not_open",
    message: "The finding has already been applied or dismissed",
  });
}
