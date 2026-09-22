import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: { modelCredentials: { findFirst: mocks.findFirst } } }),
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import {
  orgModelCredentialGetHandler,
  toCredentialView,
} from "./org.model_credential.get";
// The org-role gate every model-credential handler asserts (INV-29). Allows
// by default — an org Admin — so each case below tests its own behaviour;
// the refusal cases set `roleGate.refuse` and assert nothing else ran.
const roleGate = vi.hoisted(() => ({
  refuse: false,
  assertOrgRole: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (ctx: { userId?: string | null }) =>
    ctx.userId ?? null,
  assertOrgRole: roleGate.assertOrgRole.mockImplementation(async () => {
    if (roleGate.refuse) {
      throw Object.assign(new Error("forbidden: org role required"), {
        code: "forbidden",
      });
    }
    return "Admin";
  }),
  resolveActorOrgRole: async () => null,
  resolveActorWorkspaceRole: async () => null,
}));

import { orgModelCredentialGet } from "@oxagen/oxagen/contracts/org.model_credential.get";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const NOT_CONFIGURED = {
  configured: false,
  provider: null,
  status: null,
  keyHint: null,
  baseUrl: null,
  modelMap: {},
  lastVerifiedAt: null,
  rotatedAt: null,
};

beforeEach(() => {
  mocks.findFirst.mockReset();
});

