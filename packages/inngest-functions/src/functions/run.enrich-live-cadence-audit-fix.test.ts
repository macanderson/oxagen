/**
 * The sweep's due rule for a live run. Every ingest batch moves a live run's
 * `updated_at`, so the revision rule alone re-summarized every active run
 * from its start at every five-minute sweep. A live run is now due only while
 * it has no name, or once its last enrichment is 30 minutes old; an ended run
 * keeps the revision rule.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../inngest", () => ({
  inngest: { createFunction: vi.fn(() => ({})) },
}));

import { schema } from "@oxagen/database";
import { PgDialect } from "drizzle-orm/pg-core";
import { dueForEnrichment, LIVE_ENRICHMENT_INTERVAL_MS } from "./run.enrich";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const dialect = new PgDialect();

function render(table: typeof schema.tachoSessions | typeof schema.agentRuns) {
  return dialect.sqlToQuery(dueForEnrichment(table, NOW)!);
}

describe("dueForEnrichment for a live run", () => {
  it("is 30 minutes", () => {
    expect(LIVE_ENRICHMENT_INTERVAL_MS).toBe(30 * 60_000);
  });

  it("gates a running wrapped session on its name and its last enrichment", () => {
    const { sql, params } = render(schema.tachoSessions);
    const s = '"tacho"."sessions"';
    // The revision rule is unchanged and still required.
    expect(sql).toContain(
      `${s}."updated_at" IS DISTINCT FROM ${s}."summary_observed_revision"`,
    );
    // And, as a second condition, the live gate: ended, unnamed, never
    // observed, or observed 30 minutes ago.
    expect(sql).toMatch(
      new RegExp(
        String.raw`\) and \(${esc(s)}\."outcome" <> \$3 or ${esc(s)}\."name" is null or ${esc(s)}\."summary_observed_at" is null or ${esc(s)}\."summary_observed_at" < \$4\)\)$`,
      ),
    );
    expect(params[2]).toBe("running");
    expect(params[3]).toBe("2026-09-23T11:30:00.000Z");
    // The five-minute retry for partial evidence keeps its own bound.
    expect(params[1]).toBe("2026-09-23T11:55:00.000Z");
  });

  it("treats a pending or running ledger run as live", () => {
    const { sql, params } = render(schema.agentRuns);
    const r = '"agent"."agent_runs"';
    expect(sql).toMatch(
      new RegExp(
        String.raw`\) and \(${esc(r)}\."status" not in \(\$3, \$4\) or ${esc(r)}\."name" is null or ${esc(r)}\."summary_observed_at" is null or ${esc(r)}\."summary_observed_at" < \$5\)\)$`,
      ),
    );
    expect(params.slice(2)).toEqual([
      "pending",
      "running",
      "2026-09-23T11:30:00.000Z",
    ]);
  });
});

function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");
}
