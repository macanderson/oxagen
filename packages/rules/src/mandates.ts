/**
 * The mandate ledger writer and the decision-time check (MC spec §6.9 part
 * 3, ADR-059 decisions 4 and 5).
 *
 * `tools.mandate_ledger` is append-only movements on a mandate's remaining
 * authority, one row per measure. Every write here runs inside one
 * transaction that first takes `SELECT … FOR UPDATE` on the mandate row, so
 * concurrent calls serialise and two cannot both fit under one remaining
 * limit. Remaining authority is the limit's `perPeriod` less the period's
 * open reservations and settlements, computed under the lock from the
 * ledger's rows; `balance_after` records that figure after each row, and
 * every read reports the same formula. The unique index
 * `(mandate_id, tool_call_id, measure, kind)` is the database backstop.
 *
 * `checkMandate` is what the decision gate runs for an agent principal:
 * it looks the capability up as a declared tool, reads the version's
 * consequence tags and measures, finds the covering mandate, reserves, and
 * either lets the call proceed, parks it for a person, or refuses it.
 */
import { randomUUID } from "node:crypto";
import { schema, withTenantDb, type Tx } from "@oxagen/database";
// The subpath, not the package root: the root barrel side-effect-imports
// every contract, and this module sits on the import graph of every
// service that boots the rules gate.
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  CapabilityError,
  type DecisionSettlement,
} from "@oxagen/oxagen/kernel";
import {
  mandateApprovalSchema,
  mandateLimitsSchema,
  mandateStatusSchema,
  mandateTargetsSchema,
  type MandateApproval,
  type MandateAuthority,
  type MandateLimits,
  type MandatePeriod,
  type MandateStatus,
  type MandateTargets,
} from "@oxagen/oxagen/mandates/schemas";
import { and, asc, eq, gt, isNull, lte, sql, type SQL } from "drizzle-orm";
import { evaluateAutoApproval } from "./auto-approval";
import {
  buildAutoApprovalSubject,
  inputDigest,
  loadDeclaredTool,
  type DeclaredTool,
} from "./call-facts";
import { logger } from "./logger";
import { notifyApprovalRequested } from "./approval-notify";
import { loadRuleSetIn } from "./rule-store";
import {
  exceeds,
  isCallsMeasure,
  legacyMeasureKindGuess,
  measureKindOf,
  periodKey,
  periodKeyRange,
  periodKeysOverlap,
  readCallsMeasure,
  readMeasure,
  readPath,
  remainingAfter,
  targetAllowed,
  toolMatches,
} from "./mandates/measures";

const m = schema.mandates;
const l = schema.mandateLedger;

/**
 * How long a call parked by a mandate's approval rule waits for a person.
 * The chat gate's five minutes fits a stream that is waiting; a mandate
 * parks the call and refuses it, and the agent retries once a person has
 * looked, so the window is a working day.
 */
export const MANDATE_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** The reasons the gate refuses a call outright; each is a `mandate.exception`. */
type MandateDenyReason =
  | "no_mandate"
  | "measure_unreadable"
  | "measure_kind_changed"
  | "target_denied"
  | "over_limit";

/** A mandate row with its jsonb columns parsed. */
export interface MandateRecord {
  id: string;
  publicId: string;
  orgId: string;
  workspaceId: string;
  agentPrincipalId: string;
  consequenceTags: string[];
  limits: MandateLimits;
  targets: MandateTargets;
  tools: string[];
  approval: MandateApproval;
  status: MandateStatus;
  validFrom: Date;
  validTo: Date;
}

/**
 * Every stored limit with `kind` guaranteed present (ADR-108): a row written
 * since ADR-108 already carries it, and a row written before takes the one
 * documented fallback, `legacyMeasureKindGuess`. This is the only place that
 * fallback runs; every reader downstream (`readAuthority`, `mapMandates`,
 * the mapped `mandate.limits` a get/list response carries) takes `kind` as a
 * fact already resolved, never guessing again from `currencyOrUnit` itself.
 */
