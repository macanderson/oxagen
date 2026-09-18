/**
 * `get_steering_freshness` — the platform half of the steering freshness
 * check. This pins the two things every caller depends on: the policy is
 * read permissively (a bad value is both gates off, never a throw), and the
 * commit reported is the newest publication rather than the newest row.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ select: mocks.select }),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  createGetSteeringFreshnessHandler,
  readGatePolicy,
} from "./context.steering.freshness";
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
    wheres.length = 0;
  });

  const store = {
    ledgerLength: vi.fn(async () => 12),
    latestPublication: vi.fn(async () => ({
      commitSha: "abc1234",
      commitShas: ["abc1234", "def5678"],
      publishedAt: new Date("2026-09-01T10:00:00.000Z"),
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
    });
    const out = await handler({}, CTX);
    expect(out).toEqual({
      steeringVersion: 12,
      headCommit: "abc1234",
      // Two merges in one second: both, because the platform cannot order them.
      headCommits: ["abc1234", "def5678"],
      publishedAt: "2026-09-01T10:00:00.000Z",
      repository: "acme/platform",
      defaultBranch: "main",
      policy: { autoSync: false, blockStaleRuns: true },
    });
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

  it("reports nulls, not guesses, when no repository is bound", async () => {
    stubReads(null);
    const handler = createGetSteeringFreshnessHandler({
      store: {
        ledgerLength: vi.fn(async () => 0),
        latestPublication: vi.fn(async () => null),
      } as never,
      readConnection: vi.fn(async () => null) as never,
    });
    const out = await handler({}, CTX);
    expect(out.repository).toBeNull();
    expect(out.defaultBranch).toBeNull();
    expect(out.headCommit).toBeNull();
    expect(out.headCommits).toEqual([]);
    expect(out.publishedAt).toBeNull();
    expect(out.steeringVersion).toBe(0);
  });
});
