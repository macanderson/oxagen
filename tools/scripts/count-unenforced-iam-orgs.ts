#!/usr/bin/env tsx
/**
 * count-unenforced-iam-orgs.ts — the exposure query #1384 asked for, #2714 tracks.
 *
 * `checkIAM` bypasses the IAM resolver entirely — an unconditional allow, zero
 * policy queries — for any org that does not resolve to the `enterprise` tier.
 * Tier resolution used to count a subscription only when its status was exactly
 * `active`, so an enterprise org in trial, past due or paused resolved to a
 * lower tier and had every capability check allowed without a single policy
 * being consulted. #2712 fixed the resolution. This answers who was affected.
 *
 * It is READ-ONLY and has no `--apply`. Nothing here changes a tier, a
 * subscription or a policy: this is a question, and the decision about what is
 * owed to the orgs it names belongs to a person.
 *
 * Usage:
 *   tsx tools/scripts/count-unenforced-iam-orgs.ts
 *   tsx tools/scripts/count-unenforced-iam-orgs.ts --json
 *
 * Env:
 *   DATABASE_URL — required, and it must be PRODUCTION. An empty result against
 *   a staging or local database says nothing at all; the printed host is worth
 *   reading before believing the answer.
 *
 * ## What this can and cannot tell you
 *
 * It answers "which orgs are exposed right now, and in what status" exactly.
 *
 * It can only bound "for how long". `billing.subscriptions` keeps the CURRENT
 * status and no history — there is no status-history table in this schema — so
 * the window a subscription has been non-active cannot be read out of Postgres.
 * What is here is a floor, from the columns that do carry a time:
 * `trial_end`, `canceled_at`, `current_period_start` and the row's `updated_at`.
 * The real transition history is in Stripe, and `security_events` carries the
 * subset that emitted an audit row (`billing.subscription_canceled`,
 * `billing.subscription_reactivated`, `billing.plan_changed`).
 *
 * This script now reads that second source for every org it names, because a
 * bound that can be tightened should be. What it buys and what it does not:
 *
 *   - `security.security_events` carries `occurred_at` and `event_type` and no
 *     payload column, so a row dates a transition WITHOUT saying which status
 *     the subscription entered. The latest such row therefore bounds the
 *     current window from below — better than `updated_at`, which any unrelated
 *     write moves — and still is not the start.
 *   - Only three billing transitions emit an audit row at all. A subscription
 *     that drifted to `past_due` because a card expired emits none, so an org
 *     with an empty timeline is an org whose window is unknown, NOT an org that
 *     never transitioned. The renderer says so per org rather than leaving an
 *     empty list to be read as a clean record.
 *
 * Stripe's own event log remains the authoritative answer, and #2714's second
 * item should be closed against that or against an explicit statement that the
 * audit trail does not reach back far enough.
 */
import kleur from "kleur";
import postgres from "postgres";

/** The statuses old tier resolution refused, and so unenforced IAM for. */
export const PREVIOUSLY_UNENTITLED = [
  "trialing",
  "past_due",
  "paused",
] as const;

export interface ExposedOrg {
  orgId: string;
  orgName: string;
  planType: string;
  planTier: string;
  status: string;
  trialEnd: string | null;
  canceledAt: string | null;
  currentPeriodStart: string | null;
  subscriptionUpdatedAt: string | null;
}

/**
 * The earliest moment this row is KNOWN to have been in a non-active status,
 * or null when nothing in the row carries one.
 *
 * A floor, never a start: the row could have entered this status earlier and
 * been updated since for an unrelated reason. Reporting it as the start is the
 * mistake this function's name exists to prevent.
 */
