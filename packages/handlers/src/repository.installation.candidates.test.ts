import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { makeCTX } from "./test-utils/fixtures";
import type { UserGithubInstallation } from "./repository.github-user-installations";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  assertOrgRole: vi.fn(async () => "Owner"),
  resolveActingUserId: vi.fn(async (c: { userId: string | null }) => c.userId),
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

import { createInstallationCandidatesHandler } from "./repository.installation.candidates";

function installation(
  over: Partial<UserGithubInstallation> & { installationId: string },
): UserGithubInstallation {
  return {
    accountLogin: `login-${over.installationId}`,
    accountType: "Organization",
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    repositorySelection: "all",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertOrgRole.mockResolvedValue("Owner");
  mocks.resolveActingUserId.mockImplementation(
    async (c: { userId: string | null }) => c.userId,
  );
});

describe("list_github_installations", () => {
  it("refuses a caller who is not an org Owner or Admin, before asking GitHub", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(new Error("org_role_required"));
    const candidates = vi.fn();
    await expect(
      createInstallationCandidatesHandler({ candidates })({}, makeCTX()),
    ).rejects.toThrow("org_role_required");
    expect(candidates).not.toHaveBeenCalled();
  });

  it("checks the role against the acting user the context resolves (INV-29)", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_acting");
    await createInstallationCandidatesHandler({
      candidates: async () => [],
    })({}, makeCTX({ userId: "u_session" }));
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_acting" }),
      { org: ["Owner", "Admin"] },
    );
  });

  it("asks about the workspace in the context, never about one a caller named", async () => {
    const candidates = vi.fn(async () => []);
    await createInstallationCandidatesHandler({ candidates })(
      {},
      makeCTX({ orgId: "org-1", workspaceId: "ws-1" }),
    );
    expect(candidates).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
    });
  });

  // No stored authorization means there is nothing to ask GitHub with. That is
  // a different next click from "the App is installed nowhere", so it is a
  // different answer.
  it("refuses github_not_authorized when the org has no usable GitHub token", async () => {
    const err = await createInstallationCandidatesHandler({
      candidates: async () => null,
    })({}, makeCTX()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandlerError);
    expect(err).toMatchObject({
      code: "conflict",
      reason: "github_not_authorized",
    });
  });

  // …and an empty list is NOT that refusal. It is the honest answer for an
  // account that authorized Oxagen and installed the App nowhere, which the
  // dialog answers with the install door.
  it("answers an empty list rather than refusing when the App is installed nowhere", async () => {
    await expect(
      createInstallationCandidatesHandler({ candidates: async () => [] })(
        {},
        makeCTX(),
      ),
    ).resolves.toEqual({ installations: [] });
  });

  it("projects every fact the picker cites and nothing more", async () => {
    const out = await createInstallationCandidatesHandler({
      candidates: async () => [
        installation({
          installationId: "555",
          accountLogin: "acme",
          accountType: "Organization",
          avatarUrl: "https://avatars.githubusercontent.com/u/9?v=4",
          repositorySelection: "selected",
        }),
      ],
    })({}, makeCTX());
    expect(out).toEqual({
      installations: [
        {
          installationId: "555",
          accountLogin: "acme",
          accountType: "Organization",
          avatarUrl: "https://avatars.githubusercontent.com/u/9?v=4",
          repositorySelection: "selected",
        },
      ],
    });
  });

  it("sorts by account login so two reads put the same row in the same place", async () => {
    const out = await createInstallationCandidatesHandler({
      candidates: async () => [
        installation({ installationId: "3", accountLogin: "zeta" }),
        installation({ installationId: "1", accountLogin: "acme" }),
        installation({ installationId: "2", accountLogin: "middle" }),
      ],
    })({}, makeCTX());
    expect(out.installations.map((i) => i.accountLogin)).toEqual([
      "acme",
      "middle",
      "zeta",
    ]);
  });

  // The picker's whole job is naming what it offers. An installation GitHub
  // reported with no account is one nobody could read, so it is not offered —
  // and it stays reachable for the attach, which matches the unfiltered list.
  it("omits an installation GitHub reported without an account login (negative)", async () => {
    const out = await createInstallationCandidatesHandler({
      candidates: async () => [
        installation({ installationId: "1", accountLogin: null }),
        installation({ installationId: "2", accountLogin: "acme" }),
      ],
    })({}, makeCTX());
    expect(out.installations).toHaveLength(1);
    expect(out.installations[0]?.installationId).toBe("2");
  });

  // "We could not ask" is never "there is nothing there": a GitHub failure
  // surfaces rather than becoming an empty list the dialog would read as
  // "install the App".
  it("lets a GitHub failure surface rather than answering an empty list (negative)", async () => {
    await expect(
      createInstallationCandidatesHandler({
        candidates: async () => {
          throw new Error("GitHub answered 502");
        },
      })({}, makeCTX()),
    ).rejects.toThrow("GitHub answered 502");
  });
});
