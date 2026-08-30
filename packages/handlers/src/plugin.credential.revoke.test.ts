/**
 * plugin.credential.revoke.test.ts
 *
 * Revoking a plugin credential is a destructive, tenant-scoped delete: the
 * handler must (1) require workspace scope, (2) verify the org listing exists
 * for this org + workspace before touching the credential, and (3) report
 * whether a credential row actually existed via { revoked }. These tests pin
 * that contract with the DB and credential-service seams mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteWorkspaceSecret: vi.fn(),
}));

interface State {
  listingRows: Array<Record<string, unknown>>;
}
const state: State = { listingRows: [] };

function makeTx() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => state.listingRows,
        }),
      }),
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
  };
});

vi.mock("@oxagen/plugins", () => ({
  deleteWorkspaceSecret: mocks.deleteWorkspaceSecret,
}));

import { handler } from "./plugin.credential.revoke";

const ctx = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "api" as const,
  messageId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.listingRows = [{ id: "porg-1" }];
  mocks.deleteWorkspaceSecret.mockResolvedValue(true);
});

describe("plugin.credential.revoke", () => {
  it("throws when workspaceId is missing (scoped capability)", async () => {
    await expect(
      handler({ orgListingId: "porg-1" }, {
        ...ctx,
        workspaceId: null,
      } as never),
    ).rejects.toThrow("workspaceId is required");
    expect(mocks.deleteWorkspaceSecret).not.toHaveBeenCalled();
  });

  it("throws when the org listing does not exist for this org — never deletes", async () => {
    state.listingRows = [];
    await expect(
      handler({ orgListingId: "porg-missing" }, ctx as never),
    ).rejects.toThrow("Installed plugin not found or deleted: porg-missing");
    expect(mocks.deleteWorkspaceSecret).not.toHaveBeenCalled();
  });

  it("deletes the credential scoped to org + workspace + listing and returns { revoked: true }", async () => {
    const result = await handler({ orgListingId: "porg-1" }, ctx as never);

    expect(result).toEqual({ revoked: true });
    expect(mocks.deleteWorkspaceSecret).toHaveBeenCalledOnce();
    expect(mocks.deleteWorkspaceSecret).toHaveBeenCalledWith({
      orgId: "org-1",
      workspaceId: "ws-1",
      orgListingId: "porg-1",
    });
  });

  it("returns { revoked: false } when no credential row existed", async () => {
    mocks.deleteWorkspaceSecret.mockResolvedValue(false);

    const result = await handler({ orgListingId: "porg-1" }, ctx as never);

    expect(result).toEqual({ revoked: false });
  });

  it("propagates delete failures", async () => {
    mocks.deleteWorkspaceSecret.mockRejectedValue(new Error("db unavailable"));

    await expect(
      handler({ orgListingId: "porg-1" }, ctx as never),
    ).rejects.toThrow("db unavailable");
  });
});