function withResolvedKinds(limits: MandateLimits): MandateLimits {
  return Object.fromEntries(
    Object.entries(limits).map(([measure, limit]) => [
      measure,
      {
        ...limit,
        kind: limit.kind ?? legacyMeasureKindGuess(limit.currencyOrUnit),
      },
    ]),
  );
}

export function parseMandateRow(row: typeof m.$inferSelect): MandateRecord {
  return {
    id: row.id,
    publicId: row.publicId,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    agentPrincipalId: row.agentPrincipalId,
    consequenceTags: row.consequenceTags,
    limits: withResolvedKinds(mandateLimitsSchema.parse(row.limits)),
    targets: mandateTargetsSchema.parse(row.targets),
    tools: row.tools,
    approval: mandateApprovalSchema.parse(row.approvalRules),
    status: mandateStatusSchema.parse(row.status),
    validFrom: row.validFrom,
    validTo: row.validTo,
  };
}

/** Take the row lock every ledger write serialises on. */
export async function lockMandate(
  tx: Tx,
  mandateId: string,
): Promise<MandateRecord | null> {
  const [row] = await tx
    .select()
    .from(m)
    .where(eq(m.id, mandateId))
    .for("update");
  return row ? parseMandateRow(row) : null;
}

/**
 * What a period has drawn for one measure, from the ledger: its open
 * reservations, its settlements, and `drawn`, their sum, which the limit's
 * `perPeriod` is measured against. Computed under the lock from the rows,
 * so a `perPeriod` changed inside a period applies to the next reservation
 * and to what get_mandate reports.
 */
async function periodSums(
  tx: Tx,
  mandateId: string,
  measure: string,
  period: string,
): Promise<{ reserved: bigint; settled: bigint; drawn: bigint }> {
  const [row] = await tx
    .select({
      reserved: sql<string>`coalesce(sum(case when ${l.kind} = 'reserve' then ${l.value} else -${l.value} end), 0)::text`,
      settled: sql<string>`coalesce(sum(case when ${l.kind} = 'settle' then ${l.value} else 0 end), 0)::text`,
    })
    .from(l)
    .where(
      and(
        eq(l.mandateId, mandateId),
        eq(l.measure, measure),
        eq(l.periodKey, period),
      ),
    );
  const reserved = BigInt(row?.reserved ?? "0");
  const settled = BigInt(row?.settled ?? "0");
  return { reserved, settled, drawn: reserved + settled };
}

/**
 * Whether this measure has already drawn authority in the window its current
 * period names. A period change that ran while drawn would leave those ledger
 * rows under the old `periodKey`, so `readAuthority` and `reserve` would see an
 * empty new window and grant the full cap again.
 */
export async function hasDrawnInCurrentPeriod(
  tx: Tx,
  mandateId: string,
  measure: string,
  period: MandatePeriod,
  at: Date = new Date(),
): Promise<boolean> {
  const sums = await periodSums(tx, mandateId, measure, periodKey(period, at));
  return sums.drawn > 0n;
}

/**
 * Whether this measure still has an open reservation under any period key.
 *
 * A call parked for approval can keep its reserve row past the old window's
 * boundary. `hasDrawnInCurrentPeriod` only sees the key the stored period
 * names today, so a midnight rollover would miss that row and let a period
 * rename orphan it. Settled and released rows net to zero here; only a
 * reserve with no matching settle or release counts.
 */
export async function hasOpenReservation(
  tx: Tx,
  mandateId: string,
  measure: string,
): Promise<boolean> {
  const [row] = await tx
    .select({
      reserved: sql<string>`coalesce(sum(case when ${l.kind} = 'reserve' then ${l.value} else -${l.value} end), 0)::text`,
    })
    .from(l)
    .where(and(eq(l.mandateId, mandateId), eq(l.measure, measure)));
  return BigInt(row?.reserved ?? "0") > 0n;
}

