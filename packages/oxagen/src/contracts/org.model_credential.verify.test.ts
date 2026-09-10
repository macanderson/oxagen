import { describe, expect, it } from "vitest";
import {
  orgModelCredentialVerify,
  orgModelCredentialVerifyInputObject,
} from "./org.model_credential.verify";
import { getCapability } from "../registry";

const KEY = "sk-or-v1-0123456789abcdef";

describe("org.model_credential.verify capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("verify_model_credential")).toBe(
      orgModelCredentialVerify,
    );
  });

  it("exposes the base object so the MCP tool can read .shape", () => {
    expect(
      Object.keys(orgModelCredentialVerifyInputObject.shape).sort(),
    ).toEqual(["apiKey", "provider"]);
  });

  it("accepts a candidate: provider and apiKey together", () => {
    const parsed = orgModelCredentialVerify.input.parse({
      provider: "gateway",
      apiKey: KEY,
    });
    expect(parsed).toEqual({ provider: "gateway", apiKey: KEY });
  });

  it("accepts the stored-key form: neither field", () => {
    const parsed = orgModelCredentialVerify.input.parse({});
    expect(parsed.provider).toBeUndefined();
    expect(parsed.apiKey).toBeUndefined();
  });

  it("rejects a provider without a key — nothing to check", () => {
    expect(() =>
      orgModelCredentialVerify.input.parse({ provider: "openrouter" }),
    ).toThrow(/must be given together/);
  });

  it("rejects a key without a provider — nothing to check it against", () => {
    expect(() => orgModelCredentialVerify.input.parse({ apiKey: KEY })).toThrow(
      /must be given together/,
    );
  });

  it("points the pairing error at the field that is missing", () => {
    const missingKey = orgModelCredentialVerify.input.safeParse({
      provider: "openrouter",
    });
    expect(missingKey.success).toBe(false);
    if (!missingKey.success) {
      expect(missingKey.error.issues[0]?.path).toEqual(["apiKey"]);
    }
    const missingProvider = orgModelCredentialVerify.input.safeParse({
      apiKey: KEY,
    });
    expect(missingProvider.success).toBe(false);
    if (!missingProvider.success) {
      expect(missingProvider.error.issues[0]?.path).toEqual(["provider"]);
    }
  });

  it("still holds the key bounds on a candidate", () => {
    expect(() =>
      orgModelCredentialVerify.input.parse({
        provider: "openrouter",
        apiKey: "short",
      }),
    ).toThrow();
  });

  it("reports a verdict with the vendor's reason and never the key", () => {
    const refused = orgModelCredentialVerify.output.parse({
      ok: false,
      provider: "openrouter",
      latencyMs: 120,
      error: "Invalid API key",
      apiKey: KEY,
    });
    expect(refused).toEqual({
      ok: false,
      provider: "openrouter",
      latencyMs: 120,
      error: "Invalid API key",
    });
    expect(refused).not.toHaveProperty("apiKey");
    const accepted = orgModelCredentialVerify.output.parse({
      ok: true,
      provider: "gateway",
      latencyMs: 0,
      error: null,
    });
    expect(accepted.error).toBeNull();
  });

  it("rejects a negative or fractional latency", () => {
    expect(() =>
      orgModelCredentialVerify.output.parse({
        ok: true,
        provider: "gateway",
        latencyMs: -1,
        error: null,
      }),
    ).toThrow();
    expect(() =>
      orgModelCredentialVerify.output.parse({
        ok: true,
        provider: "gateway",
        latencyMs: 1.5,
        error: null,
      }),
    ).toThrow();
  });

  it("is governed: org-admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgModelCredentialVerify.scoped).toBe(false);
    expect(orgModelCredentialVerify.sensitivity).toBe("high");
    expect(orgModelCredentialVerify.defaultEffect).toBe("deny");
    expect(orgModelCredentialVerify.noBillingGate).toBe(true);
    expect(orgModelCredentialVerify.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgModelCredentialVerify.surfaces).toEqual(["api", "mcp"]);
    expect("agent" in orgModelCredentialVerify).toBe(false);
  });
});
