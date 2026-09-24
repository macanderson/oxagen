/**
 * create_scim_token, rotate_scim_token and revoke_scim_token (#3734).
 *
 * The token lifecycle: Owner or Admin only, Enterprise only to mint, the
 * token answered once, one live token per organization, and an audit row that
 * names the token by its prefix and never carries it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  readLive: vi.fn(),
  revokeLive: vi.fn(),
  insert: vi.fn(),
  withSystemDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: mocks.withSystemDb };
});
vi.mock("@oxagen/database/security", () => ({ emitSecurityEvent: mocks.emit }));
vi.mock("./lib/scim/token-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/scim/token-store")>()),
  readLiveScimToken: mocks.readLive,
  revokeLiveScimToken: mocks.revokeLive,
  insertScimToken: mocks.insert,
}));

const plan = vi.hoisted(() => ({ resolveOrgTier: vi.fn() }));
vi.mock("@oxagen/billing", () => ({
  canAccessSSO: (tier: string) => tier === "enterprise",
  resolveOrgTier: plan.resolveOrgTier,
}));

const roleGate = vi.hoisted(() => ({ refuse: false }));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId?: string | null }) =>
    ctx.userId ?? null,
  assertOrgRole: vi.fn(async () => {
    if (roleGate.refuse) {
      throw Object.assign(new Error("forbidden: org role required"), {
        code: "forbidden",
      });
    }
    return "Admin";
  }),
}));

import { orgScimTokenCreateHandler } from "./org.scim_token.create";
import { orgScimTokenRevokeHandler } from "./org.scim_token.revoke";
import { orgScimTokenRotateHandler } from "./org.scim_token.rotate";
import { TEST_CTX as CTX } from "./test-utils/fixtures";
import { SSO_BASE_URL } from "./test-utils/sso-fixtures";

const TOKEN = "oxscim_secret-part-of-the-token-0123456789abcdefghijk";
const ROW = {
  id: "row-new",
  tokenPrefix: "oxscim_secret-pa",
  createdAt: new Date("2026-09-23T10:00:00Z"),
  lastUsedAt: null,
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  roleGate.refuse = false;
  plan.resolveOrgTier.mockReset().mockResolvedValue("enterprise");
  process.env.BETTER_AUTH_URL = SSO_BASE_URL;
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  );
  mocks.readLive.mockResolvedValue(null);
  mocks.insert.mockResolvedValue({ token: TOKEN, row: ROW });
  mocks.revokeLive.mockResolvedValue({ ...ROW, id: "row-old", tokenPrefix: "oxscim_oldoldol" });
});

const emitted = () => mocks.emit.mock.calls.map((c) => c[0]);

describe("create_scim_token", () => {
  it("answers the token once, with the endpoint and the prefix view", async () => {
    const out = await orgScimTokenCreateHandler({}, CTX);
    expect(out).toEqual({
      token: TOKEN,
      baseUrl: `${SSO_BASE_URL}/api/scim/v2`,
      view: {
        tokenPrefix: ROW.tokenPrefix,
        createdAt: "2026-09-23T10:00:00.000Z",
        lastUsedAt: null,
      },
    });
    expect(mocks.insert).toHaveBeenCalledWith(expect.anything(), CTX.orgId, CTX.userId);
  });

  it("audits the mint by prefix and never writes the token into the row", async () => {
    await orgScimTokenCreateHandler({}, CTX);
    expect(emitted()).toEqual([
      expect.objectContaining({
        eventType: "scim.token_created",
        orgId: CTX.orgId,
        actorUserId: CTX.userId,
        detail: { tokenPrefix: ROW.tokenPrefix },
      }),
    ]);
    expect(JSON.stringify(emitted())).not.toContain(TOKEN);
  });

  it("refuses a second token while one is live", async () => {
    mocks.readLive.mockResolvedValue(ROW);
    await expect(orgScimTokenCreateHandler({}, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "scim_token_exists",
    });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not an org Owner or Admin", async () => {
    roleGate.refuse = true;
    await expect(orgScimTokenCreateHandler({}, CTX)).rejects.toThrow(/forbidden/);
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("refuses an organization off the Enterprise plan", async () => {
    plan.resolveOrgTier.mockResolvedValue("scale");
    await expect(orgScimTokenCreateHandler({}, CTX)).rejects.toMatchObject({
      code: "forbidden",
      reason: "sso_requires_enterprise",
    });
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });
});

describe("rotate_scim_token", () => {
  it("revokes the live token and mints its replacement in one transaction", async () => {
    const out = await orgScimTokenRotateHandler({}, CTX);
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
    expect(mocks.revokeLive).toHaveBeenCalledWith(expect.anything(), CTX.orgId, CTX.userId);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(out.token).toBe(TOKEN);
    expect(emitted()).toEqual([
      expect.objectContaining({
        eventType: "scim.token_rotated",
        detail: { tokenPrefix: ROW.tokenPrefix },
      }),
    ]);
  });

  it("mints one when none was live, so a lost token is recoverable", async () => {
    mocks.revokeLive.mockResolvedValue(null);
    await expect(orgScimTokenRotateHandler({}, CTX)).resolves.toMatchObject({
      token: TOKEN,
    });
  });

  it("refuses an organization off the Enterprise plan", async () => {
    plan.resolveOrgTier.mockResolvedValue("team");
    await expect(orgScimTokenRotateHandler({}, CTX)).rejects.toMatchObject({
      reason: "sso_requires_enterprise",
    });
    expect(mocks.revokeLive).not.toHaveBeenCalled();
  });
});

describe("revoke_scim_token", () => {
  it("revokes the live token and audits it", async () => {
    await expect(orgScimTokenRevokeHandler({}, CTX)).resolves.toEqual({
      revoked: true,
    });
    expect(emitted()).toEqual([
      expect.objectContaining({
        eventType: "scim.token_revoked",
        detail: { tokenPrefix: "oxscim_oldoldol" },
      }),
    ]);
  });

  it("answers revoked: false and writes no audit row when no token is live", async () => {
    mocks.revokeLive.mockResolvedValue(null);
    await expect(orgScimTokenRevokeHandler({}, CTX)).resolves.toEqual({
      revoked: false,
    });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("stays open off the Enterprise plan, so SCIM can be turned off after a downgrade", async () => {
    plan.resolveOrgTier.mockResolvedValue("free");
    await expect(orgScimTokenRevokeHandler({}, CTX)).resolves.toEqual({
      revoked: true,
    });
  });

  it("refuses a caller who is not an org Owner or Admin", async () => {
    roleGate.refuse = true;
    await expect(orgScimTokenRevokeHandler({}, CTX)).rejects.toThrow(/forbidden/);
    expect(mocks.revokeLive).not.toHaveBeenCalled();
  });
});
