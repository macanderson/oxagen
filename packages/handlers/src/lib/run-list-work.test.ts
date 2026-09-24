import { beforeEach, describe, expect, it, vi } from "vitest";

const { chSelect, tenantDb } = vi.hoisted(() => ({
  chSelect: vi.fn(),
  tenantDb: {
    rows: [] as unknown[],
    sql: [] as { sql: string; params: unknown[] }[],
  },
}));

vi.mock("@oxagen/telemetry", () => ({ chSelect }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const db = drizzle.mock({ schema: actual.schema });
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...actual,
    // Build the query on a mock driver to read its SQL, then answer the rows
    // the test set: no database, and the statement is still the real one.
    withTenantDb: (fn: (tx: typeof db) => { toSQL(): unknown }) => {
      tenantDb.sql.push(fn(db).toSQL() as { sql: string; params: unknown[] });
      return Promise.resolve(tenantDb.rows);
    },
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  matchesPullRequestFilter,
  postgresRunGitDiffs,
  pullRequestOf,
  readRunPullRequests,
  runDiffOf,
} from "./run-list-work";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const A = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const B = "0192d4a8-7c1e-7a00-8000-0000000000b2";
const CHILD = "0192d4a8-7c1e-7a00-8000-0000000000c3";

const row = (over: Partial<Parameters<typeof pullRequestOf>[0]> = {}) => ({
  session: A,
  url: "https://github.com/acme/api/pull/42",
  number: "42",
  repository: "acme/api",
  first_seq: "7",
  ...over,
});

beforeEach(() => {
  chSelect.mockReset();
  tenantDb.rows = [];
  tenantDb.sql = [];
});

describe("pullRequestOf", () => {
  it("keeps a recorded https page with its number and repository, state unknown", () => {
    expect(pullRequestOf(row())).toEqual({
      url: "https://github.com/acme/api/pull/42",
      number: 42,
      repository: "acme/api",
      state: null,
    });
  });

  it("keeps a GitLab merge request as recorded", () => {
    const url = "https://gitlab.com/acme/platform/api/-/merge_requests/9";
    expect(pullRequestOf(row({ url, number: "9", repository: "" }))).toEqual({
      url,
      number: 9,
      repository: null,
      state: null,
    });
  });

  it.each([
    ["not a URL", "#42"],
    ["plain http", "http://github.com/acme/api/pull/42"],
    ["a script URL", "javascript:alert(1)"],
  ])("drops %s (negative)", (_label, url) => {
    expect(pullRequestOf(row({ url }))).toBeNull();
  });

  it.each(["0", "-3", "", "4.5", "abc"])(
    "reads a number of %o as not recorded (negative)",
    (number) => {
      expect(pullRequestOf(row({ number }))?.number).toBeNull();
    },
  );
});

describe("readRunPullRequests", () => {
  it("reads nothing for no sessions", async () => {
    expect(await readRunPullRequests([])).toEqual(new Map());
    expect(chSelect).not.toHaveBeenCalled();
  });

  it("groups each session's links, earliest first, and drops unreadable ones", async () => {
    chSelect.mockResolvedValue({
      data: [
        row(),
        row({ url: "https://github.com/acme/api/pull/43", number: "43" }),
        row({ url: "ftp://example.com/x" }),
        row({ session: B, url: "https://github.com/acme/web/pull/1" }),
      ],
    });
    const out = await readRunPullRequests([A, B]);
    expect(out.get(A)?.map((p) => p.number)).toEqual([42, 43]);
    expect(out.get(B)?.map((p) => p.url)).toEqual([
      "https://github.com/acme/web/pull/1",
    ]);
    const call = chSelect.mock.calls[0]?.[0] as {
      query: string;
      params: Record<string, unknown>;
    };
    expect(call.params).toEqual({ sessions: [A, B], perSession: 10 });
    // Both frame shapes, chain-verified only, capped per session.
    expect(call.query).toContain("kind = 'oxagen:pr_link'");
    expect(call.query).toContain("attrs['pr.url'] != ''");
    expect(call.query).toContain("chain_verified = true");
    expect(call.query).toContain("LIMIT {perSession:UInt32} BY session");
  });

  it("stays inside what the tenant fence admits: one SELECT over one table, no set operations", async () => {
    // The rules `scopeSelectSource` (packages/telemetry/src/tenant.ts)
    // applies before it will fence a query; a query outside them throws there.
    chSelect.mockResolvedValue({ data: [] });
    await readRunPullRequests([A]);
    const { query } = chSelect.mock.calls[0]?.[0] as { query: string };
    expect(query.match(/\bSELECT\b/gi)).toHaveLength(1);
    expect(query.match(/\bFROM\b/gi)).toHaveLength(1);
    expect(query).toMatch(/\bFROM tacho_events FINAL\s+WHERE\b/);
    expect(query).not.toMatch(/\bIN\b(?!\s*(?:\(|\[|\{[a-z_]\w*:Array\())/i);
    expect(query).not.toMatch(
      /;|--|\/\*|\*\/|#|\b(?:JOIN|UNION|INTERSECT|EXCEPT|WITH|INTO|SETTINGS|FORMAT)\b/i,
    );
  });

  it("lets a ClickHouse failure reach the caller, which decides what to show (negative)", async () => {
    chSelect.mockRejectedValue(new Error("down"));
    await expect(readRunPullRequests([A])).rejects.toThrow("down");
  });
});

describe("postgresRunGitDiffs", () => {
  it("reads nothing for no sessions", async () => {
    expect(await postgresRunGitDiffs(SCOPE, [])).toEqual(new Map());
    expect(tenantDb.sql).toEqual([]);
  });

  it("folds each subagent chain into its root and names the tenant", async () => {
    tenantDb.rows = [
      { chain: A, root: A, added: 10, removed: 2 },
      { chain: CHILD, root: A, added: 5, removed: 1 },
      { chain: B, root: B, added: 0, removed: 7 },
      // A chain under a root this page did not ask about.
      {
        chain: CHILD,
        root: "0192d4a8-7c1e-7a00-8000-0000000000ff",
        added: 9,
        removed: 9,
      },
    ];
    const out = await postgresRunGitDiffs(SCOPE, [A, B]);
    expect(out).toEqual(
      new Map([
        [A, { added: 15, removed: 3 }],
        [B, { added: 0, removed: 7 }],
      ]),
    );
    const [query] = tenantDb.sql;
    expect(query?.sql).toContain('"observed_status" is not null');
    expect(query?.sql).toMatch(/group by/i);
    expect(query?.params).toEqual(
      expect.arrayContaining([SCOPE.orgId, SCOPE.workspaceId, A, B]),
    );
  });
});

describe("runDiffOf", () => {
  it("prefers the harness's totals", () => {
    expect(
      runDiffOf({ linesAdded: 3, linesRemoved: 0 }, { added: 9, removed: 9 }),
    ).toEqual({ added: 3, removed: 0, basis: "harness_reported" });
  });

  it("falls back to git's uncommitted change", () => {
    expect(runDiffOf({}, { added: 0, removed: 4 })).toEqual({
      added: 0,
      removed: 4,
      basis: "git_observed",
    });
  });

  it("answers null rather than +0 −0 when neither reported a change (negative)", () => {
    expect(runDiffOf({ linesAdded: 0, linesRemoved: 0 }, undefined)).toBeNull();
    expect(runDiffOf({}, { added: 0, removed: 0 })).toBeNull();
  });
});

describe("matchesPullRequestFilter", () => {
  const link = [
    {
      url: "https://github.com/a/b/pull/1",
      number: 1,
      repository: null,
      state: null,
    },
  ];
  it.each([
    ["any", undefined, undefined, true],
    ["with", link, 0, true],
    ["with", [], 1, true],
    ["with", undefined, 2, true],
    ["with", [], 0, false],
    ["without", [], 0, true],
    ["without", undefined, undefined, true],
    ["without", link, 0, false],
    ["without", [], 3, false],
  ] as const)(
    "%s with links %o and %o counted is %s",
    (filter, links, opened, expected) => {
      expect(matchesPullRequestFilter(filter, links, opened)).toBe(expected);
    },
  );
});
