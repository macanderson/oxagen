import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
  system: vi.fn(),
}));
vi.mock("@oxagen/database", async (original) => {
  const actual = await original<typeof import("@oxagen/database")>();
  const tx = {
    query: { organizations: { findFirst: mocks.read } },
    update: mocks.update,
  };
  return {
    ...actual,
    withTenantDb: (fn: (value: unknown) => unknown) => fn(tx),
    withSystemDb: (fn: (value: unknown) => unknown) => {
      mocks.system();
      return fn(tx);
    },
  };
});
import {
  assertRunOutcomesAllowed,
  parseRunOutcomesPolicy,
  readRunOutcomesPolicy,
  setRunOutcomesConsent,
  setRunOutcomesPlatformAccess,
} from "./run-outcomes-policy";

const scope = {
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.where });
  mocks.where.mockReturnValue({ returning: mocks.returning });
  mocks.returning.mockResolvedValue([
    {
      settings: {
        runOutcomes: { customerEnabled: true, platformDisabled: true },
      },
    },
  ]);
});

describe("run outcomes access", () => {
  it("defaults missing consent to off without coupling summary settings", () => {
    expect(parseRunOutcomesPolicy({ runSummaries: { enabled: true } })).toEqual(
      {
        customerEnabled: false,
        platformDisabled: false,
        platformDisabledReason: null,
        effectiveEnabled: false,
      },
    );
  });
  it.each([
    null,
    [],
    { runOutcomes: null },
    { runOutcomes: { customerEnabled: "true" } },
    { runOutcomes: { platformDisabled: 0 } },
  ])("refuses malformed policy %j", (settings) => {
    expect(() => parseRunOutcomesPolicy(settings)).toThrow(
      expect.objectContaining({ reason: "run_outcomes_policy_invalid" }),
    );
  });
  it("requires consent and gives platform suspension precedence", async () => {
    mocks.read.mockResolvedValueOnce({ settings: {} }).mockResolvedValueOnce({
      settings: {
        runOutcomes: { customerEnabled: false, platformDisabled: true },
      },
    });
    await expect(assertRunOutcomesAllowed(scope)).rejects.toMatchObject({
      reason: "run_outcomes_not_enabled",
    });
    await expect(assertRunOutcomesAllowed(scope)).rejects.toMatchObject({
      reason: "run_outcomes_platform_disabled",
    });
  });
  it("reads again at each effect boundary and refuses a new suspension", async () => {
    mocks.read
      .mockResolvedValueOnce({
        settings: { runOutcomes: { customerEnabled: true } },
      })
      .mockResolvedValueOnce({
        settings: {
          runOutcomes: { customerEnabled: true, platformDisabled: true },
        },
      });
    await expect(assertRunOutcomesAllowed(scope)).resolves.toBeUndefined();
    await expect(assertRunOutcomesAllowed(scope)).rejects.toMatchObject({
      reason: "run_outcomes_platform_disabled",
    });
    expect(mocks.read).toHaveBeenCalledTimes(2);
    const query = new PgDialect().sqlToQuery(
      mocks.read.mock.calls[0]![0].where,
    );
    expect(query.params).toEqual([scope.orgId]);
  });
  it("does not turn a missing organization into default consent", async () => {
    mocks.read.mockResolvedValue(undefined);
    await expect(readRunOutcomesPolicy(scope)).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("merges only customer fields and preserves platform fields and other settings", async () => {
    const policy = await setRunOutcomesConsent(scope, true, "user-1");
    const update = mocks.set.mock.calls[0]![0];
    expect(Object.keys(update).sort()).toEqual(["settings", "updatedAt"]);
    const query = new PgDialect().sqlToQuery(update.settings);
    expect(query.sql).toContain("jsonb_build_object");
    expect(query.sql).toContain("\"settings\" -> 'runOutcomes'");
    expect(query.sql.match(/\|\|/g)).toHaveLength(2);
    const patch = JSON.parse(query.params[0] as string);
    expect(Object.keys(patch).sort()).toEqual([
      "customerEnabled",
      "customerUpdatedAt",
      "customerUpdatedBy",
    ]);
    expect(patch.customerEnabled).toBe(true);
    expect(policy.effectiveEnabled).toBe(false);
    expect(mocks.system).not.toHaveBeenCalled();
    expect(
      new PgDialect().sqlToQuery(mocks.where.mock.calls[0]![0]).params,
    ).toEqual([scope.orgId]);
  });
  it("platform restoration cannot opt a customer in", async () => {
    mocks.returning.mockResolvedValue([
      {
        settings: {
          runOutcomes: { customerEnabled: false, platformDisabled: false },
        },
      },
    ]);
    const policy = await setRunOutcomesPlatformAccess({
      orgId: scope.orgId,
      disabled: false,
      reason: "Review complete",
      requestId: "request-1",
    });
    const query = new PgDialect().sqlToQuery(
      mocks.set.mock.calls[0]![0].settings,
    );
    const patch = JSON.parse(query.params[0] as string);
    expect(patch).not.toHaveProperty("customerEnabled");
    expect(patch).toMatchObject({
      platformDisabled: false,
      platformDisabledReason: null,
      platformChangeReason: "Review complete",
      platformRequestId: "request-1",
    });
    expect(policy.effectiveEnabled).toBe(false);
    expect(mocks.system).toHaveBeenCalledOnce();
  });
});