export function knownUnenforcedSince(org: ExposedOrg): string | null {
  const candidates = [
    org.status === "trialing" ? org.currentPeriodStart : null,
    org.status === "paused" ? org.subscriptionUpdatedAt : null,
    org.status === "past_due" ? org.currentPeriodStart : null,
    org.canceledAt,
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  if (candidates.length === 0) return null;
  return candidates.sort()[0]!;
}

/** Group the rows by status, for the "how many, in which statuses" half. */
export interface TransitionEvent {
  orgId: string;
  eventType: string;
  occurredAt: string;
  actorUserId: string | null;
}

/**
 * Coerce a `timestamptz` as postgres.js hands it back into an ISO-8601 UTC
 * string, or null.
 *
 * This exists because of a defect found by running the script against a real
 * database rather than against its own fixtures. postgres.js decodes
 * `timestamptz` to a JS `Date`, not a string, but {@link ExposedOrg} declares
 * these columns `string | null` and {@link knownUnenforcedSince} filters its
 * candidates with `typeof x === "string"`. Every date therefore failed the
 * filter, and the script printed "nothing in the row dates it" for every org —
 * silently discarding the only floor the row carries, which is the first half
 * of what #2714 asks for. The unit tests passed throughout, because they hand
 * in strings.
 *
 * Normalising at the query boundary is the fix rather than widening the filter:
 * it makes the declared types true, keeps the pure functions working on one
 * representation, and leaves the fixtures representative of what the database
 * actually returns.
 *
 * ISO-8601 UTC rather than `Date#toString()` for the same reason a compliance
 * record always is: `Sun Aug 02 2026 11:55:40 GMT-0700` is a date whose meaning
 * depends on where the reader's laptop was.
 */
export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string") return value.length > 0 ? value : null;
  return null;
}

/** Normalise one exposed-org row's four timestamp columns. */
export function normalizeExposedOrg(row: ExposedOrg): ExposedOrg {
  return {
    ...row,
    trialEnd: toIsoOrNull(row.trialEnd),
    canceledAt: toIsoOrNull(row.canceledAt),
    currentPeriodStart: toIsoOrNull(row.currentPeriodStart),
    subscriptionUpdatedAt: toIsoOrNull(row.subscriptionUpdatedAt),
  };
}

/** Normalise one transition row's timestamp. */
export function normalizeTransition(row: TransitionEvent): TransitionEvent {
  return { ...row, occurredAt: toIsoOrNull(row.occurredAt) ?? "" };
}

/**
 * The billing transitions that leave an audit row. Kept as a list rather than
 * inlined in the SQL so the gap is legible: these three are the whole of what
 * `security_events` can date, and every other way a subscription changes
 * status is silent here.
 */
export const AUDITED_SUBSCRIPTION_EVENTS = [
  "billing.subscription_canceled",
  "billing.subscription_reactivated",
  "billing.plan_changed",
] as const;

/**
 * Render one org's audited transition timeline.
 *
 * An empty timeline prints as "no audited transition" and explicitly not as a
 * date or a blank, because the three events above do not cover every way a
 * subscription changes status — a card expiring into `past_due` emits none.
 * Silence here means unknown, and saying "unknown" is the only honest render.
 */
export function renderTimeline(
  events: TransitionEvent[],
  indent = "    ",
): string[] {
  if (events.length === 0) {
    return [
      `${indent}no audited transition on record — the window is UNKNOWN, not clean;`,
      `${indent}only cancel, reactivate and plan-change emit an audit row.`,
    ];
  }
  const lines = [
    `${indent}audited transitions (latest first) — each dates A transition, not which status it entered:`,
  ];
  for (const e of events) {
    const actor = e.actorUserId ? `by ${e.actorUserId}` : "no actor recorded";
    lines.push(`${indent}  ${e.occurredAt}  ${e.eventType}  (${actor})`);
  }
  lines.push(
    `${indent}the latest row above bounds the current window from below; Stripe has the start.`,
  );
  return lines;
}

/** Group the audited transitions by org, so the renderer can look one up. */
export function groupByOrg(
  events: TransitionEvent[],
): Map<string, TransitionEvent[]> {
  const byOrg = new Map<string, TransitionEvent[]>();
  for (const e of events) {
    const list = byOrg.get(e.orgId);
    if (list) list.push(e);
    else byOrg.set(e.orgId, [e]);
  }
  return byOrg;
}

