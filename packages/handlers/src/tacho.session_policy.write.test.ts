/**
 * Setting the workspace's wrapped-session policy.
 *
 * Four behaviours are load-bearing, and each is asserted rather than left to
 * reading the merge:
 *
 *   1. An omitted field does not change, and `null` is a value rather than an
 *      omission. `modelAllow: null` drops the allowlist; leaving it out keeps
 *      whatever was there.
 *   2. `enforced` is refused outright, with a message that says why. Nothing
 *      reads this policy yet, so accepting the word would put a claim in the
 *      record that no enforcer answers for.
 *   3. The reach is reported. `models` rides a gated bundle field, so a saved
 *      allowlist can govern no machine, and a surface that showed only the
 *      saved value would report that as success.
 *   4. A revoked host is not counted. It receives no bundle.
 *   5. The org role is asserted in the handler, before anything is read or
 *      written. The kernel fast-paths a non-enterprise principal, so this call
 *      is the only thing standing between a workspace Member and disarming the
 *      gateway.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  readPolicy: vi.fn(),
  insertValues: vi.fn(),
  updateSet: vi.fn(),
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("./lib/tacho-session-policy", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("./lib/tacho-session-policy")>();
  return { ...real, readTachoSessionPolicyIn: mocks.readPolicy };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// The real gate reads org and workspace membership from Postgres. What matters
// here is that the handler calls it, with the roles the contract declares, and
// that a refusal stops the write.
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: mocks.resolveActingUserId,
  assertOrgRole: mocks.assertOrgRole,
}));

import { tachoSessionPolicyWriteHandler } from "./tacho.session_policy.write";
import { OBSERVED_ONLY } from "./lib/tacho-session-policy";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

/** The one transaction the handler opens, answering every call it makes. */
function tx({
  existing,
  hosts = [],
}: {
  existing?: { id: string };
  hosts?: { bundleFeatures: string[] | null }[];
}) {
  return {
    query: {
      tachoSessionPolicy: { findFirst: vi.fn().mockResolvedValue(existing) },
      tachoHosts: { findMany: vi.fn().mockResolvedValue(hosts) },
    },
    insert: vi.fn().mockReturnValue({
      values: mocks.insertValues.mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: mocks.updateSet.mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readPolicy.mockResolvedValue(OBSERVED_ONLY);
  mocks.assertOrgRole.mockResolvedValue(undefined);
  mocks.resolveActingUserId.mockResolvedValue(TEST_CTX.userId);
});

/** Run the handler against one transaction stub. */
async function run(
  input: Parameters<typeof tachoSessionPolicyWriteHandler>[0],
  stub: ReturnType<typeof tx>,
) {
  mocks.withTenantDb.mockImplementation(async (fn: (t: unknown) => unknown) =>
    fn(stub),
  );
  return tachoSessionPolicyWriteHandler(input, TEST_CTX);
}

describe("update_tacho_session_policy", () => {
  it("inserts the merged policy when the workspace has none", async () => {
    const stub = tx({});
    const out = await run({ mode: "observed", sessionLimitUsd: 25 }, stub);
    expect(out).toMatchObject({
      mode: "observed",
      sessionLimitUsd: 25,
      modelAllow: null,
      modelDeny: [],
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "observed", sessionLimitUsd: 25 }),
    );
  });

  it("changes only what it was given, and reads null as a value", async () => {
    mocks.readPolicy.mockResolvedValue({
      mode: "observed",
      sessionLimitUsd: 25,
      modelAllow: ["claude-opus-*"],
      modelDeny: ["gpt-4o"],
    });
    // Omitted: keeps the allowlist. The deny list is the only field sent.
    const kept = await run({ modelDeny: [] }, tx({ existing: { id: "p1" } }));
    expect(kept.modelAllow).toEqual(["claude-opus-*"]);
    expect(kept.modelDeny).toEqual([]);
    // Explicit null: drops the allowlist, so every model is permitted again.
    const dropped = await run(
      { modelAllow: null },
      tx({ existing: { id: "p1" } }),
    );
    expect(dropped.modelAllow).toBeNull();
    expect(dropped.modelDeny).toEqual(["gpt-4o"]);
  });

  it("refuses enforced outright, and says why rather than what to set", async () => {
    // No bundle carries a `models` clause and `budget.mode` comes from the
    // agent's mandate, so there is no enforcer to name. Even a policy with
    // every clause filled in is refused.
    const stub = tx({});
    await expect(
      run({ mode: "enforced", sessionLimitUsd: 25, modelDeny: ["*"] }, stub),
    ).rejects.toThrow(/Enforced is not available yet/);
    // Nothing was written: the refusal is before the upsert, so a policy that
    // says it enforces and does not never reaches the record.
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("accepts an allowlist that permits nothing, which is a decision", async () => {
    // `[]` is a decision — permit no model — and must not be mistaken for an
    // absent clause. Nothing reads it yet; the record keeps it apart from null.
    const out = await run({ mode: "observed", modelAllow: [] }, tx({}));
    expect(out.mode).toBe("observed");
    expect(out.modelAllow).toEqual([]);
  });

  it("counts only the live hosts that can parse the model lists", async () => {
    const out = await run(
      { mode: "observed", modelDeny: ["gpt-4o"] },
      tx({
        hosts: [
          { bundleFeatures: ["gateway_tools", "model_prices", "models"] },
          { bundleFeatures: ["gateway_tools"] },
          { bundleFeatures: null },
        ],
      }),
    );
    expect(out.reach).toEqual({ hosts: 3, hostsEnforcingModels: 1 });
  });

  it("refuses without a workspace before touching the database", async () => {
    await expect(
      tachoSessionPolicyWriteHandler(
        { mode: "observed" },
        makeCTX({ workspaceId: undefined }),
      ),
    ).rejects.toThrow(/workspace context/);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it("asserts the roles the contract declares, as the key's creator", async () => {
    await run({ mode: "observed", sessionLimitUsd: 25 }, tx({}));
    expect(mocks.resolveActingUserId).toHaveBeenCalledWith(TEST_CTX);
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: TEST_CTX.userId }),
      { org: ["Owner", "Admin"], workspace: ["Owner", "Admin"] },
    );
  });

  it("writes nothing when the role gate refuses (negative)", async () => {
    // The gate runs before the transaction, so a Member cannot set the mode to
    // observed, clear the ceiling, or null the allowlist. Disarming the
    // gateway is the write this capability must not take from a non-admin.
    mocks.assertOrgRole.mockRejectedValue(
      new Error("Requires one of the org roles Owner, Admin"),
    );
    await expect(
      run({ mode: "observed", modelAllow: null }, tx({ existing: { id: "p1" } })),
    ).rejects.toThrow(/Owner, Admin/);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

});
