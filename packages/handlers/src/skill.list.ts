// audit-exempt: read-only. Lists the skill names this workspace's harness
// sessions reported at start from tacho.sessions; mutates nothing, and the
// kernel's capability.invoke_* audit records the access.
//
// `list_skills` (#3098): the one record of skills Oxagen keeps is
// `tacho.sessions.skills_available`, the name list a wrapped harness reports
// when a session starts (packages/tacho/src/envelope.ts, written by
// ingest_tacho_events). Oxagen does not run, resolve or author a skill
// (ADR-043), so this read answers which skills the harness had and nothing
// else: no version, digest, source, cost or decision exists to return.
//
// A session whose inventory is null, or anything but a JSON array, did not
// report one. It is counted as not reported and never as a session with no
// skills; `reportedSessions` is null when no session in the window reported.
//
// The kernel enters the tenant scope before this handler runs, so both reads
// go through withTenantDb, whose RLS is the tenant filter. The queries ALSO
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
  SKILL_PAGE_SIZE,
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

/** Null for anything that is not a cursor this handler wrote. */
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
      from >= to
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
  totals: (scope: SkillScope, window: SkillWindow) => Promise<SessionTotals>;
  /** Names after `after`, by name, at most `limit` rows. */
  names: (
    scope: SkillScope,
    window: SkillWindow,
    q: { after: string | null; limit: number },
  ) => Promise<SkillInventoryRow[]>;
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
      sessions: sql<number>`count(*)::int`,
      reported: sql<number>`(count(*) filter (where ${REPORTED}))::int`,
    })
    .from(sessions)
    .where(inWindow(scope, window));
}

/** The instant in the wire's RFC 3339 form, rendered by Postgres. */
const iso = (column: SQL) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * One row per reported name: the sessions whose inventory named it (a name
 * listed twice in one inventory counts that session once), their harnesses
 * joined by newlines, and the first and last start. Reads one row past the
 * page so the caller knows whether a next page exists.
 */
export function namesQuery(
  scope: SkillScope,
  window: SkillWindow,
  q: { after: string | null; limit: number },
): SQL {
  return sql`
    select skill.name as name,
      count(distinct s.id)::int as sessions,
      string_agg(distinct s.harness, E'\n' order by s.harness) as harnesses,
      ${iso(sql`min(s.started_at)`)} as first_seen_at,
      ${iso(sql`max(s.started_at)`)} as last_seen_at
    from ${sessions} as s
    cross join lateral jsonb_array_elements_text(s.skills_available) as skill(name)
    where s.org_id = ${scope.orgId}::uuid
      and s.workspace_id = ${scope.workspaceId}::uuid
      and s.started_at >= ${window.from.toISOString()}::timestamptz
      and s.started_at < ${window.to.toISOString()}::timestamptz
      and jsonb_typeof(s.skills_available) = 'array'
      and skill.name <> ''
      ${q.after === null ? sql`` : sql`and skill.name > ${q.after}`}
    group by skill.name
    order by skill.name
    limit ${q.limit + 1}
  `;
}

const nameRowSchema = z.object({
  name: z.string().min(1),
  sessions: z.coerce.number().int().positive(),
  harnesses: z.string().min(1),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
});

/** A row of namesQuery as the contract's row; a row outside its shape fails the read. */
export function toInventoryRow(raw: unknown): SkillInventoryRow {
  const row = nameRowSchema.parse(raw);
  return {
    name: row.name,
    sessions: row.sessions,
    harnesses: row.harnesses.split("\n"),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export const postgresSkillQueries: SkillQueries = {
  totals: async (scope, window) => {
    const [row] = await withTenantDb((tx) => totalsQuery(tx, scope, window));
    if (!row) throw new Error("count(*) returned no row");
    return { sessions: row.sessions, reported: row.reported };
  },
  names: async (scope, window, q) => {
    const rows = await withTenantDb((tx) =>
      tx.execute(namesQuery(scope, window, q)),
    );
    return [...rows].map(toInventoryRow);
  },
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
      throw new CapabilityError(skillList.name, "invalid_input", "invalid_cursor");
    const window = cursor?.window ?? windowEndingAt(deps.now(), input.windowDays);

    // ── Read ──────────────────────────────────────────────────────────────
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const totals = await deps.queries.totals(scope, window);
    const rows = await deps.queries.names(scope, window, {
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
