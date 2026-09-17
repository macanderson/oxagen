import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { makeCTX } from "./test-utils/fixtures";
import type { UserGithubInstallation } from "./repository.github-user-installations";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  assertOrgRole: vi.fn(async () => "Owner"),
  resolveActingUserId: vi.fn(async (c: { userId: string | null }) => c.userId),
  attach: vi.fn(async () => ({
    connectionId: "conn-uuid",
    publicId: "con_abc123",
  })),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

vi.mock("@oxagen/iam/org-role", () => ({
  assertOrgRole: mocks.assertOrgRole,
  resolveActingUserId: mocks.resolveActingUserId,
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

vi.mock("./repository.github-connection", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("./repository.github-connection")>();
  return { ...real, attachWorkspaceGithubInstallation: mocks.attach };
});

import { createInstallationAttachHandler } from "./repository.installation.attach";

function installation(
  installationId: string,
  accountLogin: string | null = `login-${installationId}`,
): UserGithubInstallation {
  return {
    installationId,
    accountLogin,
    accountType: "Organization",
    avatarUrl: null,
    repositorySelection: "all",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertOrgRole.mockResolvedValue("Owner");
  mocks.resolveActingUserId.mockImplementation(
    async (c: { userId: string | null }) => c.userId,
  );
  mocks.attach.mockResolvedValue({
    connectionId: "conn-uuid",
    publicId: "con_abc123",
  });
});

describe("attach_github_installation", () => {
  it("refuses a caller who is not an org Owner or Admin, before asking or writing", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(new Error("org_role_required"));
    const candidates = vi.fn();
    await expect(
      createInstallationAttachHandler({ candidates })(
        { installationId: "555" },
        makeCTX(),
      ),
    ).rejects.toThrow("org_role_required");
    expect(candidates).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it("checks the role against the acting user the context resolves (INV-29)", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_acting");
    await createInstallationAttachHandler({
      candidates: async () => [installation("555")],
    })({ installationId: "555" }, makeCTX({ userId: "u_session" }));
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_acting" }),
      { org: ["Owner", "Admin"] },
    );
  });

  it("refuses github_not_authorized when there is no token to verify against", async () => {
    const err = await createInstallationAttachHandler({
      candidates: async () => null,
    })({ installationId: "555" }, makeCTX()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandlerError);
    expect(err).toMatchObject({
      code: "conflict",
      reason: "github_not_authorized",
    });
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  // THE test. An installation id names an account's source code, and the token
  // the repository capabilities mint through an attachment is minted with the
  // platform App's private key and carries no caller entitlement. So the id a
  // caller supplies is matched against that account's OWN /user/installations
  // before a single row is written.
  it("NEVER writes an installation the connected account cannot reach", async () => {
    const err = await createInstallationAttachHandler({
      candidates: async () => [installation("111"), installation("222")],
    })({ installationId: "999999" }, makeCTX()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HandlerError);
    expect(err).toMatchObject({
      code: "not_found",
      reason: "installation_unreachable",
    });
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  // The mirror, so the check is not merely proven to refuse everything: the
  // same request, differing only in whether the account lists the id, attaches.
  it("writes the same id when the connected account DOES reach it, and only then", async () => {
    const out = await createInstallationAttachHandler({
      candidates: async () => [installation("111"), installation("999999")],
    })({ installationId: "999999" }, makeCTX({ userId: "u_acting" }));

    expect(mocks.attach).toHaveBeenCalledWith({
      orgId: makeCTX().orgId,
      workspaceId: makeCTX().workspaceId,
      installationId: "999999",
      actingUserId: "u_acting",
    });
    expect(out).toEqual({
      connectionId: "con_abc123",
      accountLogin: "login-999999",
    });
  });

  // Fail closed. A GitHub failure is not an empty list and not an allow: it
  // reaches the caller as the upstream failure it is, with nothing written.
  it("writes nothing when the reachable set could not be read at all (negative)", async () => {
    await expect(
      createInstallationAttachHandler({
        candidates: async () => {
          throw new Error("GitHub answered 401");
        },
      })({ installationId: "555" }, makeCTX()),
    ).rejects.toThrow("GitHub answered 401");
    expect(mocks.attach).not.toHaveBeenCalled();
  });

  it("attaches an installation GitHub reported without an account, naming nothing", async () => {
    const out = await createInstallationAttachHandler({
      candidates: async () => [installation("555", null)],
    })({ installationId: "555" }, makeCTX());
    expect(out).toEqual({ connectionId: "con_abc123", accountLogin: null });
  });

  it("attributes the write to no user when the context resolves none", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce(null);
    await createInstallationAttachHandler({
      candidates: async () => [installation("555")],
    })({ installationId: "555" }, makeCTX({ userId: null }));
    expect(mocks.attach).toHaveBeenCalledWith(
      expect.objectContaining({ actingUserId: null }),
    );
  });
});