/**
 * Whether this measure has a settlement under a period key whose calendar
 * range overlaps the destination period's current window.
 *
 * A daily-to-weekly rename on Tuesday leaves Monday's settle under Monday's
 * daily key. `hasDrawnInCurrentPeriod` only queries Tuesday, and
 * `hasOpenReservation` ignores settled rows, so without this check the
 * rename would succeed and weekly reads would see an empty `YYYY-Www` key.
 * The ledger stays append-only: the rename is refused, not rewritten.
 */
export async function hasSettlementOverlappingPeriod(
  tx: Tx,
  mandateId: string,
  measure: string,
  destPeriod: MandatePeriod,
  at: Date = new Date(),
): Promise<boolean> {
  const destKey = periodKey(destPeriod, at);
  const rows = await tx
    .select({
      periodKey: l.periodKey,
      settled: sql<string>`coalesce(sum(case when ${l.kind} = 'settle' then ${l.value} else 0 end), 0)::text`,
    })
    .from(l)
    .where(and(eq(l.mandateId, mandateId), eq(l.measure, measure)))
    .groupBy(l.periodKey);
  for (const row of rows) {
    if (BigInt(row.settled) <= 0n) continue;
    // An unparseable settled key is treated as overlapping: refuse rather
    // than hide a draw the destination window cannot query.
    if (
      !periodKeyRange(row.periodKey) ||
      periodKeysOverlap(row.periodKey, destKey)
    ) {
      return true;
    }
  }
  return false;
}

/** Remaining authority by measure, as get_mandate and list_mandates report it. */
export async function readAuthority(
  tx: Tx,
  mandate: MandateRecord,
  at: Date = new Date(),
): Promise<MandateAuthority[]> {
  const out: MandateAuthority[] = [];
  // jsonb stores keys in its own order; the report is by measure name.
  const limits = Object.entries(mandate.limits).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [measure, limit] of limits) {
    const key = periodKey(limit.period, at);
    const sums = await periodSums(tx, mandate.id, measure, key);
    out.push({
      measure,
      currencyOrUnit: limit.currencyOrUnit,
      // `mandate.limits` is resolved by `withResolvedKinds` in
      // `parseMandateRow` before it reaches here, so `limit.kind` is already
      // the fact; the fallback below is defensive, not a second guessing site.
      kind: limit.kind ?? legacyMeasureKindGuess(limit.currencyOrUnit),
      period: limit.period,
      periodKey: key,
      perCall: limit.perCall ?? null,
      perPeriod: limit.perPeriod ?? null,
      settled: sums.settled.toString(),
      reserved: sums.reserved.toString(),
      remaining:
        limit.perPeriod === undefined
          ? null
          : remainingAfter(limit.perPeriod, sums.drawn),
    });
  }
  return out;
}

interface ReserveArgs {
  mandate: MandateRecord;
  toolCallId: string;
  /** measure → value to reserve; every measure the mandate limits must be present. */
  values: Record<string, string>;
  at: Date;
}

type ReserveResult =
  | { ok: true }
  | { ok: false; reason: "over_limit"; measure: string; detail: string };

/**
 * Reserve authority for one call under the lock the caller holds. Per-call
 * limits are checked against the value, per-period limits against the
 * period's remaining authority; a refusal writes nothing and the mandate
 * stays as it was. A measure limited per call only has no period authority
 * and its rows carry `0`.
 */