describe("toCredentialView", () => {
  it("maps a missing row to not-configured with null everywhere (absence IS the platform key)", () => {
    expect(toCredentialView(null)).toEqual(NOT_CONFIGURED);
  });

  it("projects a live row onto the redacted shape with ISO-8601 timestamps", () => {
    expect(
      toCredentialView({
        provider: "openrouter",
        status: "active",
        keyHint: "wxyz",
        baseUrl: null,
        modelMap: {},
        lastVerifiedAt: new Date("2026-09-09T10:00:00.000Z"),
        rotatedAt: new Date("2026-09-08T10:00:00.000Z"),
      }),
    ).toEqual({
      configured: true,
      provider: "openrouter",
      status: "active",
      keyHint: "wxyz",
      baseUrl: null,
      modelMap: {},
      lastVerifiedAt: "2026-09-09T10:00:00.000Z",
      rotatedAt: "2026-09-08T10:00:00.000Z",
    });
  });

  it("narrows an unknown status to disabled — the direction the resolver takes", () => {
    const view = toCredentialView({
      provider: "gateway",
      status: "nonsense",
      keyHint: "abcd",
      baseUrl: null,
      modelMap: {},
      lastVerifiedAt: null,
      rotatedAt: null,
    });
    expect(view.status).toBe("disabled");
    expect(view.provider).toBe("gateway");
  });

  it("refuses a provider outside the column's CHECK rather than naming the wrong vendor", () => {
    expect(() =>
      toCredentialView({
        provider: "not-a-vendor",
        status: "active",
        keyHint: "abcd",
        baseUrl: null,
        modelMap: {},
        lastVerifiedAt: null,
        rotatedAt: null,
      }),
    ).toThrow();
  });

  it("returns an openai_compatible endpoint and its model map, which are not secrets", () => {
    const view = toCredentialView({
      provider: "openai_compatible",
      status: "active",
      keyHint: "9f2c",
      baseUrl: "https://api.together.xyz/v1",
      modelMap: { balanced: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
      lastVerifiedAt: null,
      rotatedAt: null,
    });
    expect(view.provider).toBe("openai_compatible");
    expect(view.baseUrl).toBe("https://api.together.xyz/v1");
    expect(view.modelMap).toEqual({
      balanced: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    });
  });

  it("redacts a credential a stored endpoint carries", () => {
    // The endpoint is returned in full because it is not a secret — which is
    // true because `assertPublicHttpUrl` refuses one with userinfo in it. A
    // row written before that check would hand a password to every read, to
    // the settings page and to `get_model_credential` on every surface
    // (#3314, finding 3). Such a row cannot serve a turn either: Node's fetch
    // refuses a URL carrying credentials, so it has to be retyped.
    const view = toCredentialView({
      provider: "openai_compatible",
      status: "active",
      keyHint: "9f2c",
      baseUrl: "https://acme:hunter2@api.together.xyz/v1",
      modelMap: { balanced: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
      lastVerifiedAt: null,
      rotatedAt: null,
    });
    expect(view.baseUrl).toBe("https://***@api.together.xyz/v1");
    expect(JSON.stringify(view)).not.toContain("hunter2");
  });

  it("shows the model map the runtime will act on, not the raw jsonb", () => {
    // A jsonb column says nothing about shape. The page must show what the
    // resolver will actually use, so junk is dropped on the same rules.
    const view = toCredentialView({
      provider: "openai",
      status: "active",
      keyHint: "abcd",
      baseUrl: null,
      modelMap: { balanced: "gpt-5.2", fast: 42, precise: "", extra: "x" },
      lastVerifiedAt: null,
      rotatedAt: null,
    });
    expect(view.modelMap).toEqual({ balanced: "gpt-5.2" });
  });

  it("never carries envelope columns even when handed a whole row", () => {
    const view = toCredentialView({
      provider: "openrouter",
      status: "active",
      keyHint: "wxyz",
      baseUrl: null,
      modelMap: {},
      lastVerifiedAt: null,
      rotatedAt: null,
      // Extra columns a caller might pass by handing over the full row.
      keyCiphertext: Buffer.from("ciphertext"),
      keyDigest: "digest-of-the-key",
      keyKeyId: "model_credential_v1",
    } as Parameters<typeof toCredentialView>[0]);
    expect(view).not.toHaveProperty("keyCiphertext");
    expect(view).not.toHaveProperty("keyDigest");
    expect(view).not.toHaveProperty("keyKeyId");
    expect(JSON.stringify(view)).not.toContain("digest-of-the-key");
  });
});

describe("org.model_credential.get handler", () => {
  it("returns not-configured when no live row exists", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    const out = await orgModelCredentialGetHandler({}, CTX);
    expect(out).toEqual(NOT_CONFIGURED);
  });

  it("returns ONLY the redacted columns of a live row", async () => {
    mocks.findFirst.mockResolvedValue({
      id: "row-1",
      orgId: CTX.orgId,
      provider: "gateway",
      status: "active",
      keyCiphertext: Buffer.from("ciphertext"),
      keyKeyId: "model_credential_v1",
      keyDigest: "digest-of-the-key",
      keyHint: "abcd",
      lastVerifiedAt: null,
      rotatedAt: new Date("2026-09-08T10:00:00.000Z"),
      deletedAt: null,
    });
    const out = await orgModelCredentialGetHandler({}, CTX);
    expect(out).toEqual({
      configured: true,
      provider: "gateway",
      status: "active",
      keyHint: "abcd",
      baseUrl: null,
      modelMap: {},
      lastVerifiedAt: null,
      rotatedAt: "2026-09-08T10:00:00.000Z",
    });
    // ADR-053 §2 — a read capability never surfaces the key or its envelope.
    expect(JSON.stringify(out)).not.toContain("ciphertext");
    expect(JSON.stringify(out)).not.toContain("digest-of-the-key");
    expect(JSON.stringify(out)).not.toContain("model_credential_v1");
  });

  it("returns a payload the contract's output schema accepts", async () => {
    mocks.findFirst.mockResolvedValue(undefined);
    const out = await orgModelCredentialGetHandler({}, CTX);
    expect(() => orgModelCredentialGet.output.parse(out)).not.toThrow();
  });

  it("surfaces a disabled credential so the operator sees the platform key is in use", async () => {
    mocks.findFirst.mockResolvedValue({
      provider: "openrouter",
      status: "disabled",
      keyHint: "wxyz",
      lastVerifiedAt: null,
      rotatedAt: null,
    });
    const out = await orgModelCredentialGetHandler({}, CTX);
    expect(out.configured).toBe(true);
    expect(out.status).toBe("disabled");
  });
});

describe("org.model_credential.get handler — the role gate", () => {
  it("refuses a non-admin before reading the row", async () => {
    roleGate.refuse = true;
    try {
      await expect(orgModelCredentialGetHandler({}, CTX)).rejects.toThrow(
        /forbidden/,
      );
      expect(mocks.findFirst).not.toHaveBeenCalled();
    } finally {
      roleGate.refuse = false;
    }
  });
});
