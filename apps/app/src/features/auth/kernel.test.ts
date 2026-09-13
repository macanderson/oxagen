import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const runInTenantScope = vi.fn((_scope: unknown, fn: () => unknown) => fn());

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/oxagen", () => ({ invoke }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope }));

const { FixtureWriteRefused, ORG_ONLY_WORKSPACE, invokeAsUser } = await import(
  "./kernel"
);

const contract = {
  name: "accept_member_invite",
  output: {
    parse(value: unknown) {
      const v = value as { orgId?: unknown };
      if (typeof v.orgId !== "string")
        throw new Error("output does not match the contract");
      return { orgId: v.orgId };
    },
  },
};
const scope = {
  orgId: "0192f1c4-0000-7000-8000-000000000001",
  workspaceId: ORG_ONLY_WORKSPACE,
};

beforeEach(() => {
  invoke.mockReset();
  runInTenantScope.mockClear();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("MC_DATA", "live");
});

describe("invokeAsUser", () => {
  it("invokes the tool inside the tenant scope as the app surface and parses the output", async () => {
    invoke.mockResolvedValue({ orgId: scope.orgId, extra: true });
    await expect(
      invokeAsUser(contract, { invitationPublicId: "invi_1" }, scope, "user-1"),
    ).resolves.toEqual({
      orgId: scope.orgId,
    });
    expect(runInTenantScope).toHaveBeenCalledWith(scope, expect.any(Function));
    expect(invoke).toHaveBeenCalledWith(
      "accept_member_invite",
      { invitationPublicId: "invi_1" },
      expect.objectContaining({
        orgId: scope.orgId,
        workspaceId: ORG_ONLY_WORKSPACE,
        userId: "user-1",
        surface: "app",
      }),
    );
  });

  it("rejects a handler reply that does not match the contract's output", async () => {
    invoke.mockResolvedValue({ orgId: 42 });
    await expect(invokeAsUser(contract, {}, scope, "user-1")).rejects.toThrow(
      "does not match the contract",
    );
  });

  it("refuses every write in fixture mode, before reaching the kernel", async () => {
    vi.stubEnv("MC_DATA", "fixture");
    await expect(
      invokeAsUser(contract, {}, scope, "user-1"),
    ).rejects.toBeInstanceOf(FixtureWriteRefused);
    expect(invoke).not.toHaveBeenCalled();
  });
});
