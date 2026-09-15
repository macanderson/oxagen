// The organization port: one kernel read of list_members at org scope for the
// Organization page, mapped into the People view model, with a refusal passed
// through and an unmappable answer reported once.
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { org } = await import("./org");

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
});

const member = {
  id: "usr_7k2m9q4x8r1t5v3w6y0z2a",
  name: "Marcus Bell",
  email: "marcus.bell@acme.example",
  role: "Owner",
  joinedAt: "2026-03-02T09:15:00.000Z",
};
const invitation = {
  id: "invi_4n5p6q7r8s9t0v1w2x3y4z",
  email: "dana.reyes@acme.example",
  role: "Admin",
  invitedAt: "2026-09-10T12:00:00.000Z",
  expiresAt: null,
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("org.members", () => {
  it("reads list_members at org scope for the organization page and returns the People view model", async () => {
    kernelRead.mockResolvedValue(
      readOk({ scope: "org", members: [member], invitations: [invitation] }),
    );
    expect(await org.members(ctx)).toEqual(
      readOk({
        members: [{ ...member, role: "owner" }],
        invitations: [{ ...invitation, role: "admin" }],
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: listMembers,
      input: { scope: "org" },
      page: "organization",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes a denied read through (negative)", async () => {
    const denied = { ok: false, reason: "denied", permission: "org.admin" };
    kernelRead.mockResolvedValue(denied);
    expect(await org.members(ctx)).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes a failed read through (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await org.members(ctx)).toEqual(down);
  });

  it("answers record_unmappable and reports once for a row the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        scope: "org",
        members: [{ ...member, role: "superuser" }],
        invitations: [],
      }),
    );
    expect(await org.members(ctx)).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledOnce();
  });

  it("answers record_unmappable and reports once when the kernel answers at workspace scope (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ scope: "workspace", members: [member] }),
    );
    expect(await org.members(ctx)).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledOnce();
  });
});
