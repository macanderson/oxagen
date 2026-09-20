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
  type MeasureKind,
} from "@oxagen/oxagen/mandates/schemas";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { evaluateAutoApproval } from "./auto-approval";
import {
  buildAutoApprovalSubject,
  inputDigest,
  loadDeclaredTool,
  type DeclaredTool,
} from "./call-facts";
import { logger } from "./logger";
import { notifyApprovalRequested } from "./approval-notify";
import { loadRuleSetIn, lockDecisionRulesIn } from "./rule-store";
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
  /**
   * Measures in `limits` whose `kind` was not actually stored and is instead
   * `legacyMeasureKindGuess`'s fallback. A guess is not a fact: it must never
   * be compared against a tool's current declaration to detect drift (a
   * legacy row's guess can legitimately disagree with a declaration the gate
   * has always enforced correctly, since the gate reads the declaration
   * directly and never the guess), and an unrelated write must not use it to
   * decide what to preserve versus refresh. Both call sites key off this set
   * instead of `limit.kind === undefined`, which is never true once
   * `withResolvedKinds` has run.
   */
  legacyKindMeasures: ReadonlySet<string>;
}

/**
 * Every stored limit with `kind` guaranteed present (ADR-108): a row written
 * since ADR-108 already carries it, and a row written before takes the one
 * documented fallback, `legacyMeasureKindGuess`. This is the only place that
 * fallback runs; every reader downstream (`readAuthority`, `mapMandates`,
 * the mapped `mandate.limits` a get/list response carries) takes `kind` as a
 * fact already resolved, never guessing again from `currencyOrUnit` itself.
 * Also returns which measures took the fallback, so a caller that must tell
 * a persisted fact from a guess (the gate's drift check, an update that must
 * not silently refresh a kind the operator never touched) can.
 */
function withResolvedKinds(limits: MandateLimits): {
  limits: MandateLimits;
  legacyKindMeasures: ReadonlySet<string>;
} {
  const legacyKindMeasures = new Set<string>();
  const resolved = Object.fromEntries(
    Object.entries(limits).map(([measure, limit]) => {
      if (limit.kind === undefined) legacyKindMeasures.add(measure);
      return [
        measure,
        {
          ...limit,
          kind: limit.kind ?? legacyMeasureKindGuess(limit.currencyOrUnit),
        },
      ];
    }),
  );
  return { limits: resolved, legacyKindMeasures };
}

