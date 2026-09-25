/**
 * `get_steering_freshness` — the platform half of the steering freshness
 * check. This pins the two things every caller depends on: the policy is
 * read permissively (a bad value is both gates off, never a throw), and the
 * commit reported is the newest publication rather than the newest row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn(), transactions: [] as 1[] }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      // Counted, so a test can pin that a pair of reads that must agree runs
      // in one transaction rather than two.
      mocks.transactions.push(1);
      return fn({ select: mocks.select });
    },
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  createGetSteeringFreshnessHandler,
  readGatePolicy,
  syncView,
} from "./context.steering.freshness";
import { postgresSteeringStore } from "./context.steering.store";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

describe("readGatePolicy", () => {
  it("is both gates off when the workspace has never set one", () => {
    expect(readGatePolicy(null)).toEqual({
      autoSync: false,
      blockStaleRuns: false,
    });
    expect(readGatePolicy({})).toEqual({
      autoSync: false,
      blockStaleRuns: false,
    });
  });

  it("reads each gate independently", () => {
    expect(readGatePolicy({ steering: { autoSync: true } })).toEqual({
      autoSync: true,
      blockStaleRuns: false,
    });
    expect(readGatePolicy({ steering: { blockStaleRuns: true } })).toEqual({
      autoSync: false,
      blockStaleRuns: true,
    });
  });

  // One bad value must not take out the hook in front of every prompt in the
  // workspace, and must not switch a gate ON for a reason nobody can act on.
  it.each([
    { steering: { blockStaleRuns: "yes" } },
    { steering: "on" },
    { steering: [] },
    { steering: 7 },
  ])("reads %o as both gates off, and does not throw", (settings) => {
    expect(readGatePolicy(settings)).toEqual({
      autoSync: false,
      blockStaleRuns: false,
    });
  });

  // Deliberately lenient, and deliberately the opposite of the file schema
  // in `@oxagen/steering-freshness`, which is `.strict()`. A hand-edited
  // settings file should reject a typo, because a person is there to fix it.
  // A stored workspace policy should keep working when a newer Mission
  // Control writes a third gate this build has never heard of, because
  // otherwise a deploy blanks the two gates every customer already set.
  it("keeps the gates it knows and ignores a member it does not", () => {
    expect(
      readGatePolicy({ steering: { autoSync: true, somethingElse: 1 } }),
    ).toEqual({ autoSync: true, blockStaleRuns: false });
  });
});

describe("syncView", () => {
  const state = {
    provider: "github",
    repository: "acme/platform",
    branch: "main",
    headSha: "feed123",
    rulesSha: "feed123",
    status: "synced" as const,
    findings: [],
    error: null,
    requestedAt: new Date("2026-09-25T10:00:00Z"),
    syncedAt: new Date("2026-09-25T10:00:04Z"),
  };

  it("is null before the workspace's first sync", () => {
    expect(syncView(null)).toBeNull();
  });

  it("keeps the last sync's status once it finished after the request", () => {
    expect(syncView(state)?.status).toBe("synced");
  });

  // A push arrived after the last sync finished: the page says a sync is on
  // its way, whatever the last one decided, and refreshes until it lands.
  it("reads pending while a request is newer than the last finished sync", () => {
    expect(
      syncView({ ...state, requestedAt: new Date("2026-09-25T10:05:00Z") })
        ?.status,
    ).toBe("pending");
    expect(syncView({ ...state, syncedAt: null })?.status).toBe("pending");
  });
});

/** The predicate each `where` received, in call order, so a test can read it. */
const wheres: unknown[] = [];

/** The workspace-settings read the handler makes. */
function stubReads(settings: unknown): void {
  const chain = (rows: unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const key of ["from", "innerJoin", "orderBy"]) {
      self[key] = () => self;
    }
    self.where = (predicate: unknown) => {
      wheres.push(predicate);
      return self;
    };
    self.limit = async () => rows;
    return self;
  };
  mocks.select.mockReturnValueOnce(chain([{ settings }]));
}

