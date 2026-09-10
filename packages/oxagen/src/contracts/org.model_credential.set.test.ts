import { describe, expect, it } from "vitest";
import { orgModelCredentialSet } from "./org.model_credential.set";
import { getCapability } from "../registry";

const KEY = "sk-or-v1-0123456789abcdef";

describe("org.model_credential.set capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("set_model_credential")).toBe(orgModelCredentialSet);
  });

  it("accepts each supported provider with a key", () => {
    for (const provider of ["openrouter", "gateway"] as const) {
      const parsed = orgModelCredentialSet.input.parse({
        provider,
        apiKey: KEY,
      });
      expect(parsed.provider).toBe(provider);
      expect(parsed.apiKey).toBe(KEY);
    }
  });

  it("rejects a vendor there is no provider client for", () => {
    expect(() =>
      orgModelCredentialSet.input.parse({ provider: "anthropic", apiKey: KEY }),
    ).toThrow();
  });

  it("requires both a provider and a key", () => {
    expect(() =>
      orgModelCredentialSet.input.parse({ provider: "openrouter" }),
    ).toThrow();
    expect(() => orgModelCredentialSet.input.parse({ apiKey: KEY })).toThrow();
  });

  it("rejects an empty or too-short paste before anything is encrypted", () => {
    expect(() =>
      orgModelCredentialSet.input.parse({ provider: "openrouter", apiKey: "" }),
    ).toThrow();
    expect(() =>
      orgModelCredentialSet.input.parse({
        provider: "openrouter",
        apiKey: "short",
      }),
    ).toThrow();
  });

  it("bounds the key length so a hostile value cannot inflate a ciphertext", () => {
    expect(() =>
      orgModelCredentialSet.input.parse({
        provider: "gateway",
        apiKey: "k".repeat(513),
      }),
    ).toThrow();
    expect(
      orgModelCredentialSet.input.parse({
        provider: "gateway",
        apiKey: "k".repeat(512),
      }).apiKey,
    ).toHaveLength(512);
  });

  it("returns the same REDACTED view as the read capability, stripping a leaked key", () => {
    const out = orgModelCredentialSet.output.parse({
      configured: true,
      provider: "openrouter",
      status: "active",
      keyHint: "cdef",
      lastVerifiedAt: null,
      rotatedAt: "2026-09-09T00:00:00.000Z",
      // A handler bug that echoed the input — the schema is the last line of
      // defence and drops it, because z.object strips unknown keys.
      apiKey: KEY,
    });
    expect(out).not.toHaveProperty("apiKey");
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("is governed: org-admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgModelCredentialSet.scoped).toBe(false);
    expect(orgModelCredentialSet.sensitivity).toBe("high");
    expect(orgModelCredentialSet.defaultEffect).toBe("deny");
    expect(orgModelCredentialSet.noBillingGate).toBe(true);
    expect(orgModelCredentialSet.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgModelCredentialSet.surfaces).toEqual(["api", "mcp"]);
    expect(orgModelCredentialSet.layers).toEqual([
      "schema",
      "api",
      "mcp",
      "unit",
      "docs",
    ]);
  });

  it("is NOT an agent tool: the in-app agent must never set the key that funds its own turns", () => {
    expect("agent" in orgModelCredentialSet).toBe(false);
  });
});
