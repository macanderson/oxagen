/**
 * The scan behind the ledger idle close (#3988). The SQL is compiled with the
 * real PgDialect and asserted as text; `listIdleLedgerAttempts` runs against a
 * fake `withSystemDb`. The pg suite in @oxagen/inngest-functions
 * (`lib/ledger-idle-close.pg.test.ts`) runs the same statement on Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ withSystemDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withSystemDb: mocks.withSystemDb,
}));

import {
  buildListIdleAttemptsSql,
  LEDGER_IDLE_CLOSE_AFTER_MS,
  ledgerIdleCutoff,
  listIdleLedgerAttempts,
  mapIdleLedgerAttemptRow,
} from "./idle-attempts";

const dialect = new PgDialect();
const compile = (query: SQL) => dialect.sqlToQuery(query);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const NOW = new Date("2026-09-24T12:00:00.000Z");
const CUTOFF = new Date("2026-09-24T00:00:00.000Z");

const row = {
  run_id: "33333333-3333-4333-8333-333333333333",
  run_public_id: "arun_0123456789abcdef012345",
  org_id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  attempt_id: "44444444-4444-4444-8444-444444444444",
  attempt_public_id: "arat_0123456789abcdef0123",
  last_attempt_seq: "7",
  last_activity_at: "2026-09-23T20:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the ledger idle cutoff", () => {
  it("closes an attempt after twelve silent hours, as ADR-159 closes a session", () => {
    expect(LEDGER_IDLE_CLOSE_AFTER_MS).toBe(12 * 60 * 60 * 1000);
    expect(ledgerIdleCutoff(NOW)).toEqual(CUTOFF);
  });
});

describe("buildListIdleAttemptsSql", () => {
  const { sql, params } = compile(buildListIdleAttemptsSql(CUTOFF, 500));
  const text = oneLine(sql);

  it("reads the open attempt of an unfinished evidence-grade run", () => {
    expect(text).toContain(
      "JOIN agent.agent_run_attempts a ON a.id = r.active_attempt_id",
    );
    expect(text).toContain("r.spec_version = 2");
    expect(text).toContain("r.status IN ('pending', 'running')");
  });

  it("skips an attempt that already has a seal", () => {
    expect(text).toContain(
      "NOT EXISTS ( SELECT 1 FROM agent.agent_run_attempt_seals s WHERE s.attempt_id = a.id )",
    );
  });

  it("takes the head from the attempt's highest sequence, and 0 when it has no event", () => {
    expect(text).toContain("ORDER BY ev.attempt_seq DESC LIMIT 1");
    expect(text).toContain("coalesce(e.attempt_seq, 0) AS last_attempt_seq");
  });

  it("measures silence from the last event, or from the claim when there is none", () => {
    expect(text).toContain(
      "coalesce(e.created_at, a.claimed_at) < $1::timestamptz",
    );
    expect(text).toContain("ORDER BY coalesce(e.created_at, a.claimed_at) ASC");
    expect(params).toEqual([CUTOFF.toISOString(), 500]);
  });
});

describe("listIdleLedgerAttempts", () => {
  it("reads every organization through the system seam and maps each row", async () => {
    const execute = vi.fn(async (_query: unknown) => [row]);
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ execute }),
    );
    const found = await listIdleLedgerAttempts({ cutoff: CUTOFF, limit: 10 });
    expect(mocks.withSystemDb).toHaveBeenCalledOnce();
    expect(compile(execute.mock.calls[0]?.[0] as SQL).params).toEqual([
      CUTOFF.toISOString(),
      10,
    ]);
    expect(found).toEqual([mapIdleLedgerAttemptRow(row)]);
  });

  it("maps sequences and times from their wire forms", () => {
    expect(mapIdleLedgerAttemptRow(row)).toEqual({
      runId: row.run_id,
      runPublicId: row.run_public_id,
      orgId: row.org_id,
      workspaceId: row.workspace_id,
      attemptId: row.attempt_id,
      attemptPublicId: row.attempt_public_id,
      lastAttemptSeq: 7,
      lastActivityAt: new Date("2026-09-23T20:00:00.000Z"),
    });
  });
});