export async function reserve(
  tx: Tx,
  args: ReserveArgs,
): Promise<ReserveResult> {
  const { mandate, toolCallId, values, at } = args;
  const rows: (Omit<typeof l.$inferInsert, "createdAt"> & {
    createdAt: SQL;
  })[] = [];
  for (const [measure, limit] of Object.entries(mandate.limits)) {
    const value = values[measure];
    if (value === undefined) {
      throw new Error(`reserve: no value for measure "${measure}"`);
    }
    if (limit.perCall !== undefined && exceeds(value, limit.perCall)) {
      return {
        ok: false,
        reason: "over_limit",
        measure,
        detail: `${value} exceeds per-call limit ${limit.perCall} ${limit.currencyOrUnit}`,
      };
    }
    const key = periodKey(limit.period, at);
    let balanceAfter = "0";
    if (limit.perPeriod !== undefined) {
      const sums = await periodSums(tx, mandate.id, measure, key);
      const remaining = remainingAfter(limit.perPeriod, sums.drawn);
      if (exceeds(value, remaining)) {
        return {
          ok: false,
          reason: "over_limit",
          measure,
          detail: `${value} exceeds remaining ${remaining} ${limit.currencyOrUnit} this ${limit.period} period`,
        };
      }
      balanceAfter = remainingAfter(
        limit.perPeriod,
        sums.drawn + BigInt(value),
      );
    }
    rows.push({
      orgId: mandate.orgId,
      workspaceId: mandate.workspaceId,
      mandateId: mandate.id,
      toolCallId,
      kind: "reserve",
      measure,
      value,
      unitOrCurrency: limit.currencyOrUnit,
      periodKey: key,
      balanceAfter,
      // The insert time under the lock, so "last row" is well ordered across
      // transactions; now() would be each transaction's start time.
      createdAt: sql`clock_timestamp()`,
    });
  }
  if (rows.length > 0) await tx.insert(l).values(rows);
  return { ok: true };
}

/** The reserve rows of one call that no settle or release has closed yet. */
async function openReservations(tx: Tx, mandateId: string, toolCallId: string) {
  const rows = await tx
    .select()
    .from(l)
    .where(and(eq(l.mandateId, mandateId), eq(l.toolCallId, toolCallId)))
    .orderBy(asc(l.createdAt));
  const closed = new Set(
    rows.filter((r) => r.kind !== "reserve").map((r) => r.measure),
  );
  return rows.filter((r) => r.kind === "reserve" && !closed.has(r.measure));
}

/**
 * Close a call's open reservations with one row each of `kind`, under the
 * lock the caller holds: `settle` leaves remaining unchanged, `release`
 * raises it by the reserved value. Idempotent: a call already closed
 * writes nothing.
 */
async function closeReservations(
  tx: Tx,
  mandate: MandateRecord,
  toolCallId: string,
  kind: "settle" | "release",
  externalEffectId: string | null,
): Promise<number> {
  const open = await openReservations(tx, mandate.id, toolCallId);
  for (const r of open) {
    const perPeriod = mandate.limits[r.measure]?.perPeriod;
    const sums = await periodSums(tx, mandate.id, r.measure, r.periodKey);
    const balanceAfter =
      perPeriod === undefined
        ? "0"
        : remainingAfter(
            perPeriod,
            sums.drawn - (kind === "release" ? BigInt(r.value) : 0n),
          );
    await tx.insert(l).values({
      orgId: r.orgId,
      workspaceId: r.workspaceId,
      mandateId: r.mandateId,
      toolCallId: r.toolCallId,
      kind,
      measure: r.measure,
      value: r.value,
      unitOrCurrency: r.unitOrCurrency,
      externalEffectId,
      periodKey: r.periodKey,
      balanceAfter,
      createdAt: sql`clock_timestamp()`,
    });
  }
  return open.length;
}

/**
 * Convert a call's reservations to settlements. Remaining authority is
 * unchanged; the settle row carries the external effect id the tool
 * returned.
 */
export function settle(
  tx: Tx,
  args: {
    mandate: MandateRecord;
    toolCallId: string;
    externalEffectId: string | null;
  },
): Promise<number> {
  return closeReservations(
    tx,
    args.mandate,
    args.toolCallId,
    "settle",
    args.externalEffectId,
  );
}

/** Give a call's reservations back: remaining authority rises by each reserved value. */
export function release(
  tx: Tx,
  args: { mandate: MandateRecord; toolCallId: string },
): Promise<number> {
  return closeReservations(tx, args.mandate, args.toolCallId, "release", null);
}

/**
 * Release every reservation a mandate holds for calls parked on an
 * approval not yet used, in the caller's transaction under the caller's
 * lock. Used by revoke_mandate (in-flight calls that have not dispatched
 * end) and by the expiry job when the mandate itself ends.
 */
