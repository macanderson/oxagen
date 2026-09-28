import { HandlerError } from "@oxagen/oxagen";
import { steeringRepoRepair } from "@oxagen/oxagen/contracts/steering_repo.repair";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(async () => "Owner"),
  repair: vi.fn(),
}));

vi.mock("./lib/capability-role-guard", () => ({
  assertContractRole: mocks.role,
}));
vi.mock("./steering-repo/repair", () => ({ repair: mocks.repair }));

import { repairSteeringRepoHandler } from "./steering_repo.repair";
import { makeCTX, TEST_CTX } from "./test-utils/fixtures";

const run = (ctx = TEST_CTX) =>
  repairSteeringRepoHandler(steeringRepoRepair.input.parse({}), ctx);

beforeEach(() => {
  mocks.role.mockReset();
  mocks.role.mockImplementation(async () => "Owner");
  mocks.repair.mockReset();
  mocks.repair.mockResolvedValue({ health: "healthy" });
});

describe("repair_steering_repo handler", () => {
  it("checks the contract's roles, then repairs the workspace's steering repo", async () => {
    await expect(run()).resolves.toEqual({ health: "healthy" });
    expect(mocks.role).toHaveBeenCalledWith(steeringRepoRepair, TEST_CTX);
    expect(mocks.repair).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      { actorUserId: "u_1" },
    );
    expect(mocks.role.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.repair.mock.invocationCallOrder[0] as number,
    );
  });

  it("answers the health the repair's last read found", async () => {
    mocks.repair.mockResolvedValue({ health: "drifted" });
    await expect(run()).resolves.toEqual({ health: "drifted" });
  });

  it("refuses a caller below org Owner or Admin and writes nothing", async () => {
    mocks.role.mockImplementation(async () => {
      throw new HandlerError({
        code: "forbidden",
        reason: "role_required",
        message: "Only an organization owner or admin can repair the steering repo.",
      });
    });
    await expect(run()).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.repair).not.toHaveBeenCalled();
  });

  it("passes the repair's refusal through", async () => {
    mocks.repair.mockRejectedValue(
      new HandlerError({
        code: "conflict",
        reason: "steering_repo_disconnected",
        message: "Oxagen can no longer reach the steering repo acme/oxagen-platform.",
      }),
    );
    await expect(run()).rejects.toMatchObject({
      code: "conflict",
      reason: "steering_repo_disconnected",
    });
  });

  it("passes an action with no actor as a null actor", async () => {
    await run(makeCTX({ userId: null }));
    expect(mocks.repair).toHaveBeenCalledWith(expect.anything(), { actorUserId: null });
  });

  it("refuses a call without a workspace", async () => {
    // Empty string, not null: `CapabilityContext.workspaceId` is typed
    // non-nullable, and "" is what the kernel's unscoped path actually carries.
    await expect(run(makeCTX({ workspaceId: "" }))).rejects.toThrow(
      /workspaceId is required/,
    );
    expect(mocks.repair).not.toHaveBeenCalled();
  });
});
