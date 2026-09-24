// readBoundRepository refuses a GitLab binding by name (#3762): the three
// capabilities built on it read and write through a GitHub App installation.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
    withOrgDb: mocks.withTenantDb,
  };
});

import { readBoundRepository } from "./repository.bound";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

function answer(row: Record<string, unknown> | null) {
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: () => ({ limit: async () => (row ? [row] : []) }),
            }),
          }),
        }),
      }),
  );
}

const ROW = {
  headId: "head-uuid",
  role: "main",
  provider: "github",
  connectionId: "conn-uuid",
  providerRepositoryId: "9001",
  bindingRowId: "binding-uuid",
  bindingId: "rpb_0123abcd",
  version: 1,
  owner: "acme",
  name: "widgets",
  fullName: "acme/widgets",
  productionBranch: "main",
};

beforeEach(() => vi.resetAllMocks());

describe("readBoundRepository", () => {
  it("answers a GitHub binding", async () => {
    answer(ROW);
    await expect(
      readBoundRepository(SCOPE, "rpb_0123abcd"),
    ).resolves.toMatchObject({ provider: "github", fullName: "acme/widgets" });
  });

  it("refuses a GitLab binding by name rather than reaching for GitHub", async () => {
    answer({ ...ROW, provider: "gitlab", fullName: "acme/platform/rules" });
    await expect(
      readBoundRepository(SCOPE, "rpb_0123abcd"),
    ).rejects.toMatchObject({
      code: "conflict",
      reason: "repository_host_unsupported",
    });
  });

  it("refuses an id no head in this workspace carries", async () => {
    answer(null);
    await expect(readBoundRepository(SCOPE, "rpb_ffff")).rejects.toMatchObject({
      reason: "repository_not_linked",
    });
  });
});
