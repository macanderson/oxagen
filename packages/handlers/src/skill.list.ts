// audit-exempt: read-only. Lists the skill names this workspace's harness
// sessions reported at start from tacho.sessions; mutates nothing, and the
// kernel's capability.invoke_* audit records the access.
//
// `list_skills` (#3098) reads observed inventory from
// `tacho.sessions.skills_available`, the name list a wrapped harness reports
// when a session starts (packages/tacho/src/envelope.ts, written by
// ingest_tacho_events). This read answers which skills the harness had and nothing
// else: no version, digest, source, cost or decision exists to return.
//
// A session whose inventory is null, or anything but a JSON array, did not
// report one. It is counted as not reported and never as a session with no
// skills; `reportedSessions` is null when no session in the window reported.
//
// The kernel enters the tenant scope before this handler runs. One statement
// reads counts and names through withTenantDb and RLS. Its scans also
// name org_id and workspace_id: a local stack runs with the RLS bypass on,
// and another workspace's sessions must still stay out of the counts.
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner, Admin or Member, or workspace
//      Owner or Member, for the signed-in user or the creator of the API key.
//      The kernel's IAM check allows every capability for a non-enterprise
//      org, so the handler owns this check (apps/app/ARCHITECTURE.md §3.2,
//      INV-29).
//   2. The window: the cursor's, or the last `windowDays` up to now. A cursor
//      this handler did not write is invalid_input.
//   3. The window's session counts, then one page of names past the cursor.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  SKILL_HARNESS_CAP,
  SKILL_PAGE_SIZE,
  SKILL_WINDOW_DAYS_MAX,
  type SkillInventoryRow,
  skillList,
  type SkillListOutput,
} from "@oxagen/oxagen/contracts/skill.list";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import { z } from "zod";

// ---- Window and cursor ------------------------------------------------------------------

/** Sessions started at or after `from` and before `to`. */
export type SkillWindow = { from: Date; to: Date };

/** Where a page ended: its window and the last name on it. */
type SkillCursor = { window: SkillWindow; after: string };

const DAY_MS = 86_400_000;

export function windowEndingAt(to: Date, days: number): SkillWindow {
  return { from: new Date(to.getTime() - days * DAY_MS), to };
}

export function encodeSkillCursor(cursor: SkillCursor): string {
  return Buffer.from(
    JSON.stringify([
      cursor.window.from.toISOString(),
      cursor.window.to.toISOString(),
      cursor.after,
    ]),
    "utf8",
  ).toString("base64url");
}

/**
 * Null for anything that is not a cursor this handler wrote, including a
 * cursor whose window is longer than `windowDays` may ask for. The window
 * rides in the cursor and replaces `windowDays`, so without this bound any
 * caller could base64url-encode an ordered pair of dates and read a range the
 * input schema refuses — the whole of a workspace's history, scanned by the
 * counts and the lateral skill expansion alike.
 */
export function decodeSkillCursor(raw: string): SkillCursor | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string" ||
      typeof value[2] !== "string" ||
      value[2].length === 0
    )
      return null;
    const from = new Date(value[0]);
    const to = new Date(value[1]);
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from >= to ||
      to.getTime() - from.getTime() > SKILL_WINDOW_DAYS_MAX * DAY_MS
    )
      return null;
    return { window: { from, to }, after: value[2] };
  } catch {
    // Not base64url JSON: a hand-edited or foreign cursor.
    return null;
  }
}

// ---- Queries ------------------------------------------------------------------------------

export type SkillScope = { orgId: string; workspaceId: string };

/** Sessions started in the window, and how many of them reported an inventory. */
export type SessionTotals = { sessions: number; reported: number };

export type SkillQueries = {
  read: (
    scope: SkillScope,
    window: SkillWindow,
    q: { after: string | null; limit: number },
  ) => Promise<{ totals: SessionTotals; rows: SkillInventoryRow[] }>;
};

const sessions = schema.tachoSessions;

/** An inventory is reported when the column holds a JSON array. */
const REPORTED = sql`jsonb_typeof(${sessions.skillsAvailable}) = 'array'`;

function inWindow(scope: SkillScope, window: SkillWindow): SQL | undefined {
  return and(
    eq(sessions.orgId, scope.orgId),
    eq(sessions.workspaceId, scope.workspaceId),
    gte(sessions.startedAt, window.from),
    lt(sessions.startedAt, window.to),
  );
}

export function totalsQuery(
  db: Pick<Tx, "select">,
  scope: SkillScope,
  window: SkillWindow,
) {
  return db
    .select({
      sessions: sql<number>`count(*)::int`.as("sessions"),
      reported: sql<number>`(count(*) filter (where ${REPORTED}))::int`.as(
        "reported",
      ),
    })
    .from(sessions)
    .where(inWindow(scope, window));
}

