// plugin.credential.reauth handler: the role gate (#4194).
//
// The contract grants org Owner or Admin. The kernel's IAM check allows every
// capability for a non-enterprise org, so the handler is the only gate there,
// and it runs before the org and workspace slugs are read.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);

const mocks = vi.hoisted(() => ({ withSystemDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});

import { handler } from "./plugin.credential.reauth";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const INPUT = { orgListingId: "lst_1" };

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  vi.stubEnv("APP_URL", "https://app.example.com");
  mocks.withSystemDb.mockResolvedValue({
    orgSlug: "acme",
    workspaceSlug: "main",
  });
});

describe("plugin.credential.reauth role gate", () => {
  it("refuses a workspace Member as forbidden and reads no tenant data", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(handler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
      reason: "org_role_required",
    });
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("refuses a workspace Owner, whom the contract does not name", async () => {
    roleGate.roles = { org: null, workspace: "Owner" };
    await expect(handler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("allows an org Admin", async () => {
    roleGate.roles = { org: "Admin" };
    await expect(handler(INPUT, CTX)).resolves.toEqual({
      authorizeUrl:
        "https://app.example.com/api/v1/mcp/oauth/authorize?orgSlug=acme&workspaceSlug=main&orgListingId=lst_1",
    });
  });
});