export async function releaseParked(
  tx: Tx,
  mandate: MandateRecord,
): Promise<number> {
  const parked = await tx
    .select({ toolCallId: schema.approvalRequests.toolCallId })
    .from(schema.approvalRequests)
    .where(
      and(
        eq(schema.approvalRequests.mandateId, mandate.id),
        isNull(schema.approvalRequests.tokenUsedAt),
      ),
    );
  let released = 0;
  for (const p of parked) {
    if (p.toolCallId)
      released += await release(tx, { mandate, toolCallId: p.toolCallId });
  }
  return released;
}

/**
 * Void one approval whose window lapsed before the agent retried —
 * unresolved, or approved and never used: give back what its call holds
 * and resolve the row `expired`, under the caller's lock. The hourly job
 * sweeps these; the decision check does the same when a retry meets one.
 */
export async function expireApproval(
  tx: Tx,
  mandate: MandateRecord,
  approval: { id: string; toolCallId: string | null },
  at: Date,
): Promise<number> {
  const released = approval.toolCallId
    ? await release(tx, { mandate, toolCallId: approval.toolCallId })
    : 0;
  await tx
    .update(schema.approvalRequests)
    .set({
      resolution: "expired",
      // A person's resolution time stands; an unresolved row resolves now.
      resolvedAt: sql`coalesce(${schema.approvalRequests.resolvedAt}, ${at.toISOString()}::timestamptz)`,
    })
    .where(eq(schema.approvalRequests.id, approval.id));
  return released;
}

// ── The decision-time check ───────────────────────────────────────────────

/** The oldest active mandate of the agent covering every tag and matching the tool. */
async function findCoveringMandate(
  tx: Tx,
  args: {
    workspaceId: string;
    agentPrincipalId: string;
    tool: DeclaredTool;
    at: Date;
  },
): Promise<MandateRecord | null> {
  const rows = await tx
    .select()
    .from(m)
    .where(
      and(
        eq(m.workspaceId, args.workspaceId),
        eq(m.agentPrincipalId, args.agentPrincipalId),
        eq(m.status, "active"),
        lte(m.validFrom, args.at),
        gt(m.validTo, args.at),
      ),
    )
    .orderBy(asc(m.createdAt));
  for (const row of rows) {
    const covers = args.tool.consequenceTags.every((t) =>
      row.consequenceTags.includes(t),
    );
    if (covers && toolMatches(row.tools, args.tool.slug, args.tool.version)) {
      return parseMandateRow(row);
    }
  }
  return null;
}

interface MandateCheckArgs {
  capability: string;
  input: unknown;
  orgId: string;
  workspaceId: string;
  agentPrincipalId: string;
  userId: string | null;
  requestId?: string;
  now?: () => Date;
}

type CheckOutcome =
  | { kind: "no_opinion" }
  | {
      kind: "deny";
      reason: MandateDenyReason;
      mandate: MandateRecord | null;
      detail: string;
    }
  | { kind: "pending"; approvalPublicId: string; mandate: MandateRecord }
  | {
      kind: "proceed";
      mandate: MandateRecord;
      toolCallId: string;
      effectIdPath: string | null;
    };

function emitException(
  args: MandateCheckArgs,
  reason: MandateDenyReason,
  mandate: MandateRecord | null,
  detail: string,
): void {
  logger.warn(
    {
      capability: args.capability,
      mandateId: mandate?.publicId ?? null,
      reason,
      detail,
    },
    "mandate: call refused",
  );
  // Loaded on the refusal path, not at module load: `@oxagen/database/security`
  // pulls the telemetry barrel, the Postgres client and the full schema, and
  // `bootstrap` puts this module on the import graph of every rules consumer.
  void import("@oxagen/database/security")
    .then(({ emitSecurityEventAsync }) =>
      emitSecurityEventAsync({
        eventType: "mandate.exception",
        actorUserId: args.userId,
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        capability: args.capability,
        outcome: "deny",
        ip: null,
        userAgent: null,
        requestId: args.requestId ?? null,
      }),
    )
    .catch((err: unknown) =>
      logger.error({ err }, "mandate: security event emission failed"),
    );
}