export function parseMandateRow(row: typeof m.$inferSelect): MandateRecord {
  const { limits, legacyKindMeasures } = withResolvedKinds(
    mandateLimitsSchema.parse(row.limits),
  );
  return {
    id: row.id,
    publicId: row.publicId,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    agentPrincipalId: row.agentPrincipalId,
    consequenceTags: row.consequenceTags,
    limits,
    legacyKindMeasures,
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

/**
 * The kind the most recent *stamped* ledger row for this measure carries, or
 * null when the measure has no stamped ledger rows at all.
 *
 * Both callers need this to distinguish real history from none: a
 * whole-record `limits` replacement can delete a measure entirely and a
 * later call can re-add it (`assertKindChangeAllowed`'s `before` then
 * carries no entry to compare), and a legacy measure's stored `limits[
 * measure].kind` is only a guess even after real calls have stamped its
 * ledger rows from the live declaration (`decideMandate`'s drift check).
 * Both read the ledger's own stamp directly, since neither `before` nor a
 * legacy stored `kind` can see it.
 *
 * Filtered to non-null rows: `measure_kind` is null only on a row written
 * before the column existed, and `settle`/`release` carry a reservation's
 * own stamp forward, so a pre-migration reservation's later null-stamped
 * close would otherwise outrank an earlier row's real one, the most recent
 * row by `createdAt` is not always the most recent *stamped* one.
 */
export async function lastLedgerKind(
  tx: Tx,
  mandateId: string,
  measure: string,
): Promise<MeasureKind | null> {
  const [row] = await tx
    .select({ measureKind: l.measureKind })
    .from(l)
    .where(
      and(
        eq(l.mandateId, mandateId),
        eq(l.measure, measure),
        isNotNull(l.measureKind),
      ),
    )
    .orderBy(desc(l.createdAt))
    .limit(1);
  return (row?.measureKind as MeasureKind | null | undefined) ?? null;
}

/**
 * Whether this measure has a ledger row written before the `measure_kind`
 * column existed (`measure_kind is null`) that is still live: an open
 * reservation, or a draw within the period key `period`/`at` names.
 *
 * `lastLedgerKind` returning null is ambiguous on its own: it cannot tell
 * a measure with no ledger rows at all from one whose only rows predate the
 * stamp. The first is safe to treat as a fresh start; the second still
 * carries authority recorded under a kind nothing durable remembers, and a
 * caller that let a new reservation or a kind change land anyway could sum
 * it into `periodSums` against that unverified older row, exactly the
 * money/count mixing ADR-108 exists to close. Both `decideMandate` and
 * `assertKindChangeAllowed` check this before trusting a null
 * `lastLedgerKind` result.
 */
export async function hasUnstampedLedgerHistory(
  tx: Tx,
  mandateId: string,
  measure: string,
  period: MandatePeriod,
  at: Date = new Date(),
): Promise<boolean> {
  const key = periodKey(period, at);
  // Mirrors `periodSums`'s own reserve/settle/release netting (a release
  // nets against its reserve in the same `reserved` sum; only `settle` adds
  // to `settled`), restricted to unstamped rows and, for the period figure,
  // to this period key. A release that clears an unstamped reservation must
  // net it back to zero here the same way it does in `periodSums`, or a
  // legacy mandate with only released history would read as still drawn
  // and never clear this check.
  const [row] = await tx
    .select({
      openReserved: sql<string>`coalesce(sum(case when ${l.kind} = 'reserve' then ${l.value} else -${l.value} end), 0)::text`,
      periodReserved: sql<string>`coalesce(sum(case when ${l.periodKey} = ${key} then (case when ${l.kind} = 'reserve' then ${l.value} else -${l.value} end) else 0 end), 0)::text`,
      periodSettled: sql<string>`coalesce(sum(case when ${l.periodKey} = ${key} and ${l.kind} = 'settle' then ${l.value} else 0 end), 0)::text`,
    })
    .from(l)
    .where(
      and(
        eq(l.mandateId, mandateId),
        eq(l.measure, measure),
        isNull(l.measureKind),
      ),
    );
  const drawnInPeriod =
    BigInt(row?.periodReserved ?? "0") + BigInt(row?.periodSettled ?? "0");
  return BigInt(row?.openReserved ?? "0") > 0n || drawnInPeriod > 0n;
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
  /**
   * measure → the kind the call currently governing this measure declares
   * (`calls`'s built-in "count", or `measureKindOf(declaration.type)` for
   * everything else), computed by the caller from the live tool declaration.
   * `reserve` stamps this onto the ledger row rather than `mandate.limits[
   * measure].kind`: for a legacy measure that kind is `legacyMeasureKindGuess`'s
   * fallback, not a fact, and stamping the guess as the reservation's kind
   * would turn it into a durable one the mandate's own removal of the
   * measure could not later correct.
   */
  measureKinds: Record<string, MeasureKind>;
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
  const { mandate, toolCallId, values, measureKinds, at } = args;
  const rows: (Omit<typeof l.$inferInsert, "createdAt"> & {
    createdAt: SQL;
  })[] = [];
  for (const [measure, limit] of Object.entries(mandate.limits)) {
    const value = values[measure];
    if (value === undefined) {
      throw new Error(`reserve: no value for measure "${measure}"`);
    }
    const measureKind = measureKinds[measure];
    if (measureKind === undefined) {
      throw new Error(`reserve: no measure kind for measure "${measure}"`);
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
      // The kind the call's live tool declaration governs this measure
      // under (ADR-108), stamped once here so the row survives a later
      // whole-record `limits` replacement that removes the measure: the
      // ledger is append-only, the mandate is not. Never `limit.kind`: for
      // a legacy measure that is `legacyMeasureKindGuess`'s fallback, not a
      // fact, and stamping the guess would turn it into a durable one no
      // later mandate write could correct.
      measureKind,
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
      // Carried from the reservation this closes, not re-derived from the
      // mandate's current limits: a settle or release closes what a reserve
      // started, under the kind that reserve was stamped with.
      measureKind: r.measureKind,
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
 * The value a `humanAbove` threshold compares, read from the call for a
 * measure the mandate does not limit. Null when the tool does not declare
 * the measure, declares it as text, or the call does not carry it as a
 * value: the caller treats null as over the threshold.
 */
function humanAboveValue(
  tool: Pick<DeclaredTool, "measures">,
  input: unknown,
  measure: string,
): string | null {
  if (isCallsMeasure(measure)) return readCallsMeasure().value;
  const declaration = tool.measures[measure];
  if (declaration === undefined || declaration.type === "text") return null;
  const read = readMeasure(input, declaration);
  return read.ok && read.measure.kind === "value" ? read.measure.value : null;
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
    await lockDecisionRulesIn(tx, args.workspaceId);
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

    // Measures: one value per limited measure, read from the call. Also the
    // kind the call's live declaration governs each measure under, for
    // `reserve` to stamp onto the ledger row (never the mandate's own
    // `limit.kind`, a legacy guess for a pre-ADR-108 row).
    const values: Record<string, string> = {};
    const measureKinds: Record<string, MeasureKind> = {};
    for (const measure of Object.keys(mandate.limits)) {
      if (isCallsMeasure(measure)) {
        values[measure] = readCallsMeasure().value;
        measureKinds[measure] = "count";
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
      // time. An unpinned mandate pattern (`slug`, `slug@*`) can still match
      // a version published after that write, and that version can declare
      // this measure's kind differently with the same unit spelling (count
      // to amount or back) without the mandate ever being touched again. A
      // stored kind that disagrees with what governs this call right now is
      // the same disagreement ADR-108 already refuses at write time when two
      // matched tools disagree, moved to the moment it can also happen
      // between then and now: refused here rather than enforced against a
      // figure entered under a kind that no longer holds.
      //
      // `mandate.legacyKindMeasures` excludes a row written before ADR-108:
      // its `kind` is `legacyMeasureKindGuess`'s fallback, not a fact this
      // measure was ever actually written under, and the gate has always
      // enforced that row correctly by reading the declaration directly
      // (never the guess). Comparing the guess itself against the current
      // declaration would deny a legacy mandate the fallback happens to
      // guess wrong, even though nothing about it has drifted, since there
      // is no earlier fact to drift from in `mandate.limits`.
      //
      // But `reserve` has stamped every ledger row for this measure from the
      // live declaration since ADR-108's ledger column shipped, whether the
      // mandate's own stored `limits[measure].kind` is a real stamp or still
      // a legacy guess: a legacy mandate's ledger history is real history
      // the moment it exists. So a legacy measure is not exempt outright;
      // it is checked against its own ledger's last stamped kind instead of
      // `mandate.limits`, with no refusal only when that history is empty
      // (this call would be the measure's first real stamp).
      const limit = mandate.limits[measure];
      const storedKind = limit?.kind;
      if (mandate.legacyKindMeasures.has(measure) && limit !== undefined) {
        const ledgerKind = await lastLedgerKind(tx, mandate.id, measure);
        if (ledgerKind !== null) {
          if (ledgerKind !== measureKindOf(declaration.type)) {
            return {
              kind: "deny",
              reason: "measure_kind_changed",
              mandate,
              detail: `${tool.slug}@${tool.version} now declares measure "${measure}" as ${measureKindOf(declaration.type)}, but this mandate's ledger last recorded it as ${ledgerKind}; update the mandate's limit before this call can be decided`,
            };
          }
        } else if (
          await hasUnstampedLedgerHistory(
            tx,
            mandate.id,
            measure,
            limit.period,
            at,
          )
        ) {
          return {
            kind: "deny",
            reason: "measure_kind_changed",
            mandate,
            detail: `${tool.slug}@${tool.version} declares measure "${measure}" as ${measureKindOf(declaration.type)}, but this mandate has ledger history from before kind tracking that is still open or drawn this period and whose own kind was never recorded; release any open reservation and wait for the current window to close (a settled row cannot be released), or revoke the mandate, before this call can be decided`,
          };
        }
      } else if (
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
      measureKinds[measure] = measureKindOf(declaration.type);
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
    const reserved = await reserve(tx, {
      mandate,
      toolCallId,
      values,
      measureKinds,
      at,
    });
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
      // A threshold on a measure the mandate does not also limit was never
      // read above, so it is read here. One this tool does not declare, or
      // that this call does not carry as a value, goes to a person: the rule
      // promises a person decides above the threshold, and a call that
      // cannot be shown to be below it is not one this rule may wave
      // through.
      const value =
        values[measure] ?? humanAboveValue(tool, args.input, measure);
      if (value === null || exceeds(value, above)) {
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
