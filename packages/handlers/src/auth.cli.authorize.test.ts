/**
 * Unit tests for the authorize_cli handler.
 *
 * The org is tier-free in every case: the kernel's IAM check allows every
 * capability there, so the refusals below come from the handler alone.
 *
 * Guards and their negatives:
 *   - no user session (apiKeyId only, or nothing) → HandlerError forbidden,
 *     no query, no code
 *   - no principal, Member, Viewer, Billing, Compliance → HandlerError
 *     forbidden, no code
 *   - a non-loopback redirectUri (https, a public host, no port) →
 *     CapabilityError invalid_input, no code
 *   - a workspace outside the org → HandlerError not_found, no code
 *   - Owner and Admin → a code is minted, bound to the approving user, the
 *     entered scope and its slugs, the challenge, the redirect target and
 *     the label, and the same code is returned
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  createCliAuthCode: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// The loopback rule and the code generator run for real; only the store
// write (withSystemDb inside createCliAuthCode) is replaced.
vi.mock("@oxagen/auth/cli-auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/auth/cli-auth")>();
  return { ...real, createCliAuthCode: mocks.createCliAuthCode };
});

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { authCliAuthorizeHandler } from "./auth.cli.authorize";
import { authCliAuthorize } from "@oxagen/oxagen/contracts/auth.cli.authorize";
import { TEST_CTX, makeCTX } from "./test-utils/fixtures";

const INPUT = {
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  codeChallengeMethod: "S256" as const,
  redirectUri: "http://127.0.0.1:53682/callback",
  label: "Oxagen CLI",
  state: "st_8f2a",
};

// ── tx double ─────────────────────────────────────────────────────────────────

type Tenant = {
  principalId: string | null;
  roleName: string | null;
  orgSlug: string | null;
  workspaceSlug: string | null;
};

/**
 * A select chain that answers by the table it was asked to read from, so the
 * test does not depend on the order the handler issues its queries in.
 */
function makeTx(tenant: Tenant) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.principals)
      return tenant.principalId ? [{ id: tenant.principalId }] : [];
    if (table === schema.principalRoleAssignments)
      return tenant.roleName ? [{ roleName: tenant.roleName }] : [];
    if (table === schema.organizations)
      return tenant.orgSlug ? [{ slug: tenant.orgSlug }] : [];
    if (table === schema.workspaces)
      return tenant.workspaceSlug ? [{ slug: tenant.workspaceSlug }] : [];
    throw new Error("unexpected table");
  };
  return {
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          limit: () => Promise.resolve(rowsFor(table)),
        };
        return chain;
      },
    }),
  };
}

function setup(overrides: Partial<Tenant> = {}) {
  const tenant: Tenant = {
    principalId: "prn_1",
    roleName: "Owner",
    orgSlug: "acme",
    workspaceSlug: "core",
    ...overrides,
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeTx(tenant))),
  );
  mocks.createCliAuthCode.mockResolvedValue(undefined);
}

const forbidden = (e: unknown) => isHandlerError(e) && e.code === "forbidden";
const notFound = (e: unknown) => isHandlerError(e) && e.code === "not_found";
const invalidInput = (e: unknown) =>
  e instanceof CapabilityError &&
  e.code === "invalid_input" &&
  e.capability === "authorize_cli";

// ── tests ─────────────────────────────────────────────────────────────────────

describe("authorize_cli — principal guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("refuses a context with no user and no API key before any query", async () => {
    const ctx: CapabilityContext = makeCTX({ userId: null, apiKeyId: null });
    await expect(authCliAuthorizeHandler(INPUT, ctx)).rejects.toSatisfy(
      forbidden,
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.createCliAuthCode).not.toHaveBeenCalled();
  });

  it("refuses an API-key actor: only a person can consent to a CLI login", async () => {
    const ctx: CapabilityContext = makeCTX({
      userId: null,
      apiKeyId: "aky_machine",
    });
    await expect(authCliAuthorizeHandler(INPUT, ctx)).rejects.toSatisfy(
      forbidden,
    );
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(mocks.createCliAuthCode).not.toHaveBeenCalled();
  });
});

