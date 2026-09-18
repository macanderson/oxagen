import { describe, expect, it } from "vitest";
import { orgModelCredentialSet } from "./org.model_credential.set";
import { getCapability } from "../registry";

const KEY = "sk-or-v1-0123456789abcdef";

describe("org.model_credential.set capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("set_model_credential")).toBe(orgModelCredentialSet);
  });

  it("accepts a routed provider with a key and nothing else", () => {
    for (const provider of ["openrouter", "gateway"] as const) {
      const parsed = orgModelCredentialSet.input.parse({
        provider,
        apiKey: KEY,
      });
      expect(parsed.provider).toBe(provider);
      expect(parsed.apiKey).toBe(KEY);
    }
  });

  it("accepts a direct vendor key with its balanced-tier model", () => {
    for (const provider of ["openai", "anthropic"] as const) {
      const parsed = orgModelCredentialSet.input.parse({
        provider,
        apiKey: KEY,
        modelMap: { balanced: "some-model" },
      });
      expect(parsed.provider).toBe(provider);
    }
  });

  it("accepts an openai_compatible key with a public https endpoint and a model", () => {
    const parsed = orgModelCredentialSet.input.parse({
      provider: "openai_compatible",
      apiKey: KEY,
      baseUrl: "https://api.together.xyz/v1",
      modelMap: { balanced: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
    });
    expect(parsed.baseUrl).toBe("https://api.together.xyz/v1");
  });

  it("rejects a vendor there is no provider client for", () => {
    expect(() =>
      orgModelCredentialSet.input.parse({
        provider: "not-a-vendor",
        apiKey: KEY,
      }),
    ).toThrow();
  });

  it("rejects a direct vendor key with no balanced model — it would 404 on the first question", () => {
    // `api.openai.com` has no model called `anthropic/claude-sonnet-5`. The
    // failure belongs at save time, not on the customer's first question.
    expect(() =>
      orgModelCredentialSet.input.parse({ provider: "openai", apiKey: KEY }),
    ).toThrow(/balanced tier/);
  });

  it("rejects an openai_compatible key with no endpoint", () => {
    expect(() =>
      orgModelCredentialSet.input.parse({
        provider: "openai_compatible",
        apiKey: KEY,
        modelMap: { balanced: "m" },
      }),
    ).toThrow(/base URL/);
  });

  it("rejects an endpoint on a provider whose URL Oxagen spells — it would be silently ignored", () => {
    expect(() =>
      orgModelCredentialSet.input.parse({
        provider: "openrouter",
        apiKey: KEY,
        baseUrl: "https://example.com/v1",
      }),
    ).toThrow(/remove the base URL/);
  });

  it("rejects an http endpoint — the key would cross the wire in clear", () => {
    expect(() =>
      orgModelCredentialSet.input.parse({
        provider: "openai_compatible",
        apiKey: KEY,
        baseUrl: "http://api.together.xyz/v1",
        modelMap: { balanced: "m" },
      }),
    ).toThrow();
  });

  it.each([
    "https://169.254.169.254/v1",
    "https://127.0.0.1/v1",
    "https://[::ffff:169.254.169.254]/v1",
    "https://10.0.0.5/v1",
  ])(
    "refuses the internal endpoint %s as invalid input, not a 500",
    (baseUrl) => {
      // From the schema, a refusal is `invalid_input` on every surface. The same
      // throw from the handler would be an unclassified server error.
      const result = orgModelCredentialSet.input.safeParse({
        provider: "openai_compatible",
        apiKey: KEY,
        baseUrl,
        modelMap: { balanced: "m" },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === "baseUrl")).toBe(
          true,
        );
      }
    },
  );

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
      baseUrl: null,
      modelMap: {},
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
