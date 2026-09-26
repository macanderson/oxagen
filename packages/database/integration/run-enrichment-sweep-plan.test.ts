/**
 * Run-enrichment sweep indexes: live-database proof (#3784).
 *
 * The five-minute sweep used to filter `tacho.sessions` and
 * `agent.agent_runs` with no index that matched, so each pass read every run
 * a workspace ever recorded. Each table now has a partial index over the runs
 * the sweep may find due (`runEnrichmentCandidate`). Postgres reads a partial
 * index only when it can prove the query's WHERE implies the index's
 * predicate. The sweep's WHERE carries the same literal conjuncts
 * (`run.enrich-sweep-index.test.ts` in @oxagen/inngest-functions pins that).
 * This file shows the planner choosing each index for a WHERE built from
 * those conjuncts, and refusing it when a conjunct is missing or bound.
 *
 * Sequential scans are switched off for each plan, so a planner that cannot
 * prove the predicate has no index to fall back on and shows a Seq Scan.
 * The tables can be empty: the proof is about which paths exist, not rows.
 *
 * CI: rls-integration job (migrated database).
 * Local: DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *          pnpm --filter @oxagen/database exec vitest run \
 *          --config vitest.integration.config.ts integration/run-enrichment-sweep-plan.test.ts
 */
import { and, isNull, type SQL, sql as drizzleSql } from "drizzle-orm";
import { PgDialect, type PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { agentRuns } from "../src/schema/agent";
import { runEnrichmentCandidate } from "../src/schema/run-enrichment";
import { tachoSessions } from "../src/schema/tacho";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

afterAll(() => sql.end({ timeout: 5 }));

const dialect = new PgDialect();

interface PlanNode {
  "Node Type"?: string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

/** Every node of a plan, depth first. */
function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

/** The plan of `statement`, with sequential scans switched off. */
async function planOf(statement: string): Promise<PlanNode[]> {
  return sql.begin(async (tx) => {
    await tx`SET LOCAL enable_seqscan = off`;
    const rows = await tx.unsafe<{ "QUERY PLAN": [{ Plan: PlanNode }] }[]>(
      `EXPLAIN (FORMAT JSON) ${statement}`,
    );
    const plan = rows[0]?.["QUERY PLAN"][0]?.Plan;
    if (!plan) throw new Error("EXPLAIN returned no plan");
    return nodesOf(plan);
  });
}

/** A select of the run's public id under `where`, rendered with no parameters. */
function selectWhere(table: PgTable, where: SQL | undefined): string {
  const query = dialect.sqlToQuery(
    drizzleSql`select 1 from ${table} where ${where}`,
  );
  expect(query.params).toEqual([]);
  return query.sql;
}

const indexesIn = (nodes: PlanNode[]) =>
  nodes.flatMap((node) => (node["Index Name"] ? [node["Index Name"]] : []));

describe("the run-enrichment sweep's partial indexes", () => {
  it("reads root sessions the sweep may find due from tacho_sessions_enrichment_candidate_idx", async () => {
    const nodes = await planOf(
      selectWhere(
        tachoSessions,
        and(
          isNull(tachoSessions.parentSessionUuid),
          runEnrichmentCandidate(tachoSessions),
        ),
      ),
    );
    expect(indexesIn(nodes)).toContain(
      "tacho_sessions_enrichment_candidate_idx",
    );
    expect(nodes.map((node) => node["Node Type"])).not.toContain("Seq Scan");
  });

  it("reads V2 ledger runs the sweep may find due from agent_runs_enrichment_candidate_idx", async () => {
    const nodes = await planOf(
      selectWhere(
        agentRuns,
        and(
          drizzleSql`${agentRuns.specVersion} = 2`,
          runEnrichmentCandidate(agentRuns),
        ),
      ),
    );
    expect(indexesIn(nodes)).toContain("agent_runs_enrichment_candidate_idx");
    expect(nodes.map((node) => node["Node Type"])).not.toContain("Seq Scan");
  });

  it("cannot use the index without the candidate conjunct (negative)", async () => {
    const nodes = await planOf(
      selectWhere(tachoSessions, isNull(tachoSessions.parentSessionUuid)),
    );
    expect(indexesIn(nodes)).not.toContain(
      "tacho_sessions_enrichment_candidate_idx",
    );
  });

  it("cannot use the index when the version is a parameter of a generic plan (negative)", async () => {
    // Why the sweep writes `spec_version = 2` as a literal: a plan built for
    // any value of `$1` cannot prove the index's `spec_version = 2`.
    const where = dialect.sqlToQuery(runEnrichmentCandidate(agentRuns)).sql;
    const nodes = await sql.begin(async (tx) => {
      await tx`SET LOCAL enable_seqscan = off`;
      await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
      await tx.unsafe(
        `PREPARE run_enrichment_generic(int) AS select 1 from "agent"."agent_runs" where "agent"."agent_runs"."spec_version" = $1 and ${where}`,
      );
      try {
        const rows = await tx.unsafe<{ "QUERY PLAN": [{ Plan: PlanNode }] }[]>(
          "EXPLAIN (FORMAT JSON) EXECUTE run_enrichment_generic(2)",
        );
        const plan = rows[0]?.["QUERY PLAN"][0]?.Plan;
        if (!plan) throw new Error("EXPLAIN returned no plan");
        return nodesOf(plan);
      } finally {
        await tx.unsafe("DEALLOCATE run_enrichment_generic");
      }
    });
    expect(indexesIn(nodes)).not.toContain(
      "agent_runs_enrichment_candidate_idx",
    );
  });
});