describe("authorize_cli — role gate on a tier-free org", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses a user with no principal in the org and mints nothing", async () => {
    setup({ principalId: null, roleName: null });
    await expect(authCliAuthorizeHandler(INPUT, TEST_CTX)).rejects.toSatisfy(
      forbidden,
    );
    expect(mocks.createCliAuthCode).not.toHaveBeenCalled();
  });

  it.each(["Member", "Viewer", "Billing", "Compliance"])(
    "refuses an org %s and mints nothing",
    async (roleName) => {
      setup({ roleName });
      await expect(authCliAuthorizeHandler(INPUT, TEST_CTX)).rejects.toSatisfy(
        forbidden,
      );
      expect(mocks.createCliAuthCode).not.toHaveBeenCalled();
    },
  );
});

describe("authorize_cli — loopback guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it.each([
    ["an https loopback", "https://127.0.0.1:53682/callback"],
    ["a public host", "http://attacker.example:53682/callback"],
    ["a loopback with no port", "http://127.0.0.1/callback"],
    ["a loopback carrying a query", "http://127.0.0.1:53682/callback?x=1"],
    ["not a URL", "callback"],
  ])("refuses %s as invalid_input and mints nothing", async (_name, uri) => {
    await expect(
      authCliAuthorizeHandler({ ...INPUT, redirectUri: uri }, TEST_CTX),
    ).rejects.toSatisfy(invalidInput);
    expect(mocks.createCliAuthCode).not.toHaveBeenCalled();
  });

  it("checks the role before the redirect target, so a Member learns nothing about the target", async () => {
    setup({ roleName: "Member" });
    await expect(
      authCliAuthorizeHandler(
        { ...INPUT, redirectUri: "https://attacker.example/" },
        TEST_CTX,
      ),
    ).rejects.toSatisfy(forbidden);
  });
});

describe("authorize_cli — scope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses a workspace that is not in the org and mints nothing", async () => {
    setup({ workspaceSlug: null });
    await expect(authCliAuthorizeHandler(INPUT, TEST_CTX)).rejects.toSatisfy(
      notFound,
    );
    expect(mocks.createCliAuthCode).not.toHaveBeenCalled();
  });
});

describe("authorize_cli — mint", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["Owner", "Admin"])(
    "mints a code for an org %s bound to the user, the scope, the challenge and the target",
    async (roleName) => {
      setup({ roleName });
      const before = Date.now();
      const result = await authCliAuthorizeHandler(INPUT, TEST_CTX);

      expect(authCliAuthorize.output.parse(result)).toEqual(result);
      expect(result.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(mocks.createCliAuthCode).toHaveBeenCalledTimes(1);
      const [storedCode, data, now] =
        mocks.createCliAuthCode.mock.calls[0] ?? [];
      expect(storedCode).toBe(result.code);
      expect(data).toEqual({
        userId: TEST_CTX.userId,
        orgId: TEST_CTX.orgId,
        workspaceId: TEST_CTX.workspaceId,
        orgSlug: "acme",
        workspaceSlug: "core",
        codeChallenge: INPUT.codeChallenge,
        redirectUri: INPUT.redirectUri,
        label: INPUT.label,
      });
      expect(now).toBeGreaterThanOrEqual(before);
    },
  );

  it("mints a fresh code on every call", async () => {
    setup();
    const a = await authCliAuthorizeHandler(INPUT, TEST_CTX);
    const b = await authCliAuthorizeHandler(INPUT, TEST_CTX);
    expect(a.code).not.toBe(b.code);
  });

  it("accepts a localhost listener", async () => {
    setup();
    const result = await authCliAuthorizeHandler(
      { ...INPUT, redirectUri: "http://localhost:4321/cb" },
      TEST_CTX,
    );
    expect(mocks.createCliAuthCode.mock.calls[0]?.[1]).toMatchObject({
      redirectUri: "http://localhost:4321/cb",
    });
    expect(result.code).toBeTruthy();
  });
});
