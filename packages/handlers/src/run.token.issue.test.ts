import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCTX } from "./test-utils/fixtures";
const mocks = vi.hoisted(() => ({
  tenant: vi.fn(),
  lock: vi.fn(),
  role: vi.fn(),
  actor: vi.fn(),
  attempt: vi.fn(),
  seal: vi.fn(),
  insert: vi.fn(),
  orgRoles: vi.fn(),
  /** `agent_runs` principal columns for the locked run. */
  runPrincipals: vi.fn(),
  /** The caller's active `iam.principals` rows in the org. */
  ownPrincipals: vi.fn(),
}));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.tenant,
  withOrgDb: mocks.tenant,
}));
vi.mock("@oxagen/run-ledger", async (original) => ({
  ...(await original<typeof import("@oxagen/run-ledger")>()),
  lockRunForControl: mocks.lock,
}));
vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.role,
  resolveActingUserId: mocks.actor,
  resolveActorOrgRoles: mocks.orgRoles,
}));
import { schema } from "@oxagen/database";
import { runTokenIssueHandler } from "./run.token.issue";
import { clearDataPlaneResolver, setDataPlaneResolver } from "@oxagen/tenancy";
import { afterEach } from "vitest";
import { createHash } from "node:crypto";
const ctx = makeCTX();
const input = { runId: "arun_record1", attemptId: "arat_attempt1" };
const tx = {
  query: {
    agentRunAttempts: { findFirst: mocks.attempt },
    agentRunAttemptSeals: { findFirst: mocks.seal },
  },
  select: () => ({
    from: (table: unknown) => ({
      where: () =>
        table === schema.agentRuns
          ? mocks.runPrincipals()
          : mocks.ownPrincipals(),
    }),
  }),
  insert: () => ({ values: mocks.insert }),
};
const INITIATOR = "00000000-0000-4000-8000-00000000c0de";
const AGENT = "00000000-0000-4000-8000-0000000000a6";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue(ctx.userId);
  mocks.role.mockResolvedValue(undefined);
  mocks.tenant.mockImplementation((fn) => fn(tx));
  mocks.lock.mockResolvedValue({
    id: "run-uuid",
    status: "running",
    cancelled: false,
  });
  mocks.attempt.mockResolvedValue({ id: "attempt-uuid" });
  mocks.seal.mockResolvedValue(undefined);
  mocks.insert.mockResolvedValue(undefined);
  // A V1 row: no principal on the run, so the role gate is the boundary.
  mocks.runPrincipals.mockResolvedValue([{ initiating: null, agent: null }]);
  mocks.ownPrincipals.mockResolvedValue([{ id: "caller-principal" }]);
  mocks.orgRoles.mockResolvedValue([]);
});
afterEach(clearDataPlaneResolver);
describe("run credential issuance", () => {
  it("refuses a machine key even when its creator is an operator", async () => {
    await expect(
      runTokenIssueHandler(input, { ...ctx, apiKeyId: "key_operator" }),
    ).rejects.toMatchObject({ reason: "operator_session_required" });
    expect(mocks.actor).not.toHaveBeenCalled();
    expect(mocks.tenant).not.toHaveBeenCalled();
  });
  it("refuses a dedicated plane before minting an unusable credential", async () => {
    setDataPlaneResolver(async (orgId, kind) => ({
      orgId,
      kind,
      mode: "dedicated",
      status: "active",
      configDigest: null,
      schemaVersion: null,
    }));
    await expect(runTokenIssueHandler(input, ctx)).rejects.toMatchObject({
      reason: "run_token_dedicated_plane_unsupported",
    });
    expect(mocks.tenant).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("stores only the hash with server-derived run and attempt scope", async () => {
    const before = Date.now();
    const result = await runTokenIssueHandler(input, ctx);
    expect(mocks.lock).toHaveBeenCalledWith(
      tx,
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      input.runId,
    );
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        keyHash: createHash("sha256").update(result.token).digest("hex"),
        scope: {
          purpose: "ledger_run_v1",
          run_id: "run-uuid",
          attempt_id: "attempt-uuid",
        },
      }),
    );
    expect(JSON.stringify(mocks.insert.mock.calls)).not.toContain(result.token);
    expect(Date.parse(result.expiresAt)).toBeGreaterThanOrEqual(
      before + 15 * 60_000,
    );
    expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(
      Date.now() + 15 * 60_000,
    );
  });
  it.each(["cancelled", "completed"])(
    "does not issue after %s",
    async (state) => {
      mocks.lock.mockResolvedValue({
        id: "run-uuid",
        status: state === "completed" ? state : "running",
        cancelled: state === "cancelled",
      });
      await expect(runTokenIssueHandler(input, ctx)).rejects.toMatchObject({
        reason: "run_not_writable",
      });
      expect(mocks.insert).not.toHaveBeenCalled();
    },
  );
  it("refuses a sealed attempt", async () => {
    mocks.seal.mockResolvedValue({ id: "seal" });
    await expect(runTokenIssueHandler(input, ctx)).rejects.toMatchObject({
      reason: "attempt_sealed",
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("refuses an attempt outside the requested run", async () => {
    mocks.attempt.mockResolvedValue(undefined);
    await expect(runTokenIssueHandler(input, ctx)).rejects.toMatchObject({
      reason: "attempt_not_found",
    });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("refuses a non-operator before database reads", async () => {
    mocks.actor.mockResolvedValue(null);
    await expect(runTokenIssueHandler(input, ctx)).rejects.toMatchObject({
      reason: "operator_required",
    });
    expect(mocks.tenant).not.toHaveBeenCalled();
  });
  it("honors a role refusal before database reads", async () => {
    mocks.role.mockRejectedValue(new Error("Viewer"));
    await expect(runTokenIssueHandler(input, ctx)).rejects.toThrow("Viewer");
    expect(mocks.tenant).not.toHaveBeenCalled();
  });
});

describe("run credential issuance — the run's principals", () => {
  it("keeps the role gate as the whole boundary for a run with no principal", async () => {
    await runTokenIssueHandler(input, ctx);
    expect(mocks.ownPrincipals).not.toHaveBeenCalled();
    expect(mocks.orgRoles).not.toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });
  it("issues to the initiating principal", async () => {
    mocks.runPrincipals.mockResolvedValue([
      { initiating: INITIATOR, agent: AGENT },
    ]);
    mocks.ownPrincipals.mockResolvedValue([{ id: INITIATOR }]);
    await runTokenIssueHandler(input, ctx);
    expect(mocks.orgRoles).not.toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });
  it("issues to the run's agent principal", async () => {
    mocks.runPrincipals.mockResolvedValue([
      { initiating: INITIATOR, agent: AGENT },
    ]);
    mocks.ownPrincipals.mockResolvedValue([{ id: AGENT }]);
    await runTokenIssueHandler(input, ctx);
    expect(mocks.orgRoles).not.toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });
  it("issues to an org Owner or Admin who is neither, read through the same transaction", async () => {
    mocks.runPrincipals.mockResolvedValue([
      { initiating: INITIATOR, agent: null },
    ]);
    mocks.orgRoles.mockResolvedValue(["Admin"]);
    await runTokenIssueHandler(input, ctx);
    expect(mocks.orgRoles).toHaveBeenCalledWith(ctx.orgId, ctx.userId, tx);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });
  it("refuses a workspace Member with no part in the run before reading the attempt", async () => {
    mocks.runPrincipals.mockResolvedValue([
      { initiating: INITIATOR, agent: AGENT },
    ]);
    mocks.orgRoles.mockResolvedValue(["Billing"]);
    await expect(runTokenIssueHandler(input, ctx)).rejects.toMatchObject({
      code: "forbidden",
      reason: "not_run_principal",
    });
    expect(mocks.attempt).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