describe("get_steering_freshness handler", () => {
  beforeEach(() => {
    mocks.select.mockReset();
    mocks.transactions.length = 0;
    wheres.length = 0;
  });

  const store = {
    versionAndPublication: vi.fn(async () => ({
      version: 12,
      publication: {
        commitSha: "abc1234",
        commitShas: ["abc1234", "def5678"],
        publishedAt: new Date("2026-09-01T10:00:00.000Z"),
      },
    })),
  };

  const bound = vi.fn(async () => ({
    source: "binding" as const,
    owner: "acme",
    repo: "platform",
    approvedFullName: "acme/platform",
    approvedDefaultRef: "main",
  }));

  it("reports the version, the publishing commit, the branch and the gates", async () => {
    stubReads({ steering: { blockStaleRuns: true } });
    const handler = createGetSteeringFreshnessHandler({
      store: store as never,
      readConnection: bound as never,
      readSyncState: async () => null,
    });
    const out = await handler({}, CTX);
    expect(out).toEqual({
      steeringVersion: 12,
      headCommit: "abc1234",
      // Two merges in one second: both, because the platform cannot order them.
      headCommits: ["abc1234", "def5678"],
      publishedAt: "2026-09-01T10:00:00.000Z",
      repository: "acme/platform",
      provider: "github",
      defaultBranch: "main",
      policy: { autoSync: false, blockStaleRuns: true },
      sync: null,
    });
  });

  it("carries the repository sync's state and its findings (ADR-184)", async () => {
    stubReads(null);
    const finding = {
      level: "error" as const,
      path: ".oxagen/rules/team.toml",
      lineageId: "ctx.team.review",
      code: "secret" as const,
      message: "carries a credential token",
    };
    const handler = createGetSteeringFreshnessHandler({
      store: store as never,
      readConnection: bound as never,
      readSyncState: async () => ({
        provider: "github",
        repository: "acme/platform",
        branch: "main",
        headSha: "feed123",
        rulesSha: "feed123",
        status: "problems",
        findings: [finding],
        error: null,
        requestedAt: new Date("2026-09-25T10:00:00Z"),
        syncedAt: new Date("2026-09-25T10:00:04Z"),
      }),
    });
    const out = await handler({}, CTX);
    expect(out.sync).toEqual({
      status: "problems",
      headSha: "feed123",
      requestedAt: "2026-09-25T10:00:00.000Z",
      syncedAt: "2026-09-25T10:00:04.000Z",
      error: null,
      findings: [finding],
    });
  });

  // The read sits in front of a developer's prompt. A sync table it cannot
  // read is a missing line on a page, never a failed prompt.
  it("answers without the sync when its state cannot be read", async () => {
    stubReads(null);
    const handler = createGetSteeringFreshnessHandler({
      store: store as never,
      readConnection: bound as never,
      readSyncState: async () => {
        throw new Error("relation does not exist");
      },
    });
    const out = await handler({}, CTX);
    expect(out.sync).toBeNull();
    expect(out.steeringVersion).toBe(12);
  });

  // Steering is off for a workspace until a repository is bound, and the
  // read has to say so rather than invent a branch.
  // A workspace still on the legacy sources wizard has no binding head.
  // Reading bindings alone reported `repository: null`, the CLI discarded
  // the whole platform answer, and neither gate could be enforced there.
  it("names the repository a legacy connection carries", async () => {
    stubReads({ steering: { blockStaleRuns: true } });
    const handler = createGetSteeringFreshnessHandler({
      store: store as never,
      readConnection: vi.fn(async () => ({
        source: "legacy_delivery_config" as const,
        owner: "acme",
        repo: "platform",
      })) as never,
    });
    const out = await handler({}, CTX);
    expect(out.repository).toBe("acme/platform");
    // A legacy connection states no ref; the CLI resolves the remote's own.
    expect(out.defaultBranch).toBeNull();
    expect(out.policy.blockStaleRuns).toBe(true);
  });

  it("names a GitLab main project and its host, so the CLI matches its gitlab.com remote (#3762)", async () => {
    stubReads(null);
    const handler = createGetSteeringFreshnessHandler({
      store: store as never,
      readConnection: vi.fn(async () => ({
        provider: "gitlab" as const,
        source: "binding" as const,
        owner: "acme/platform",
        repo: "rules",
        approvedFullName: "acme/platform/rules",
        approvedDefaultRef: "main",
      })) as never,
    });
    const out = await handler({}, CTX);
    expect(out.repository).toBe("acme/platform/rules");
    expect(out.provider).toBe("gitlab");
    expect(out.defaultBranch).toBe("main");
  });

  it("reports nulls, not guesses, when no repository is bound", async () => {
    stubReads(null);
    const handler = createGetSteeringFreshnessHandler({
      store: {
        versionAndPublication: vi.fn(async () => ({
          version: 0,
          publication: null,
        })),
      } as never,
      readConnection: vi.fn(async () => null) as never,
    });
    const out = await handler({}, CTX);
    expect(out.repository).toBeNull();
    expect(out.provider).toBeNull();
    expect(out.defaultBranch).toBeNull();
    expect(out.headCommit).toBeNull();
    expect(out.headCommits).toEqual([]);
    expect(out.publishedAt).toBeNull();
    expect(out.steeringVersion).toBe(0);
  });

  // A Context PR publication commits while this read is in flight. Read
  // independently, the count could observe the new promotion while the
  // publication still observed the commit before it, and the response paired
  // the new steering version with the old `headCommit`. A checkout sitting at
  // that old commit — with its cached remote there too, and a failed fetch —
  // then read as current under the new version on both signals at once, and
  // `blockStaleRuns` allowed the first prompt after the new record entered
  // force. The pair comes from one snapshot or it does not come at all.
  it("pairs the version with the publication from one snapshot", async () => {
    stubReads({ steering: { blockStaleRuns: true } });
    const racy = {
      // What two independent reads would have answered across that commit:
      // the count from after it, the publication from before it.
      ledgerLength: vi.fn(async () => 13),
      latestPublication: vi.fn(async () => ({
        commitSha: "old1234",
        commitShas: ["old1234"],
        publishedAt: new Date("2026-09-01T10:00:00.000Z"),
      })),
      versionAndPublication: vi.fn(async () => ({
        version: 12,
        publication: {
          commitSha: "old1234",
          commitShas: ["old1234"],
          publishedAt: new Date("2026-09-01T10:00:00.000Z"),
        },
      })),
    };
    const handler = createGetSteeringFreshnessHandler({
      store: racy as never,
      readConnection: bound as never,
    });
    const out = await handler({}, CTX);
    expect(out.steeringVersion).toBe(12);
    expect(out.headCommit).toBe("old1234");
    expect(racy.ledgerLength).not.toHaveBeenCalled();
    expect(racy.latestPublication).not.toHaveBeenCalled();
  });

  // And the store keeps that promise: both queries inside one transaction.
  it("reads the version and the publication in one transaction", async () => {
    const thenable = (rows: unknown[]) => {
      const self: Record<string, unknown> = {};
      for (const key of ["from", "where", "orderBy", "limit"]) {
        self[key] = () => self;
      }
      self.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve);
      return self;
    };
    // In call order: the newest-instant subquery, the promotions count, then
    // the publications tied at that instant.
    mocks.select
      .mockReturnValueOnce(thenable([]))
      .mockReturnValueOnce(thenable([{ total: 12 }]))
      .mockReturnValueOnce(
        thenable([
          {
            commitSha: "old1234",
            publishedAt: new Date("2026-09-01T10:00:00.000Z"),
          },
        ]),
      );
    const out = await postgresSteeringStore.versionAndPublication({
      orgId: CTX.orgId,
      workspaceId: CTX.workspaceId,
    });
    expect(out.version).toBe(12);
    expect(out.publication?.commitSha).toBe("old1234");
    expect(mocks.transactions).toHaveLength(1);
  });
});