/**
 * Decide one agent call against the workspace's mandates. Runs the whole
 * decision in one tenant transaction under the mandate row lock and returns
 * the outcome; the gate turns it into a throw or a settlement.
 */
export async function decideMandate(
  args: MandateCheckArgs,
): Promise<CheckOutcome> {
  const at = (args.now ?? (() => new Date()))();
  return withTenantDb(async (tx): Promise<CheckOutcome> => {
    const tool = await loadDeclaredTool(tx, args.workspaceId, args.capability);
    if (tool === null || tool.consequenceTags.length === 0)
      return { kind: "no_opinion" };

    const found = await findCoveringMandate(tx, {
      workspaceId: args.workspaceId,
      agentPrincipalId: args.agentPrincipalId,
      tool,
      at,
    });
    if (found === null) {
      return {
        kind: "deny",
        reason: "no_mandate",
        mandate: null,
        detail: `no active mandate covers ${tool.consequenceTags.join(", ")} for ${tool.slug}@${tool.version}`,
      };
    }

    // Lock before reading balances; re-read the row so the decision sees the
    // state the lock protects.
    const mandate = await lockMandate(tx, found.id);
    if (mandate === null || mandate.status !== "active") {
      return {
        kind: "deny",
        reason: "no_mandate",
        mandate: found,
        detail: "the mandate ended",
      };
    }

    // Measures: one value per limited measure, read from the call.
    const values: Record<string, string> = {};
    for (const measure of Object.keys(mandate.limits)) {
      if (isCallsMeasure(measure)) {
        values[measure] = readCallsMeasure().value;
        continue;
      }
      const declaration = tool.measures[measure];
      if (declaration === undefined || declaration.type === "text") {
        return {
          kind: "deny",
          reason: "measure_unreadable",
          mandate,
          detail: `${tool.slug}@${tool.version} declares no measure "${measure}"`,
        };
      }
      // ADR-108 stamps a limit's kind from the declaration matched at write
      // time (or, for a row written before ADR-108, the documented
      // `legacyMeasureKindGuess` fallback `parseMandateRow` already resolved
      // it to). An unpinned mandate pattern (`slug`, `slug@*`) can still
      // match a version published after that write, and that version can
      // declare this measure's kind differently with the same unit spelling
      // (count to amount or back) without the mandate ever being touched
      // again. A stored kind that disagrees with what governs this call
      // right now is the same disagreement ADR-108 already refuses at
      // write time when two matched tools disagree, moved to the moment it
      // can also happen between then and now: refused here rather than
      // enforced against a figure entered under a kind that no longer
      // holds.
      const storedKind = mandate.limits[measure]?.kind;
      if (
        storedKind !== undefined &&
        storedKind !== measureKindOf(declaration.type)
      ) {
        return {
          kind: "deny",
          reason: "measure_kind_changed",
          mandate,
          detail: `${tool.slug}@${tool.version} now declares measure "${measure}" as ${measureKindOf(declaration.type)}, but this mandate's limit was written when it was ${storedKind}; update the mandate's limit before this call can be decided`,
        };
      }
      const read = readMeasure(args.input, declaration);
      if (!read.ok || read.measure.kind !== "value") {
        return {
          kind: "deny",
          reason: "measure_unreadable",
          mandate,
          detail: `measure "${measure}" at ${declaration.path}: ${read.ok ? "not a value" : read.reason}`,
        };
      }
      values[measure] = read.measure.value;
    }

    // Targets: every measure the mandate names a target rule for.
    for (const [measure, rule] of Object.entries(mandate.targets)) {
      const declaration = tool.measures[measure];
      if (declaration === undefined) {
        return {
          kind: "deny",
          reason: "measure_unreadable",
          mandate,
          detail: `${tool.slug}@${tool.version} declares no measure "${measure}"`,
        };
      }
      const read = readMeasure(args.input, declaration);
      const target = !read.ok
        ? null
        : read.measure.kind === "target"
          ? read.measure.target
          : read.measure.value;
      if (target === null) {
        return {
          kind: "deny",
          reason: "measure_unreadable",
          mandate,
          detail: `target "${measure}" at ${declaration.path}: ${read.ok ? "unreadable" : read.reason}`,
        };
      }
      if (!targetAllowed(target, rule)) {
        return {
          kind: "deny",
          reason: "target_denied",
          mandate,
          detail: `${measure} "${target}" is outside the mandate's targets`,
        };
      }
    }

    // The same call, parked earlier and still waiting for a person: refuse
    // again with the same row, holding the same reservation — a retry while
    // pending draws no more authority. Approved and not yet retried: proceed
    // on the held reservation and mark the approval used. A row whose
    // window lapsed is voided first, so the retry reserves afresh and the
    // lapsed reservation is not held on top of it.
    const digest = inputDigest(args.input);
    const candidates = await tx
      .select({
        id: schema.approvalRequests.id,
        publicId: schema.approvalRequests.publicId,
        toolCallId: schema.approvalRequests.toolCallId,
        resolution: schema.approvalRequests.resolution,
        expiresAt: schema.approvalRequests.expiresAt,
      })
      .from(schema.approvalRequests)
      .where(
        and(
          eq(schema.approvalRequests.workspaceId, args.workspaceId),
          eq(schema.approvalRequests.mandateId, mandate.id),
          eq(schema.approvalRequests.inputDigest, digest),
          isNull(schema.approvalRequests.tokenUsedAt),
          sql`${schema.approvalRequests.resolution} IS DISTINCT FROM 'denied'`,
          sql`${schema.approvalRequests.resolution} IS DISTINCT FROM 'expired'`,
        ),
      )
      .orderBy(asc(schema.approvalRequests.createdAt));
    for (const lapsed of candidates.filter((c) => c.expiresAt <= at)) {
      await expireApproval(tx, mandate, lapsed, at);
    }
    const parked = candidates.find((c) => c.expiresAt > at);
    if (parked?.toolCallId && parked.resolution === "approved") {
      await tx
        .update(schema.approvalRequests)
        .set({ tokenUsedAt: at })
        .where(eq(schema.approvalRequests.id, parked.id));
      return {
        kind: "proceed",
        mandate,
        toolCallId: parked.toolCallId,
        effectIdPath: tool.effectIdPath,
      };
    }
    if (parked?.toolCallId && parked.resolution === null) {
      return { kind: "pending", approvalPublicId: parked.publicId, mandate };
    }

    const toolCallId = randomUUID();
    const reserved = await reserve(tx, { mandate, toolCallId, values, at });
    if (!reserved.ok) {
      return {
        kind: "deny",
        reason: "over_limit",
        mandate,
        detail: reserved.detail,
      };
    }

    // The mandate's own approval rule.
    const ruleIds: string[] = [];
    for (const tag of mandate.approval.alwaysHumanFor) {
      if (tool.consequenceTags.includes(tag)) {
        ruleIds.push(`mandate:${mandate.publicId}:always_human_for:${tag}`);
      }
    }
    for (const [measure, above] of Object.entries(
      mandate.approval.humanAbove,
    )) {
      const value = values[measure];
      if (value !== undefined && exceeds(value, above)) {
        ruleIds.push(`mandate:${mandate.publicId}:human_above:${measure}`);
      }
    }
    if (ruleIds.length > 0) {
      // The auto-approval clause is evaluated for the RECORD, not for the
      // decision: a mandate's own approval rule outranks any workspace rule
      // (§6.9 part 3), so the call waits for a person whatever the evaluation
      // says. What it buys is the eligibility line every approval card
      // renders — which rule was read, whether it would have qualified, and
      // every reason it would not (ADR-070).
      const eligibility = await evaluateParkedCall(tx, {
        capability: args.capability,
        input: args.input,
        workspaceId: args.workspaceId,
        tool,
        digest,
        at,
      });
      const [row] = await tx
        .insert(schema.approvalRequests)
        .values({
          orgId: args.orgId,
          workspaceId: args.workspaceId,
          toolCallId,
          capabilityName: args.capability,
          inputPreview: (args.input ?? {}) as object,
          riskLevel: tool.riskGrade,
          mandateId: mandate.id,
          ruleIds,
          inputDigest: digest,
          autoRuleId: eligibility?.ruleId ?? null,
          resolvedReasons: eligibility?.reasons ?? [],
          expiresAt: new Date(at.getTime() + MANDATE_APPROVAL_TTL_MS),
          createdById: args.userId ?? undefined,
        })
        .returning({ publicId: schema.approvalRequests.publicId });
      if (!row) throw new Error("mandate: approval insert returned no row");
      // MC spec §7.7. Inside this transaction, so the approval and the people
      // told about it land together. A mandate parks a call precisely because
      // a rule decided a person must see it, so this is the fan-out that
      // matters most — and it was the one that did not run, because the
      // fan-out was attached to the runtime's createApprovalRequest instead
      // of to the row it describes.
      await notifyApprovalRequested(tx, {
        orgId: args.orgId,
        workspaceId: args.workspaceId,
        capabilityName: args.capability,
        riskLevel: tool.riskGrade,
        expiresAt: new Date(at.getTime() + MANDATE_APPROVAL_TTL_MS),
      });
      return { kind: "pending", approvalPublicId: row.publicId, mandate };
    }

    return {
      kind: "proceed",
      mandate,
      toolCallId,
      effectIdPath: tool.effectIdPath,
    };
  });
}

