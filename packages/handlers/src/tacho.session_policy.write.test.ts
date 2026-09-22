/**
 * Setting the workspace's wrapped-session policy.
 *
 * Four behaviours are load-bearing, and each is asserted rather than left to
 * reading the merge:
 *
 *   1. An omitted field does not change, and `null` is a value rather than an
 *      omission. `modelAllow: null` drops the allowlist; leaving it out keeps
 *      whatever was there.
 *   2. `enforced` with nothing to enforce is refused, with a message that says
 *      what to set. The database rejects it too, and a constraint name is not
 *      an explanation.
 *   3. The reach is reported. `models` rides a gated bundle field, so a saved
 *      allowlist can govern no machine, and a surface that showed only the
 *      saved value would report that as success.
 *   4. A revoked host is not counted. It receives no bundle.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  readPolicy: vi.fn(),
  insertValues: vi.fn(),
  updateSet: vi.fn(),
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
    const out = await run({ mode: "enforced", sessionLimitUsd: 25 }, stub);
    expect(out).toMatchObject({
      mode: "enforced",
      sessionLimitUsd: 25,
      modelAllow: null,
      modelDeny: [],
    });
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "enforced", sessionLimitUsd: 25 }),
    );
  });

  it("changes only what it was given, and reads null as a value", async () => {
    mocks.readPolicy.mockResolvedValue({
      mode: "enforced",
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

  it("refuses enforced with nothing to enforce, and says what to set", async () => {
    const stub = tx({});
    await expect(run({ mode: "enforced" }, stub)).rejects.toThrow(
      /set a session limit, an allowed-model list, or a denied-model list/,
    );
    // Nothing was written: the refusal is before the upsert, so a policy that
    // says it enforces and does not never reaches a bundle.
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });

  it("accepts enforced with an allowlist that permits nothing", async () => {
    // The negative control for the rule above. `[]` is a decision — refuse
    // every model — and must not be mistaken for an absent clause.
    const out = await run({ mode: "enforced", modelAllow: [] }, tx({}));
    expect(out.mode).toBe("enforced");
    expect(out.modelAllow).toEqual([]);
  });

  it("counts only the live hosts that can parse the model lists", async () => {
    const out = await run(
      { mode: "enforced", modelDeny: ["gpt-4o"] },
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
});
