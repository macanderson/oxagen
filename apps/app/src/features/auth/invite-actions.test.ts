// The invitation actions through the real viewer and kernel seams: the session,
// the invitation lookup and the kernel's invoke() are the only fakes, so each
// case shows what the invitee gets back and whether a write ran.
import { orgMemberInviteAccept } from "@oxagen/oxagen/contracts/org.member_invite.accept";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { requireInvitee } from "@/server/viewer";

const { invoke, captureError, getSession, invitationByToken, nav } = vi.hoisted(
  () => ({
    invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
    captureError: vi.fn(),
    getSession: vi.fn(),
    invitationByToken: vi.fn(),
    nav: {
      redirect: vi.fn((url: string) => {
        throw new Error(`NEXT_REDIRECT ${url}`);
      }),
      notFound: vi.fn(() => {
        throw new Error("NEXT_NOT_FOUND");
      }),
    },
  }),
);
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("next/navigation", () => nav);
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({
  systemLookups: { invitationByToken },
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { acceptInvitation, declineInvitation } = await import(
  "./invite-actions"
);

const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";
const record = {
  invitationId: "0192f1c4-0000-7000-8000-0000000000aa",
  orgId: "0192f1c4-0000-7000-8000-000000000001",
  orgName: "Acme Robotics",
  orgSlug: "acme",
  email: "priya@acme.example",
  role: "Admin",
  status: "pending",
  invitedAt: new Date("2026-09-11T09:00:00Z"),
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  inviterName: "Priya Natarajan",
  inviterRole: "Owner",
};
const refusal = (code: "forbidden" | "conflict", reason: string) =>
  new kernel.HandlerError({ code, reason });

beforeEach(() => {
  invoke.mockReset();
  captureError.mockReset();
  nav.redirect.mockClear();
  getSession.mockResolvedValue({
    user: { id: "u-priya", email: "priya@acme.example" },
  });
  invitationByToken.mockResolvedValue(record);
});

describe("acceptInvitation and declineInvitation", () => {
  it("send a signed-out visitor to log in, writing nothing (negative)", async () => {
    getSession.mockResolvedValue(null);
    await expect(acceptInvitation("invi_live")).rejects.toThrow(
      "NEXT_REDIRECT /login",
    );
    await expect(declineInvitation("invi_live")).rejects.toThrow(
      "NEXT_REDIRECT /login",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("treat an unknown token and an invitation for another address as not found, writing nothing (negative)", async () => {
    invitationByToken.mockResolvedValueOnce(null);
    await expect(acceptInvitation("invi_nope")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    invitationByToken.mockResolvedValueOnce({
      ...record,
      email: "someone.else@acme.example",
    });
    await expect(declineInvitation("invi_live")).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("return a kernel input refusal as invalid (negative)", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError(
        orgMemberInviteAccept.name,
        "invalid_input",
        "invalid",
      ),
    );
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
    });
  });

  it("return the handler's refusal of another account as denied (negative)", async () => {
    invoke.mockRejectedValue(refusal("forbidden", "wrong_email"));
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: false,
      reason: "denied",
      code: "wrong_email",
    });
  });

  it("return a closed invitation as the handler's conflict (negative)", async () => {
    invoke.mockRejectedValue(refusal("conflict", "invitation_expired"));
    expect(await declineInvitation("invi_live")).toEqual({
      ok: false,
      reason: "conflict",
      code: "invitation_expired",
    });
  });

  const accepted = {
    orgUserId: "ou_01",
    orgId: record.orgId,
    role: "Admin",
    joinedAt: "2026-09-15T00:00:00.000Z",
  };
  /** accept_member_invite answers `accepted`; list_workspaces answers `list` (or throws it). */
  const answer = (list: unknown) => {
    invoke.mockImplementation((name: string) => {
      if (name === "accept_member_invite") return Promise.resolve(accepted);
      if (list instanceof Error) return Promise.reject(list);
      return Promise.resolve(list);
    });
  };
  const org = {
    id: record.orgId,
    publicId: "org_acme",
    slug: "acme",
    namespace: "acme",
    name: record.orgName,
  };
  const ws = (slug: string, role: string | null) => ({
    id: `0192f1c4-0000-7000-8000-0000000000${slug.length}0`,
    publicId: `ws_${slug}`,
    slug,
    namespace: slug,
    name: slug,
    role,
    archivedAt: null,
    costCenter: null,
  });

  it("accept as the invitee in the invitation's organization and land on Fleet of the first workspace the person belongs to", async () => {
    answer({
      organization: org,
      workspaces: [ws("sandbox", null), ws("core-platform", "member")],
    });
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: true,
      value: { to: "/acme/core-platform" },
    });
    expect(invoke).toHaveBeenCalledWith(
      "accept_member_invite",
      { invitationPublicId: "invi_live" },
      expect.objectContaining({
        userId: "u-priya",
        orgId: record.orgId,
        workspaceId: ORG_ONLY_WS,
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "list_workspaces",
      { orgSlug: "acme" },
      expect.objectContaining({ userId: "u-priya" }),
    );
  });

  it("land on the organization's People page when the person belongs to none of its workspaces", async () => {
    answer({ organization: org, workspaces: [ws("core-platform", null)] });
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: true,
      value: { to: "/acme" },
    });
  });

  it("still report the acceptance, landing on People, when the workspace list cannot be read (negative)", async () => {
    answer(new Error("list_workspaces down"));
    expect(await acceptInvitation("invi_live")).toEqual({
      ok: true,
      value: { to: "/acme" },
    });
  });

  it("read no workspace list when the acceptance is refused (negative)", async () => {
    invoke.mockRejectedValue(refusal("conflict", "invitation_expired"));
    await acceptInvitation("invi_live");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("decline as the invitee", async () => {
    const declined = { invitationPublicId: "invi_live", status: "declined" };
    invoke.mockResolvedValue(declined);
    expect(await declineInvitation("invi_live")).toEqual({
      ok: true,
      value: declined,
    });
    expect(invoke).toHaveBeenCalledWith(
      "decline_member_invite",
      { invitationPublicId: "invi_live" },
      expect.objectContaining({ userId: "u-priya", orgId: record.orgId }),
    );
  });

  it("the invitee's ctx cannot read, by type and at runtime (negative)", async () => {
    const { ctx } = await requireInvitee("invi_live");
    const read = kernelRead(
      // @ts-expect-error an InviteeCtx reaches no kernelRead overload
      ctx,
      { contract: listMembers, input: { scope: "org" }, page: "organization" },
    );
    expect(await read).toEqual(readError("invalid_ctx", 500));
    expect(invoke).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledOnce();
  });
});