export function byStatus(orgs: ExposedOrg[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const o of orgs) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  return counts;
}

export function render(
  orgs: ExposedOrg[],
  host: string,
  transitions: Map<string, TransitionEvent[]> = new Map(),
): string {
  if (orgs.length === 0) {
    return [
      `[unenforced-iam] no org is exposed on ${host}.`,
      "",
      "An empty result is only as good as the database it was run against.",
      "Check the host above is production before recording this on #2714.",
    ].join("\n");
  }

  const lines = [
    `[unenforced-iam] ${orgs.length} org(s) ran without IAM on ${host}:`,
    "",
  ];
  for (const [status, n] of [...byStatus(orgs)].sort()) {
    lines.push(`  ${status}: ${n}`);
  }
  lines.push("");
  for (const o of orgs) {
    const since = knownUnenforcedSince(o);
    lines.push(
      `  ${o.orgId}  ${o.orgName}`,
      `    subscription status ${o.status}, plan tier ${o.planTier}, organizations.plan_type ${o.planType}`,
      `    known non-active since at least ${since ?? "— nothing in the row dates it"}`,
    );
    lines.push(...renderTimeline(transitions.get(o.orgId) ?? []));
  }
  lines.push(
    "",
    "Those dates are FLOORS, not start times: this schema keeps no subscription",
    "status history, and the audit trail covers only cancel, reactivate and",
    "plan-change. The authoritative window is Stripe's event log. #2714's second",
    "item closes against that, or against a statement that the trail does not",
    "reach back far enough.",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(kleur.red("[unenforced-iam] DATABASE_URL is not set."));
    process.exit(1);
  }
  const host = new URL(url).host;
  console.log(kleur.cyan(`[unenforced-iam] querying ${host}`));

  const sql = postgres(url, { max: 1, prepare: false });
  try {
    const rawRows = (await sql`
      select o.id                       as "orgId",
             o.name                     as "orgName",
             o.plan_type                as "planType",
             p.tier                     as "planTier",
             s.status                   as "status",
             s.trial_end                as "trialEnd",
             s.canceled_at              as "canceledAt",
             s.current_period_start     as "currentPeriodStart",
             s.updated_at               as "subscriptionUpdatedAt"
        from billing.subscriptions s
        join billing.plans p on p.id = s.plan_id
        join org.organizations o on o.id = s.org_id
       where p.tier = 'enterprise'
         and s.status <> 'active'
         and o.plan_type <> 'enterprise'
       order by s.status, o.name
    `) as unknown as ExposedOrg[];
    // Normalise at the boundary — see toIsoOrNull for the defect this fixes.
    const rows = rawRows.map(normalizeExposedOrg);

    // Second query, and only when the first found something: the audited
    // transition timeline for exactly the orgs named above. Scoped to those
    // org ids rather than scanned wholesale, because security_events is the
    // largest table in this schema and the question is about a handful of orgs.
    let transitions: TransitionEvent[] = [];
    if (rows.length > 0) {
      const orgIds = rows.map((r) => r.orgId);
      const raw = (await sql`
        select org_id        as "orgId",
               event_type    as "eventType",
               occurred_at   as "occurredAt",
               actor_user_id as "actorUserId"
          from security.security_events
         where org_id = any(${sql.array(orgIds)}::uuid[])
           and event_type = any(${sql.array([...AUDITED_SUBSCRIPTION_EVENTS])}::text[])
         order by org_id, occurred_at desc
      `) as unknown as TransitionEvent[];
      transitions = raw.map(normalizeTransition);
    }

    if (process.argv.includes("--json")) {
      console.log(
        JSON.stringify({ exposed: rows, auditedTransitions: transitions }, null, 2),
      );
    } else {
      console.log(render(rows, host, groupByOrg(transitions)));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error(kleur.red(`[unenforced-iam] ${String(err)}`));
    process.exit(1);
  });
}
