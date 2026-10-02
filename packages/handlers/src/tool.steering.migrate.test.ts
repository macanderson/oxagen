import { HandlerError } from "@oxagen/oxagen";
import { toolSteeringMigrate } from "@oxagen/oxagen/contracts/tool.steering.migrate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  role: vi.fn(async () => "Owner"),
  run: vi.fn(),
  deps: { marker: "production deps" },
}));

vi.mock("./lib/capability-role-guard", () => ({
  assertContractRole: mocks.role,
}));
vi.mock("./mcp-studio/migration-run", () => ({ runToolMigration: mocks.run }));
vi.mock("./mcp-studio/migration-deps", () => ({ toolMigrationDeps: () => mocks.deps }));

import { migrateToolsToSteeringHandler } from "./tool.steering.migrate";
import { makeCTX, TEST_CTX } from "./test-utils/fixtures";

const PR = { number: 12, url: "https://github.com/acme/oxagen-support/pull/12" };
const OPENED = { state: "opened", pullRequest: PR, pullRequests: [PR] };

const run = (ctx = TEST_CTX) =>
  migrateToolsToSteeringHandler(toolSteeringMigrate.input.parse({}), ctx);

beforeEach(() => {
  mocks.role.mockReset();
  mocks.role.mockImplementation(async () => "Owner");
  mocks.run.mockReset();
  mocks.run.mockResolvedValue(OPENED);
});

describe("migrate_tools_to_steering handler", () => {
  it("checks the contract's roles, then runs the migration for the scope's workspace", async () => {
    await expect(run()).resolves.toEqual(OPENED);
    expect(mocks.role).toHaveBeenCalledWith(toolSteeringMigrate, TEST_CTX);
    expect(mocks.run).toHaveBeenCalledWith(
      { orgId: "org_1", workspaceId: "ws_1" },
      { actorUserId: "u_1" },
      mocks.deps,
    );
    expect(mocks.role.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.run.mock.invocationCallOrder[0] as number,
    );
  });

  it("answers the run's state", async () => {
    const open = { state: "already_open", pullRequest: PR, pullRequests: [PR] };
    mocks.run.mockResolvedValue(open);
    await expect(run()).resolves.toEqual(open);

    const migrated = { state: "already_migrated", pullRequest: null, pullRequests: [] };
    mocks.run.mockResolvedValue(migrated);
    await expect(run()).resolves.toEqual(migrated);
  });

  it("refuses a caller below org Owner or Admin and runs nothing", async () => {
    mocks.role.mockImplementation(async () => {
      throw new HandlerError({
        code: "forbidden",
        reason: "role_required",
        message: "Only an organization owner or admin can move the workspace's tool servers.",
      });
    });
    await expect(run()).rejects.toMatchObject({ code: "forbidden" });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("passes the run's refusal through", async () => {
    mocks.run.mockRejectedValue(
      new HandlerError({
        code: "not_found",
        reason: "steering_repo_not_ready",
        message: "This workspace has no steering repo yet.",
      }),
    );
    await expect(run()).rejects.toMatchObject({
      code: "not_found",
      reason: "steering_repo_not_ready",
    });
  });

  it("passes a call with no person as a null actor", async () => {
    await run(makeCTX({ userId: null }));
    expect(mocks.run).toHaveBeenCalledWith(expect.anything(), { actorUserId: null }, mocks.deps);
  });

  it("refuses a call without a workspace", async () => {
    // "" is what the kernel's unscoped path carries.
    await expect(run(makeCTX({ workspaceId: "" }))).rejects.toThrow("workspaceId is required");
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