/**
 * The workspace's auto-approval clause read against a call a mandate is about
 * to park. Returns the evaluation to record, or null when the workspace has
 * no rule covering the call. Never decides anything: the mandate has already
 * decided that a person must look.
 */
async function evaluateParkedCall(
  tx: Tx,
  args: {
    capability: string;
    input: unknown;
    workspaceId: string;
    tool: DeclaredTool;
    digest: string;
    at: Date;
  },
) {
  const ruleSet = await loadRuleSetIn(tx, args.workspaceId);
  const rules = ruleSet?.autoApproval ?? [];
  if (rules.length === 0) return null;
  const subject = await buildAutoApprovalSubject(tx, {
    capability: args.capability,
    input: args.input,
    workspaceId: args.workspaceId,
    tool: args.tool,
    digest: args.digest,
    rules,
    now: args.at,
  });
  return evaluateAutoApproval(rules, subject);
}

/**
 * The gate's entry: decide, then throw for a refusal or a parked call, or
 * return the settlement the kernel applies after the handler. `undefined`
 * means the mandates have no opinion on this call.
 */
export async function checkMandate(
  args: MandateCheckArgs,
): Promise<DecisionSettlement | undefined> {
  const outcome = await decideMandate(args);
  switch (outcome.kind) {
    case "no_opinion":
      return undefined;
    case "deny":
      emitException(args, outcome.reason, outcome.mandate, outcome.detail);
      throw new HandlerError({
        code: "forbidden",
        reason: outcome.reason,
        message: `Refused by mandate: ${outcome.detail}`,
      });
    case "pending":
      throw new CapabilityError(
        args.capability,
        "pending_approval",
        `The mandate ${outcome.mandate.publicId} requires a person to approve this call`,
        outcome.approvalPublicId,
      );
    case "proceed": {
      const { mandate, toolCallId, effectIdPath } = outcome;
      return {
        settle: async (output) => {
          const raw =
            effectIdPath === null ? undefined : readPath(output, effectIdPath);
          const externalEffectId =
            typeof raw === "string" || typeof raw === "number"
              ? String(raw)
              : null;
          await withTenantDb(async (tx) => {
            // The limits may have changed since the decision; the row under
            // the lock carries the ceiling the balance is written against.
            const current = (await lockMandate(tx, mandate.id)) ?? mandate;
            await settle(tx, {
              mandate: current,
              toolCallId,
              externalEffectId,
            });
          });
        },
        release: async () => {
          await withTenantDb(async (tx) => {
            const current = (await lockMandate(tx, mandate.id)) ?? mandate;
            await release(tx, { mandate: current, toolCallId });
          });
        },
      };
    }
  }
}