/** The instant in the wire's RFC 3339 form, rendered by Postgres. */
const iso = (column: SQL) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * One row per reported name: the sessions whose inventory named it (a name
 * listed twice in one inventory counts that session once), up to
 * `SKILL_HARNESS_CAP` of its distinct harnesses plus the true distinct count,
 * and the first and last start. Reads one row past the page so the caller
 * knows whether a next page exists.
 *
 * Harnesses aggregate as a `jsonb_agg`, not a delimited string: `agent.harness`
 * is `z.string().max(512)` at the wire (packages/tacho/src/envelope.ts) with no
 * constraint on content, so a delimiter character can appear inside a real
 * value. `jsonb_agg` round-trips whatever the harness sent, including an empty
 * string, byte-for-byte — nothing here rejects or re-splits it (#3103).
 *
 * The aggregate is bounded: `ranked_harness` ranks each skill's distinct
 * harnesses and `harness_summary` keeps only the first `SKILL_HARNESS_CAP` in
 * the returned array, alongside `harness_count`, the true distinct count. A
 * workspace whose wrapper stamps a unique label per session (a host name, a
 * run id) can no longer make one row's harness list grow without bound.
 *
 * The page cursor filters `expanded`, the first scan, so the ranking and the
 * aggregates cover only names after it. Filtering the outer select instead
 * would rank and aggregate every name in the window on every page.
 */
export function namesQuery(
  scope: SkillScope,
  window: SkillWindow,
  q: { after: string | null; limit: number },
): SQL {
  return sql`
    with expanded as (
      select
        skill.name as name,
        s.id as session_id,
        s.harness as harness,
        s.started_at as started_at
      from ${sessions} as s
      cross join lateral jsonb_array_elements_text(s.skills_available) as skill(name)
      where s.org_id = ${scope.orgId}::uuid
        and s.workspace_id = ${scope.workspaceId}::uuid
        and s.started_at >= ${window.from.toISOString()}::timestamptz
        and s.started_at < ${window.to.toISOString()}::timestamptz
        and jsonb_typeof(s.skills_available) = 'array'
        and skill.name <> ''
        ${q.after === null ? sql`` : sql`and skill.name > ${q.after}`}
    ),
    ranked_harness as (
      select name, harness,
        row_number() over (partition by name order by harness) as rn,
        count(*) over (partition by name) as harness_count
      from (select distinct name, harness from expanded) as distinct_harness
    ),
    harness_summary as (
      select name,
        jsonb_agg(harness order by harness)
          filter (where rn <= ${SKILL_HARNESS_CAP}) as harnesses,
        max(harness_count)::int as harness_count
      from ranked_harness
      group by name
    )
    select
      e.name as name,
      count(distinct e.session_id)::int as sessions,
      hs.harnesses as harnesses,
      hs.harness_count as harness_count,
      ${iso(sql`min(e.started_at)`)} as first_seen_at,
      ${iso(sql`max(e.started_at)`)} as last_seen_at
    from expanded e
    join harness_summary hs on hs.name = e.name
    group by e.name, hs.harnesses, hs.harness_count
    order by e.name
    limit ${q.limit + 1}
  `;
}

const nameRowSchema = z.object({
  name: z.string().min(1),
  sessions: z.coerce.number().int().positive(),
  harnesses: z.array(z.string().max(512)).min(1),
  harness_count: z.coerce.number().int().positive(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
});

/** A row of namesQuery as the contract's row; a row outside its shape fails the read. */
export function toInventoryRow(raw: unknown): SkillInventoryRow {
  const row = nameRowSchema.parse(raw);
  return {
    name: row.name,
    sessions: row.sessions,
    harnesses: row.harnesses,
    harnessCount: row.harness_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export const postgresSkillQueries: SkillQueries = {
  read: (scope, window, q) =>
    withTenantDb(async (tx) => {
      // One statement gives counts and rows the same Postgres snapshot, including
      // when ingestion commits while this read is running.
      const [raw] = await tx.execute(sql`
      with totals as (${totalsQuery(tx, scope, window)}),
      names as (${namesQuery(scope, window, q)})
      select totals.*,
        coalesce((select jsonb_agg(names order by name) from names), '[]'::jsonb) as names
      from totals
    `);
      const snapshot = z
        .object({
          sessions: z.coerce.number().int().nonnegative(),
          reported: z.coerce.number().int().nonnegative(),
          names: z.array(z.unknown()),
        })
        .parse(raw);
      return {
        totals: { sessions: snapshot.sessions, reported: snapshot.reported },
        rows: snapshot.names.map(toInventoryRow),
      };
    }),
};

// ---- The handler ------------------------------------------------------------------------

export type SkillListDeps = { queries: SkillQueries; now: () => Date };

export function createSkillListHandler(
  deps: SkillListDeps,
): CapabilityHandler<typeof skillList> {
  return async (input, ctx): Promise<SkillListOutput> => {
    // ── Role gate ─────────────────────────────────────────────────────────
    await assertOrgRole(
      { ...ctx, userId: await resolveActingUserId(ctx) },
      { org: ["Owner", "Admin", "Member"], workspace: ["Owner", "Member"] },
    );

    // ── Window ────────────────────────────────────────────────────────────
    const cursor =
      input.cursor === undefined ? null : decodeSkillCursor(input.cursor);
    if (input.cursor !== undefined && cursor === null)
      throw new CapabilityError(
        skillList.name,
        "invalid_input",
        "invalid_cursor",
      );
    const window =
      cursor?.window ?? windowEndingAt(deps.now(), input.windowDays);

    // ── Read ──────────────────────────────────────────────────────────────
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { totals, rows } = await deps.queries.read(scope, window, {
      after: cursor?.after ?? null,
      limit: SKILL_PAGE_SIZE,
    });
    const page = rows.slice(0, SKILL_PAGE_SIZE);
    const last = page.at(-1);
    return {
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
      },
      sessions: totals.sessions,
      reportedSessions: totals.reported > 0 ? totals.reported : null,
      notReportedSessions: totals.sessions - totals.reported,
      skills: page,
      nextCursor:
        rows.length > SKILL_PAGE_SIZE && last
          ? encodeSkillCursor({ window, after: last.name })
          : null,
    };
  };
}

export const skillListHandler = createSkillListHandler({
  queries: postgresSkillQueries,
  now: () => new Date(),
});
