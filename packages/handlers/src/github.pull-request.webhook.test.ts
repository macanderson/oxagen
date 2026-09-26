import { describe, expect, it, vi } from "vitest";

const { statements } = vi.hoisted(() => ({
  statements: [] as {
    seam: string;
    sql: string;
    params: unknown[];
    orgInScope: string | null;
  }[],
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@oxagen/database")>();
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { getScope } = await import("@oxagen/tenancy");
  const db = drizzle.mock({ schema: actual.schema });
  // Build each statement on a mock driver to read its SQL; no database.
  const seam =
    (name: string) => (fn: (tx: typeof db) => { toSQL(): unknown }) => {
      const q = fn(db).toSQL() as { sql: string; params: unknown[] };
      statements.push({
        seam: name,
        ...q,
        orgInScope: getScope()?.orgId ?? null,
      });
      return Promise.resolve([{ id: "r" }]);
    };
  return {
    ...actual,
    withSystemDb: seam("system"),
    withTenantDb: seam("tenant"),
  };
});

import {
  type GithubPullRequestStateDeps,
  githubPullRequestStateDeps,
  pullRequestDeliveryOf,
  recordGithubPullRequestState,
} from "./github.pull-request.webhook";
import type { ForgeKey, ForgeState } from "./lib/run-pull-request-state";

const ORG_A = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000000a",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000aa",
};
const ORG_B = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000000b",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000000bb",
};
const SEEN = new Date("2026-09-25T12:00:00Z");

/**
 * A store of rows keyed by org, with the newer-wins rule the SQL applies, so
 * the tests read the outcome of a sequence of deliveries.
 */
type Row = {
  orgId: string;
  key: ForgeKey;
  state: string | null;
  draft: boolean;
  sourceUpdatedAt: Date | null;
};

function fakeDeps(rows: Row[], connected: (typeof ORG_A)[]) {
  const deps: GithubPullRequestStateDeps = {
    connectedScopes: vi.fn(() => Promise.resolve(connected)),
    apply: vi.fn(
      (
        scope: typeof ORG_A,
        key: ForgeKey,
        forge: ForgeState,
      ): Promise<number> => {
        let n = 0;
        for (const row of rows) {
          if (row.orgId !== scope.orgId) continue;
          if (
            row.key.provider !== key.provider ||
            row.key.repository !== key.repository ||
            row.key.number !== key.number
          )
            continue;
          const newer =
            forge.sourceUpdatedAt === null
              ? row.sourceUpdatedAt === null
              : row.sourceUpdatedAt === null ||
                row.sourceUpdatedAt <= forge.sourceUpdatedAt;
          if (!newer) continue;
          row.state = forge.state;
          row.draft = forge.state === "open" && forge.draft;
          row.sourceUpdatedAt = forge.sourceUpdatedAt;
          n += 1;
        }
        return Promise.resolve(n);
      },
    ),
    now: () => SEEN,
  };
  return deps;
}

const KEY: ForgeKey = {
  provider: "github",
  repository: "acme/api",
  number: 42,
};

function delivery(pr: Record<string, unknown>, fullName = "Acme/API") {
  return {
    action: "edited",
    installation: { id: 555 },
    repository: { full_name: fullName },
    pull_request: { number: 42, ...pr },
  };
}

describe("pullRequestDeliveryOf", () => {
  it("reads the key lower-cased and the state", () => {
    expect(
      pullRequestDeliveryOf(
        delivery({
          state: "closed",
          merged: true,
          updated_at: "2026-09-25T10:00:00Z",
        }),
      ),
    ).toEqual({
      key: KEY,
      forge: {
        state: "merged",
        draft: false,
        sourceUpdatedAt: new Date("2026-09-25T10:00:00Z"),
      },
    });
  });

  it.each([
    ["no pull request", { repository: { full_name: "acme/api" } }],
    ["no repository", { pull_request: { number: 1, state: "open" } }],
    [
      "a repository with no owner",
      {
        repository: { full_name: "api" },
        pull_request: { number: 1, state: "open" },
      },
    ],
    [
      "a number of zero",
      {
        repository: { full_name: "acme/api" },
        pull_request: { number: 0, state: "open" },
      },
    ],
    [
      "a state GitHub does not send",
      {
        repository: { full_name: "acme/api" },
        pull_request: { number: 1, state: "gone" },
      },
    ],
  ])("reads %s as nothing (negative)", (_label, body) => {
    expect(pullRequestDeliveryOf(body)).toBeNull();
  });
});

