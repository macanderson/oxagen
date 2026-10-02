import { HandlerError } from "@oxagen/oxagen";
import { steeringRepoImport } from "@oxagen/oxagen/contracts/steering_repo.import";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(async (_contract: unknown, _ctx: unknown) => "Owner"),
  actor: vi.fn(async (_ctx: unknown): Promise<string | null> => "u_1"),
  orgRole: vi.fn(async (_ctx: unknown, _required: unknown): Promise<string> => "Owner"),
  run: vi.fn(
    async (_scope: unknown, _input: unknown, _deps: unknown): Promise<unknown> => ({
      outcome: "imported",
    }),
  ),
  deps: vi.fn((options: unknown) => ({ deps: options })),
  pick: vi.fn(async (_scope: unknown, _pick: unknown): Promise<void> => {}),
  reset: vi.fn(async (_orgId: unknown): Promise<void> => {}),
}));

vi.mock("./lib/capability-role-guard", () => ({
  assertContractRole: mocks.role,
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: mocks.actor,
  assertOrgRole: mocks.orgRole,
}));
vi.mock("./steering-repo/import-run", () => ({
  runSteeringImport: mocks.run,
}));
vi.mock("./steering-repo/import-deps", () => ({
  steeringImportDeps: mocks.deps,
}));
vi.mock("./steering-repo/connection-pick", () => ({
  applyWorkspaceConnectionPick: mocks.pick,
  resetOrganizationConnection: mocks.reset,
}));

import { importWorkspaceSteeringHandler } from "./steering_repo.import";
import { makeCTX, TEST_CTX } from "./test-utils/fixtures";

const run = (input: unknown = {}, ctx = TEST_CTX) =>
  importWorkspaceSteeringHandler(steeringRepoImport.input.parse(input), ctx);

beforeEach(() => {
  mocks.role.mockReset();
  mocks.role.mockImplementation(async () => "Owner");
  mocks.actor.mockReset();
  mocks.actor.mockResolvedValue("u_1");
  mocks.run.mockReset();
  mocks.run.mockResolvedValue({ outcome: "imported" });
  mocks.pick.mockReset();
  mocks.pick.mockResolvedValue(undefined);
  mocks.reset.mockReset();
  mocks.reset.mockResolvedValue(undefined);
  mocks.orgRole.mockReset();
  mocks.orgRole.mockResolvedValue("Owner");
});

describe("import_workspace_steering handler", () => {
  it("checks the contract's roles, then runs the import for the workspace", async () => {
    await expect(run()).resolves.toEqual({ outcome: "imported" });
    expect(mocks.role).toHaveBeenCalledWith(steeringRepoImport, TEST_CTX);
    expect(mocks.deps).toHaveBeenCalledWith({ actorUserId: "u_1" });
    expect(mocks.run).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      {},
      { deps: { actorUserId: "u_1" } },
    );
    expect(mocks.role.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.run.mock.invocationCallOrder[0] as number,
    );
  });

  it("stores a picked connection before the run, and none without one", async () => {
    await run({ connection: { provider: "github", id: 11 } });
    expect(mocks.pick).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      { provider: "github", id: 11 },
    );
    expect(mocks.run).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      {},
      { deps: { actorUserId: "u_1" } },
    );
    expect(mocks.pick.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.run.mock.invocationCallOrder[0] as number,
    );
    mocks.pick.mockClear();
    await run();
    expect(mocks.pick).not.toHaveBeenCalled();
  });

  it("clears the stored connection before the run when asked", async () => {
    await run({ resetConnection: true });
    expect(mocks.reset).toHaveBeenCalledWith("org_1");
    expect(mocks.reset.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.run.mock.invocationCallOrder[0] as number,
    );
    expect(mocks.pick).not.toHaveBeenCalled();
  });

  it("lets only an org Owner or Admin clear the organization's connection", async () => {
    mocks.orgRole.mockRejectedValue(
      new HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    await expect(run({ resetConnection: true })).rejects.toMatchObject({
      reason: "org_role_required",
    });
    expect(mocks.orgRole).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", userId: "u_1" }),
      { org: ["Owner", "Admin"], namedRolesOnly: true },
    );
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    mocks.orgRole.mockClear();
    await run();
    expect(mocks.orgRole).not.toHaveBeenCalled();
  });

  it("lets only an org Owner or Admin pick the organization's connection (#5228)", async () => {
    // A pick stores the org's connection when it has none. A workspace Owner
    // or Admin who holds no org role is refused it, and nothing is stored.
    mocks.orgRole.mockRejectedValue(
      new HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    await expect(
      run({ connection: { provider: "github", id: 11 } }),
    ).rejects.toMatchObject({ reason: "org_role_required" });
    expect(mocks.orgRole).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", userId: "u_1" }),
      { org: ["Owner", "Admin"], namedRolesOnly: true },
    );
    expect(mocks.pick).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("runs nothing when the picked connection is refused", async () => {
    mocks.pick.mockRejectedValue(
      new HandlerError({ code: "conflict", reason: "unknown_connection" }),
    );
    await expect(
      run({ connection: { provider: "github", id: 99 } }),
    ).rejects.toMatchObject({ reason: "unknown_connection" });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("passes the rule kinds and constraint effects the caller chose", async () => {
    const choices = {
      ruleKinds: { "ctx.a-intel.refunds-over-100": "business-rule" },
      constraintEffects: { "ctx.a-intel.no-force-push": "forbid" },
    };
    await run(choices);
    expect(mocks.run).toHaveBeenCalledWith(
      expect.anything(),
      choices,
      expect.anything(),
    );
  });

  it("passes startFresh when the caller sets it", async () => {
    await run({ startFresh: true });
    expect(mocks.run).toHaveBeenCalledWith(
      expect.anything(),
      { startFresh: true },
      expect.anything(),
    );
  });

  it("refuses a caller without the contract's roles and runs nothing", async () => {
    mocks.role.mockImplementation(async () => {
      throw new HandlerError({
        code: "forbidden",
        reason: "role_required",
        message: "Only a workspace owner can import steering.",
      });
    });
    await expect(run()).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("refuses a call without a workspace", async () => {
    await expect(run({}, makeCTX({ workspaceId: "" }))).rejects.toThrow(
      "workspaceId is required",
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("refuses a call with no person behind it", async () => {
    mocks.actor.mockResolvedValue(null);
    await expect(run()).rejects.toMatchObject({
      code: "forbidden",
      reason: "no_principal",
    });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("passes the run's refusal through", async () => {
    mocks.run.mockRejectedValue(
      new HandlerError({
        code: "conflict",
        reason: "steering_import_running",
        message: "Another import of this workspace is running.",
      }),
    );
    await expect(run()).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_import_running",
    });
  });
});
