/**
 * The sweep's due rule for a live run. Every ingest batch moves a live run's
 * `updated_at`, so the revision rule alone re-summarized every active run
 * from its start at every five-minute sweep. A live run is now due only while
 * it has no name, or once its last enrichment is 30 minutes old. An ended run
 * that changed after its account is held the same way, since a sealed Claude
 * Code session goes on receiving events. One that did not change is due for
 * its own reasons.
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
    // And, as a second condition, the hold: unnamed, never observed,
    // observed 30 minutes ago, or ended and unchanged since its account.
    expect(sql).toMatch(
      new RegExp(
        String.raw`\) and \(${esc(s)}\."name" is null or ${esc(s)}\."summary_observed_at" is null or ${esc(s)}\."summary_observed_at" < \$4 or \(${esc(s)}\."outcome" <> \$5 and ${esc(s)}\."updated_at" IS NOT DISTINCT FROM ${esc(s)}\."summary_observed_revision"\)\) and ${esc(s)}\."summary_spent_usd_micros" < \$6\)$`,
      ),
    );
    expect(params[3]).toBe("2026-09-23T11:30:00.000Z");
    expect(params[4]).toBe("running");
    // A run whose accounts have cost the run's cap is never due (#4312).
    expect(params[5]).toBe(5_000_000);
    // The five-minute retry for partial evidence and the retry after a
    // failure keep their own bounds.
    expect(params[1]).toBe("2026-09-23T11:55:00.000Z");
    expect(params[2]).toBe("2026-09-23T11:30:00.000Z");
  });

  it("treats a pending or running ledger run as live", () => {
    const { sql, params } = render(schema.agentRuns);
    const r = '"agent"."agent_runs"';
    expect(sql).toMatch(
      new RegExp(
        String.raw`\) and \(${esc(r)}\."name" is null or ${esc(r)}\."summary_observed_at" is null or ${esc(r)}\."summary_observed_at" < \$4 or \(${esc(r)}\."status" not in \(\$5, \$6\) and ${esc(r)}\."updated_at" IS NOT DISTINCT FROM ${esc(r)}\."summary_observed_revision"\)\) and ${esc(r)}\."summary_spent_usd_micros" < \$7\)$`,
      ),
    );
    expect(params.slice(3)).toEqual([
      "2026-09-23T11:30:00.000Z",
      "pending",
      "running",
      5_000_000,
    ]);
  });
});

function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");
}