describe("recordGithubPullRequestState", () => {
  it("applies a newer delivery and ignores an older one that arrives after it", async () => {
    const rows: Row[] = [
      {
        orgId: ORG_A.orgId,
        key: KEY,
        state: "open",
        draft: false,
        sourceUpdatedAt: new Date("2026-09-25T09:00:00Z"),
      },
    ];
    const deps = fakeDeps(rows, [ORG_A]);
    const merged = await recordGithubPullRequestState(deps, {
      installationId: "555",
      body: delivery({
        state: "closed",
        merged: true,
        updated_at: "2026-09-25T11:00:00Z",
      }),
    });
    expect(merged).toEqual({ outcome: "recorded", rows: 1 });
    // A stale `synchronize` from before the merge, delivered late.
    const stale = await recordGithubPullRequestState(deps, {
      installationId: "555",
      body: delivery({
        state: "open",
        updated_at: "2026-09-25T10:00:00Z",
      }),
    });
    expect(stale).toEqual({ outcome: "recorded", rows: 0 });
    expect(rows[0]?.state).toBe("merged");
  });

  it("moves a draft to ready for review", async () => {
    const rows: Row[] = [
      {
        orgId: ORG_A.orgId,
        key: KEY,
        state: "open",
        draft: true,
        sourceUpdatedAt: new Date("2026-09-25T09:00:00Z"),
      },
    ];
    await recordGithubPullRequestState(fakeDeps(rows, [ORG_A]), {
      installationId: "555",
      body: delivery({
        state: "open",
        draft: false,
        updated_at: "2026-09-25T09:30:00Z",
      }),
    });
    expect(rows[0]).toMatchObject({ state: "open", draft: false });
  });

  it("writes only workspaces connected to the installation (negative)", async () => {
    const rows: Row[] = [
      {
        orgId: ORG_A.orgId,
        key: KEY,
        state: null,
        draft: false,
        sourceUpdatedAt: null,
      },
      // Another tenant recorded a link to the same pull request and holds no
      // connection.
      {
        orgId: ORG_B.orgId,
        key: KEY,
        state: null,
        draft: false,
        sourceUpdatedAt: null,
      },
    ];
    const deps = fakeDeps(rows, [ORG_A]);
    await recordGithubPullRequestState(deps, {
      installationId: "555",
      body: delivery({ state: "closed", updated_at: "2026-09-25T10:00:00Z" }),
    });
    expect(rows.map((r) => r.state)).toEqual(["closed", null]);
    expect(deps.apply).toHaveBeenCalledTimes(1);
    expect(deps.connectedScopes).toHaveBeenCalledWith("555");
  });

  it("writes each connected workspace once", async () => {
    const rows: Row[] = [
      {
        orgId: ORG_A.orgId,
        key: KEY,
        state: null,
        draft: false,
        sourceUpdatedAt: null,
      },
      {
        orgId: ORG_B.orgId,
        key: KEY,
        state: null,
        draft: false,
        sourceUpdatedAt: null,
      },
    ];
    const out = await recordGithubPullRequestState(
      fakeDeps(rows, [ORG_A, ORG_B]),
      {
        installationId: "555",
        body: delivery({ state: "open", updated_at: "2026-09-25T10:00:00Z" }),
      },
    );
    expect(out).toEqual({ outcome: "recorded", rows: 2 });
  });

  it("still writes the other workspaces when one write fails, then throws (negative)", async () => {
    const rows: Row[] = [
      {
        orgId: ORG_B.orgId,
        key: KEY,
        state: null,
        draft: false,
        sourceUpdatedAt: null,
      },
    ];
    const deps = fakeDeps(rows, [ORG_A, ORG_B]);
    const write = deps.apply;
    deps.apply = vi.fn((scope, key, forge, seenAt) =>
      scope.orgId === ORG_A.orgId
        ? Promise.reject(new Error("plane unreachable"))
        : write(scope, key, forge, seenAt),
    );
    await expect(
      recordGithubPullRequestState(deps, {
        installationId: "555",
        body: delivery({ state: "closed", merged: true }),
      }),
    ).rejects.toThrow("1 of 2 workspaces could not store the state");
    expect(rows[0]?.state).toBe("merged");
  });

  it("reads nothing when no workspace holds a connection (negative)", async () => {
    const deps = fakeDeps([], []);
    expect(
      await recordGithubPullRequestState(deps, {
        installationId: "555",
        body: delivery({ state: "open" }),
      }),
    ).toEqual({ outcome: "no_connection", rows: 0 });
    expect(deps.apply).not.toHaveBeenCalled();
  });

  it("finds connected workspaces by the delivering installation only", async () => {
    statements.length = 0;
    const scopes = await githubPullRequestStateDeps.connectedScopes("555");
    expect(scopes).toEqual([{ id: "r" }]);
    const [read] = statements;
    expect(read?.seam).toBe("system");
    expect(read?.orgInScope).toBeNull();
    expect(read?.sql).toContain('select distinct "org_id", "workspace_id"');
    expect(read?.sql).toContain("->> 'installationId' = $");
    expect(read?.sql).toContain(
      '"ingestion"."source_connections"."deleted_at" is null',
    );
    expect(read?.params).toEqual(
      expect.arrayContaining(["github", "connected", "555"]),
    );
  });

  // An UPDATE through the org-wide seam changes no row of a standard table:
  // its policy judges writes by the scope's own workspace. So each write runs
  // in the workspace's tenant scope and names both.
  it("writes in the workspace's own tenant scope and names the org and workspace", async () => {
    statements.length = 0;
    const out = await githubPullRequestStateDeps.apply(
      ORG_A,
      KEY,
      { state: "closed", draft: false, sourceUpdatedAt: SEEN },
      SEEN,
    );
    expect(out).toBe(1);
    const [write] = statements;
    expect(write?.seam).toBe("tenant");
    expect(write?.orgInScope).toBe(ORG_A.orgId);
    expect(write?.sql).toContain('update "tacho"."run_pull_requests"');
    expect(write?.params).toEqual(
      expect.arrayContaining([ORG_A.orgId, ORG_A.workspaceId, "acme/api", 42]),
    );
    expect(write?.sql).toContain(
      '"tacho"."run_pull_requests"."workspace_id" = $',
    );
  });

  it("looks up no connection for a payload it cannot read (negative)", async () => {
    const deps = fakeDeps([], [ORG_A]);
    expect(
      await recordGithubPullRequestState(deps, {
        installationId: "555",
        body: { action: "opened" },
      }),
    ).toEqual({ outcome: "unreadable", rows: 0 });
    expect(deps.connectedScopes).not.toHaveBeenCalled();
  });
});
