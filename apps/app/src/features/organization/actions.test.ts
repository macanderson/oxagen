// The two People writes through the real kernel seam (INV-19): the viewer
// resolution and the kernel's invoke() are the only fakes, so each case shows
// what the person gets back and whether the capability ran. Every refusal is
// classified by the code the handler threw, never by its message (§3.2).
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { changeMemberRole, removeOrgMember } = await import("./actions");

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

/** The member id the roster prints, and the only id the page holds (INV-11). */
const MEMBER = "usr_7k2m9q4x8r1t5v3w6y0z2a";
/** The CapabilityContext an organization-level write reaches the kernel with. */
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: "00000000-0000-0000-0000-000000000000",
  surface: "app",
};

const refusal = (
  code: "forbidden" | "not_found" | "conflict",
  reason: string,
) => new kernel.HandlerError({ code, reason, message: `${code}: ${reason}` });

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset().mockResolvedValue(ctx);
});

describe("changeMemberRole", () => {
  it("grants the role the picker named, under the IAM name the contract takes", async () => {
    invoke.mockResolvedValue({
      changed: true,
      targetUserId: MEMBER,
      orgId: ctx.orgId,
      previousRole: "member",
      newRole: "Admin",
    });
    expect(await changeMemberRole("acme", MEMBER, "admin")).toEqual({
      ok: true,
      value: { role: "admin" },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme");
    expect(invoke).toHaveBeenCalledWith(
      "change_member_role",
      { targetUserId: MEMBER, newRole: "Admin" },
      expect.objectContaining(TENANT),
    );
  });

  it.each(["member", "viewer", "", "Owner"])(
    "refuses %o, a role this organization does not grant, before the kernel runs (negative)",
    async (role) => {
      expect(await changeMemberRole("acme", MEMBER, role)).toEqual({
        ok: false,
        reason: "invalid",
        code: "role_not_grantable",
        field: "role",
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("refuses an empty member id before the kernel runs (negative)", async () => {
    expect(await changeMemberRole("acme", "", "admin")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "targetUserId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a role the actor may not change as denied (negative)", async () => {
    invoke.mockRejectedValue(refusal("forbidden", "insufficient_role"));
    expect(await changeMemberRole("acme", MEMBER, "admin")).toEqual({
      ok: false,
      reason: "denied",
      code: "insufficient_role",
    });
  });

  it.each([
    ["a member of another organization", "target_not_member"],
    ["a role this organization never seeded", "role_not_found"],
  ])("returns %s as not_found (negative)", async (_what, reason) => {
    invoke.mockRejectedValue(refusal("not_found", reason));
    expect(await changeMemberRole("acme", MEMBER, "admin")).toEqual({
      ok: false,
      reason: "not_found",
      code: reason,
    });
  });

  it("returns the last owner's demotion as conflict (negative)", async () => {
    invoke.mockRejectedValue(refusal("conflict", "last_owner"));
    expect(await changeMemberRole("acme", MEMBER, "billing")).toEqual({
      ok: false,
      reason: "conflict",
      code: "last_owner",
    });
  });

  it("reports output the contract does not admit as unavailable (negative)", async () => {
    invoke.mockResolvedValue({ changed: true });
    expect(await changeMemberRole("acme", MEMBER, "admin")).toEqual({
      ok: false,
      reason: "unavailable",
      code: "contract_output_mismatch",
    });
  });
});

describe("removeOrgMember", () => {
  it("removes the member the roster named", async () => {
    invoke.mockResolvedValue({
      removed: true,
      targetUserId: MEMBER,
      orgId: ctx.orgId,
    });
    expect(await removeOrgMember("acme", MEMBER)).toEqual({
      ok: true,
      value: { memberId: MEMBER },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme");
    expect(invoke).toHaveBeenCalledWith(
      "remove_org_member",
      { targetUserId: MEMBER },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses an empty member id before the kernel runs (negative)", async () => {
    expect(await removeOrgMember("acme", "")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "targetUserId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns a member who may not remove people as denied (negative)", async () => {
    invoke.mockRejectedValue(refusal("forbidden", "insufficient_role"));
    expect(await removeOrgMember("acme", MEMBER)).toEqual({
      ok: false,
      reason: "denied",
      code: "insufficient_role",
    });
  });

  it("returns a target outside this organization as not_found (negative)", async () => {
    invoke.mockRejectedValue(refusal("not_found", "target_not_member"));
    expect(await removeOrgMember("acme", MEMBER)).toEqual({
      ok: false,
      reason: "not_found",
      code: "target_not_member",
    });
  });

  it("returns the last owner's removal as conflict (negative)", async () => {
    invoke.mockRejectedValue(refusal("conflict", "last_owner"));
    expect(await removeOrgMember("acme", MEMBER)).toEqual({
      ok: false,
      reason: "conflict",
      code: "last_owner",
    });
  });
});

describe("a person the organization refuses", () => {
  it.each([
    ["changeMemberRole", () => changeMemberRole("acme", MEMBER, "admin")],
    ["removeOrgMember", () => removeOrgMember("acme", MEMBER)],
  ])("%s runs nothing (negative)", async (_name, run) => {
    requireViewer.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(invoke).not.toHaveBeenCalled();
  });
});
