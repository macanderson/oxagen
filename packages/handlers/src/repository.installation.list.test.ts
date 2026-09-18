import { beforeEach, describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { repositoryInstallationList } from "@oxagen/oxagen/contracts/repository.installation.list";
import type { GitHubInstallationRepo } from "@oxagen/github";
import { makeCTX } from "./test-utils/fixtures";

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

import { createInstallationRepositoriesHandler } from "./repository.installation.list";

function repo(fullName: string, over: Partial<GitHubInstallationRepo> = {}) {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    id: `id-${fullName}`,
    owner,
    name,
    fullName,
    defaultBranch: "main",
    private: true,
    htmlUrl: `https://github.com/${fullName}`,
    ...over,
  } satisfies GitHubInstallationRepo;
}

/** The workspace's GitHub connection lookup — the one and only db read here. */
function wireConnections(rows: unknown[]): void {
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // `.orderBy(desc(created_at))` is part of the resolver's query — it
        // and the install callback's attach must agree on which connection is
        // authoritative, so the chain mocked here carries it too.
        select: () => ({
          from: () => ({ where: () => ({ orderBy: async () => rows }) }),
        }),
      }),
  );
}

const CONNECTED = [
  {
    id: "conn-uuid",
    publicId: "con_ABC",
    status: "connected",
    deliveryConfig: { installationId: "555" },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertOrgRole.mockResolvedValue("Owner");
  mocks.resolveActingUserId.mockImplementation(
    async (c: { userId: string | null }) => c.userId,
  );
});

describe("list_installation_repositories", () => {
  it("refuses a caller who is not an org Owner or Admin, before reading anything", async () => {
    mocks.assertOrgRole.mockRejectedValueOnce(new Error("org_role_required"));
    const repositories = vi.fn();
    await expect(
      createInstallationRepositoriesHandler({ repositories })({}, makeCTX()),
    ).rejects.toThrow("org_role_required");
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(repositories).not.toHaveBeenCalled();
  });

  it("checks the role against the acting user the context resolves (INV-29)", async () => {
    mocks.resolveActingUserId.mockResolvedValueOnce("u_acting");
    wireConnections(CONNECTED);
    await createInstallationRepositoriesHandler({
      repositories: async () => ({ repositories: [], truncated: false }),
    })({}, makeCTX({ userId: "u_session" }));
    expect(mocks.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u_acting" }),
      { org: ["Owner", "Admin"] },
    );
  });

  it("refuses github_not_connected when no connection carries an installation", async () => {
    wireConnections([]);
    const repositories = vi.fn();
    const err = await createInstallationRepositoriesHandler({ repositories })(
      {},
      makeCTX(),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HandlerError);
    expect(err).toMatchObject({
      code: "conflict",
      reason: "github_not_connected",
    });
    // The same refusal bind_main_repository gives, and no GitHub call made.
    expect(repositories).not.toHaveBeenCalled();
  });

  it("refuses when the workspace's only GitHub connection has no installation id", async () => {
    wireConnections([
      {
        id: "conn-uuid",
        publicId: "con_ABC",
        status: "pending_setup",
        deliveryConfig: { owner: "acme" },
      },
    ]);
    await expect(
      createInstallationRepositoriesHandler({ repositories: vi.fn() })(
        {},
        makeCTX(),
      ),
    ).rejects.toMatchObject({ reason: "github_not_connected" });
  });

  it("takes the installation from the connection, never from input", async () => {
    wireConnections([
      { id: "a", publicId: "con_A", status: "error", deliveryConfig: null },
      {
        id: "b",
        publicId: "con_B",
        status: "connected",
        deliveryConfig: { installationId: 777 },
      },
    ]);
    const repositories = vi.fn(async () => ({
      repositories: [],
      truncated: false,
    }));
    await createInstallationRepositoriesHandler({ repositories })(
      {},
      makeCTX(),
    );
    // A numeric installationId in the stored config is normalised to text.
    expect(repositories).toHaveBeenCalledWith("777");
  });

  it("answers the installation's repositories, sorted by full name", async () => {
    wireConnections(CONNECTED);
    const out = await createInstallationRepositoriesHandler({
      repositories: async () => ({
        repositories: [
          repo("acme/zebra"),
          repo("acme/apple", { private: false, defaultBranch: "trunk" }),
          repo("Acme-Inc/beta"),
        ],
        truncated: false,
      }),
    })({}, makeCTX());

    expect(out.repositories.map((r) => r.fullName)).toEqual([
      "Acme-Inc/beta",
      "acme/apple",
      "acme/zebra",
    ]);
    expect(out.repositories[1]).toEqual({
      id: "id-acme/apple",
      owner: "acme",
      name: "apple",
      fullName: "acme/apple",
      defaultBranch: "trunk",
      private: false,
      htmlUrl: "https://github.com/acme/apple",
    });
    expect(out.truncated).toBe(false);
    expect(() => repositoryInstallationList.output.parse(out)).not.toThrow();
  });

  it("carries truncation through, so the surface can say the list is not all of it", async () => {
    wireConnections(CONNECTED);
    const out = await createInstallationRepositoriesHandler({
      repositories: async () => ({
        repositories: [repo("acme/one")],
        truncated: true,
      }),
    })({}, makeCTX());

    expect(out.truncated).toBe(true);
    expect(() => repositoryInstallationList.output.parse(out)).not.toThrow();
  });

  it("answers an empty list for an installation granted no repositories", async () => {
    wireConnections(CONNECTED);
    const out = await createInstallationRepositoriesHandler({
      repositories: async () => ({ repositories: [], truncated: false }),
    })({}, makeCTX());

    expect(out).toEqual({ repositories: [], truncated: false });
    expect(() => repositoryInstallationList.output.parse(out)).not.toThrow();
  });

  it("lets a GitHub failure surface rather than reporting an empty installation", async () => {
    wireConnections(CONNECTED);
    await expect(
      createInstallationRepositoriesHandler({
        repositories: async () => {
          throw new Error("GitHub API error 403: Resource not accessible");
        },
      })({}, makeCTX()),
    ).rejects.toThrow("GitHub API error 403");
  });
});
