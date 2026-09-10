import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: { modelCredentials: { findFirst: mocks.findFirst } } }),
  };
});

import {
  orgModelCredentialGetHandler,
  toCredentialView,
} from "./org.model_credential.get";
import { orgModelCredentialGet } from "@oxagen/oxagen/contracts/org.model_credential.get";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const NOT_CONFIGURED = {
  configured: false,
  provider: null,
  status: null,
  keyHint: null,
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
        lastVerifiedAt: new Date("2026-09-09T10:00:00.000Z"),
        rotatedAt: new Date("2026-09-08T10:00:00.000Z"),
      }),
    ).toEqual({
      configured: true,
      provider: "openrouter",
      status: "active",
      keyHint: "wxyz",
      lastVerifiedAt: "2026-09-09T10:00:00.000Z",
      rotatedAt: "2026-09-08T10:00:00.000Z",
    });
  });

  it("narrows an unknown status to disabled — the direction the resolver takes", () => {
    const view = toCredentialView({
      provider: "gateway",
      status: "nonsense",
      keyHint: "abcd",
      lastVerifiedAt: null,
      rotatedAt: null,
    });
    expect(view.status).toBe("disabled");
    expect(view.provider).toBe("gateway");
  });

  it("refuses a provider outside the column's CHECK rather than naming the wrong vendor", () => {
    expect(() =>
      toCredentialView({
        provider: "anthropic",
        status: "active",
        keyHint: "abcd",
        lastVerifiedAt: null,
        rotatedAt: null,
      }),
    ).toThrow();
  });

  it("never carries envelope columns even when handed a whole row", () => {
    const view = toCredentialView({
      provider: "openrouter",
      status: "active",
      keyHint: "wxyz",
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
