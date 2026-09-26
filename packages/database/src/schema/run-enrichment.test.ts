/**
 * The run-enrichment sweep can use its partial indexes only when Postgres
 * proves the sweep's WHERE implies each index's predicate (#3784). Both sides
 * build the predicate from `runEnrichmentCandidate`. These cases pin what it
 * renders: the same expression in the index and in a query, and no bind
 * parameter in either, since a `$1` cannot prove a literal.
 */
import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentRuns } from "./agent";
import { runEnrichmentCandidate } from "./run-enrichment";
import { tachoSessions } from "./tacho";

const dialect = new PgDialect();

const CANDIDATE =
  '("summary_observed_at" IS NULL OR "summary_error" IS NOT NULL OR "summary_observed_revision" IS NULL OR "updated_at" IS DISTINCT FROM "summary_observed_revision" OR "summary_input_digest" LIKE \'partial:%\')';

function declaredIndex(table: PgTable, name: string) {
  const found = getTableConfig(table).indexes.find(
    (index) => index.config.name === name,
  );
  if (!found) throw new Error(`${name} is not declared`);
  const where = found.config.where;
  if (!where) throw new Error(`${name} has no predicate`);
  return {
    columns: found.config.columns.map((column) =>
      "name" in column ? column.name : null,
    ),
    // `indexes` is how drizzle-kit renders an index predicate for Atlas.
    where: dialect.sqlToQuery(where, "indexes"),
  };
}

describe("run-enrichment candidate indexes", () => {
  it("declares the tacho.sessions index over root sessions the sweep may find due", () => {
    const index = declaredIndex(
      tachoSessions,
      "tacho_sessions_enrichment_candidate_idx",
    );
    expect(index.columns).toEqual(["org_id", "workspace_id"]);
    expect(index.where.sql).toBe(
      `"parent_session_uuid" IS NULL AND ${CANDIDATE}`,
    );
    expect(index.where.params).toEqual([]);
  });

  it("declares the agent_runs index over V2 runs with the literal 2", () => {
    const index = declaredIndex(
      agentRuns,
      "agent_runs_enrichment_candidate_idx",
    );
    expect(index.columns).toEqual(["org_id", "workspace_id"]);
    expect(index.where.sql).toBe(`"spec_version" = 2 AND ${CANDIDATE}`);
    expect(index.where.params).toEqual([]);
  });
});

describe("runEnrichmentCandidate", () => {
  it("renders the same expression in a query, qualified and with no parameter", () => {
    for (const [table, qualifier] of [
      [tachoSessions, '"tacho"."sessions".'],
      [agentRuns, '"agent"."agent_runs".'],
    ] as const) {
      const query = dialect.sqlToQuery(runEnrichmentCandidate(table));
      expect(query.params).toEqual([]);
      // Stripping the table qualifier leaves the index's own text.
      expect(query.sql.replaceAll(qualifier, "")).toBe(CANDIDATE);
    }
  });

  it("reads no spend column, so the index does not churn with each job (negative)", () => {
    const query = dialect.sqlToQuery(runEnrichmentCandidate(tachoSessions));
    expect(query.sql).not.toMatch(/spent/);
  });
});
