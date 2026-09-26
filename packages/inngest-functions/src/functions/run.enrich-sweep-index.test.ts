/**
 * The enrichment sweep reads its candidates from each run table's partial
 * index, not from every run a workspace recorded (#3784). Postgres uses a
 * partial index only when the query's WHERE proves the index's predicate, so
 * the sweep must carry each conjunct of that predicate as the same literal
 * text, with no bind parameter in it.
 *
 * `packages/database/integration/run-enrichment-sweep-plan.test.ts` shows
 * the planner choosing the index for a WHERE with these conjuncts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../inngest", () => ({
  inngest: { createFunction: vi.fn(() => ({})) },
}));

import { runEnrichmentCandidate, schema } from "@oxagen/database";
import { drizzle } from "drizzle-orm/pg-proxy";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { readableEnrichmentRun, sweepCandidates } from "./run.enrich";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const dialect = new PgDialect();
const db = drizzle(async () => ({ rows: [] }));

const TABLES = [
  {
    table: schema.tachoSessions,
    qualifier: '"tacho"."sessions".',
    index: "tacho_sessions_enrichment_candidate_idx",
  },
  {
    table: schema.agentRuns,
    qualifier: '"agent"."agent_runs".',
    index: "agent_runs_enrichment_candidate_idx",
  },
] as const;

/** The declared predicate of one partial index, as Atlas receives it. */
function indexPredicate(
  table: (typeof TABLES)[number]["table"],
  name: string,
): string {
  const found = getTableConfig(table).indexes.find(
    (index) => index.config.name === name,
  );
  const where = found?.config.where;
  if (!where) throw new Error(`${name} declares no predicate`);
  const rendered = dialect.sqlToQuery(where, "indexes");
  expect(rendered.params).toEqual([]);
  return rendered.sql;
}

describe("the sweep's candidate predicate", () => {
  it.each(TABLES)(
    "carries every conjunct of $index as literal text",
    ({ table, qualifier, index }) => {
      const query = sweepCandidates(db as never, table, NOW).toSQL();
      const where = query.sql.replaceAll(qualifier, "").toLowerCase();
      const predicate = indexPredicate(table, index);
      // `<readable> AND (<candidate>)`: the row filter the sweep already
      // applies, then the part of the due rule that does not move with time.
      const split = predicate.indexOf(" AND (");
      expect(split).toBeGreaterThan(0);
      const readable = predicate.slice(0, split).toLowerCase();
      const candidate = predicate.slice(split + " AND ".length).toLowerCase();
      expect(where).toContain(readable);
      expect(where).toContain(candidate);
      expect(candidate).not.toContain("$");
    },
  );

  it.each(TABLES)(
    "renders the candidate helper verbatim for $index",
    ({ table }) => {
      const candidate = dialect.sqlToQuery(runEnrichmentCandidate(table));
      expect(candidate.params).toEqual([]);
      expect(sweepCandidates(db as never, table, NOW).toSQL().sql).toContain(
        candidate.sql,
      );
    },
  );

  it("filters ledger runs on the literal version the index names", () => {
    const readable = dialect.sqlToQuery(
      readableEnrichmentRun(schema.agentRuns),
    );
    expect(readable.sql).toBe('"agent"."agent_runs"."spec_version" = 2');
    expect(readable.params).toEqual([]);
  });

  it("leaves the time-dependent due rule bound as before (negative)", () => {
    // The due rule compares against the clock, so it stays out of the index
    // and keeps its bind parameters.
    const query = sweepCandidates(
      db as never,
      schema.tachoSessions,
      NOW,
    ).toSQL();
    expect(query.sql).toMatch(/"summary_input_digest" like \$\d+/u);
    expect(query.params).toContain("partial:%");
  });
});
