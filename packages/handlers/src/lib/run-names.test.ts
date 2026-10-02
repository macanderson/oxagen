import { schema } from "@oxagen/database";
import { IN_APP_AGENT_SURFACES } from "@oxagen/oxagen/contracts/run.shared";
import { drizzle } from "drizzle-orm/postgres-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

import { readRunNames } from "./run-names";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const TSE = "tse_0000000000000000000001";
const TSE_BARE = "tse_0000000000000000000002";
const ARUN = "arun_000000000000000000001";
const ASSISTANT_RUN = "arun_000000000000000000002";

type Rows = { settings: unknown; sessions: unknown[]; runs: unknown[] };

/**
 * The ledger rows Postgres would answer. When the read leaves surfaces out, a
 * row that carries one of them is dropped. A row with no surface is kept.
 */
function ledgerRows(q: { sql: string; params: unknown[] }, runs: unknown[]) {
  if (!/"surface" not in/.test(q.sql)) return runs;
  return runs.filter(
    (r) => !q.params.includes((r as { surface?: string }).surface),
  );
}

/**
 * Hands each read a mock database, keeps the query it built, and answers it
 * with the rows for its table, as if Postgres had.
 */
function answer(rows: Rows) {
  const db = drizzle.mock({ schema });
  const captured: { sql: string; params: unknown[] }[] = [];
  mocks.withTenantDb.mockImplementation((fn: (tx: typeof db) => unknown) => {
    const query = fn(db) as { toSQL(): { sql: string; params: unknown[] } };
    const q = query.toSQL();
    captured.push(q);
    if (q.sql.includes('"workspaces"'))
      return Promise.resolve([{ settings: rows.settings }]);
    if (q.sql.includes('"agent_runs"'))
      return Promise.resolve(ledgerRows(q, rows.runs));
    return Promise.resolve(rows.sessions);
  });
  return captured;
}

const sessions = [
  {
    publicId: TSE,
    harnessTitle: null,
    name: "Repair the login redirect",
    title: "fix the login page it keeps bouncing",
  },
  { publicId: TSE_BARE, harnessTitle: null, name: null, title: null },
];
const runs = [{ publicId: ARUN, name: "Rotate the webhook secret" }];

describe("readRunNames", () => {
  beforeEach(() => {
    mocks.withTenantDb.mockReset();
  });

  it("names each run by its session name, as the Fleet board does", async () => {
    answer({ settings: {}, sessions, runs });
    const names = await readRunNames(SCOPE, [TSE, TSE_BARE, ARUN]);
    expect(names.get(TSE)).toBe("Repair the login redirect");
    expect(names.get(TSE_BARE)).toBeNull();
    expect(names.get(ARUN)).toBe("Rotate the webhook secret");
  });

  it("prefers the harness title over the generated name", async () => {
    answer({
      settings: {},
      sessions: [{ ...sessions[0], harnessTitle: "Login redirect loop" }],
      runs: [],
    });
    const names = await readRunNames(SCOPE, [TSE]);
    expect(names.get(TSE)).toBe("Login redirect loop");
  });

  it("keeps only the harness title when automatic accounts are off", async () => {
    answer({
      settings: { runEnrichmentEnabled: false },
      sessions: [
        { ...sessions[0], harnessTitle: "Login redirect loop" },
        { ...sessions[1] },
      ],
      runs,
    });
    const names = await readRunNames(SCOPE, [TSE, TSE_BARE, ARUN]);
    expect(names.get(TSE)).toBe("Login redirect loop");
    expect(names.get(TSE_BARE)).toBeNull();
    expect(names.get(ARUN)).toBeNull();
  });

  it("maps a run the scope does not hold to null", async () => {
    answer({ settings: {}, sessions: [], runs: [] });
    const names = await readRunNames(SCOPE, [TSE, ARUN]);
    expect([...names]).toEqual([
      [TSE, null],
      [ARUN, null],
    ]);
  });

  it("fences both reads on the caller's org and workspace", async () => {
    const captured = answer({ settings: {}, sessions, runs });
    await readRunNames(SCOPE, [TSE, ARUN]);
    const session = captured.find((q) => q.sql.includes('"sessions"'));
    const ledger = captured.find((q) => q.sql.includes('"agent_runs"'));
    for (const q of [session, ledger]) {
      expect(q!.sql).toMatch(/"org_id" = \$\d+/);
      expect(q!.sql).toMatch(/"workspace_id" = \$\d+/);
      expect(q!.params).toEqual(
        expect.arrayContaining([SCOPE.orgId, SCOPE.workspaceId]),
      );
    }
    expect(session!.params).toContain(TSE);
    expect(session!.params).not.toContain(ARUN);
    expect(ledger!.params).toContain(ARUN);
  });

  // ADR-235, 2026-10-02 amendment. An in-app assistant run's name may
  // summarize the person's question, and the workspace does not monitor the
  // assistant, so the ledger read leaves the in-app surfaces out.
  it("names no in-app assistant run and still names a run on another surface", async () => {
    const captured = answer({
      settings: {},
      sessions: [],
      runs: [
        {
          publicId: ARUN,
          name: "Rotate the webhook secret",
          surface: "external",
        },
        {
          publicId: ASSISTANT_RUN,
          name: "What did we spend on retries last week",
          surface: "chat",
        },
      ],
    });
    const names = await readRunNames(SCOPE, [ARUN, ASSISTANT_RUN]);
    expect(names.get(ARUN)).toBe("Rotate the webhook secret");
    expect(names.get(ASSISTANT_RUN)).toBeNull();
    const ledger = captured.find((q) => q.sql.includes('"agent_runs"'));
    expect(ledger!.sql).toMatch(
      /"agent_runs"\."surface" not in \(\$\d+, \$\d+\)/,
    );
    expect(ledger!.params).toEqual(
      expect.arrayContaining([...IN_APP_AGENT_SURFACES]),
    );
  });

  it("reads nothing for an empty list", async () => {
    answer({ settings: {}, sessions, runs });
    const names = await readRunNames(SCOPE, []);
    expect(names.size).toBe(0);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });
});
