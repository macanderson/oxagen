import { describe, expect, it } from "vitest";
import { orgModelCredentialGet } from "./org.model_credential.get";
import { getCapability } from "../registry";

describe("org.model_credential.get capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("get_model_credential")).toBe(orgModelCredentialGet);
  });

  it("takes no input", () => {
    expect(orgModelCredentialGet.input.parse({})).toEqual({});
  });

  it("parses the not-configured view with null everywhere", () => {
    const out = orgModelCredentialGet.output.parse({
      configured: false,
      provider: null,
      status: null,
      keyHint: null,
      lastVerifiedAt: null,
      rotatedAt: null,
    });
    expect(out.configured).toBe(false);
    expect(out.provider).toBeNull();
  });

  it("parses a configured view", () => {
    const out = orgModelCredentialGet.output.parse({
      configured: true,
      provider: "gateway",
      status: "active",
      keyHint: "wxyz",
      lastVerifiedAt: "2026-09-09T10:00:00.000Z",
      rotatedAt: "2026-09-08T10:00:00.000Z",
    });
    expect(out.provider).toBe("gateway");
    expect(out.keyHint).toBe("wxyz");
  });

  it("rejects a provider or status outside the shared enums", () => {
    const base = {
      configured: true,
      keyHint: "wxyz",
      lastVerifiedAt: null,
      rotatedAt: null,
    };
    expect(() =>
      orgModelCredentialGet.output.parse({
        ...base,
        provider: "anthropic",
        status: "active",
      }),
    ).toThrow();
    expect(() =>
      orgModelCredentialGet.output.parse({
        ...base,
        provider: "openrouter",
        status: "revoked",
      }),
    ).toThrow();
  });

  it("STRIPS any secret a handler mistakenly returned (no passthrough)", () => {
    const out = orgModelCredentialGet.output.parse({
      configured: true,
      provider: "openrouter",
      status: "active",
      keyHint: "wxyz",
      lastVerifiedAt: null,
      rotatedAt: null,
      // Hostile / buggy extras — the ADR-053 §2 rule is that a read capability
      // never surfaces the key, and the schema is the last line of defence.
      apiKey: "sk-or-v1-s3cret",
      keyDigest: "digest",
      keyCiphertext: "ciphertext",
    });
    expect(out).not.toHaveProperty("apiKey");
    expect(out).not.toHaveProperty("keyDigest");
    expect(out).not.toHaveProperty("keyCiphertext");
    expect(JSON.stringify(out)).not.toContain("s3cret");
  });

  it("is governed: org-admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgModelCredentialGet.scoped).toBe(false);
    expect(orgModelCredentialGet.sensitivity).toBe("high");
    expect(orgModelCredentialGet.defaultEffect).toBe("deny");
    expect(orgModelCredentialGet.noBillingGate).toBe(true);
    expect(orgModelCredentialGet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgModelCredentialGet.agent).toEqual({
      requiresApproval: false,
      riskLevel: "low",
      category: "configuration",
    });
    expect(orgModelCredentialGet.surfaces).toEqual(["api", "mcp"]);
  });
});
