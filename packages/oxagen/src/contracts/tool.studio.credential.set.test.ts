/**
 * Contract test for set_mcp_credential (mcp-studio-spec, Authentication).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import {
  STUDIO_CREDENTIAL_SECRET_MAX,
  toolStudioCredentialSet,
  toolStudioCredentialSetInputObject,
} from "./tool.studio.credential.set";

describe("set_mcp_credential is registered as declared", () => {
  it("is scoped, writes, skips the billing gate, and grants org Owner and Admin only", () => {
    const cap = getCapability("set_mcp_credential");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(true);
    expect(cap?.noBillingGate).toBe(true);
    expect(cap?.sensitivity).toBe("high");
    expect(cap?.surfaces).toEqual(["api", "mcp"]);
    expect(cap?.defaultRoles).toEqual({ org: { Owner: "allow", Admin: "allow" }, workspace: {} });
    expect(cap?.audit).toEqual({ targetKind: "mcp_credential", targetIdField: "name" });
  });
});

describe("set_mcp_credential input", () => {
  it("takes a service secret", () => {
    expect(
      toolStudioCredentialSet.input.parse({ name: "stripe-live", kind: "secret", secret: "sk_test_fake_1" }),
    ).toEqual({ name: "stripe-live", kind: "secret", secret: "sk_test_fake_1" });
  });

  it("takes an OAuth client's id and secret", () => {
    expect(
      toolStudioCredentialSet.input.parse({
        name: "github-app",
        kind: "oauth_client",
        clientId: "Iv1.abc",
        clientSecret: "cs_test_fake_2",
      }),
    ).toMatchObject({ kind: "oauth_client", clientId: "Iv1.abc" });
  });

  it("refuses a field the kind does not take and a field it needs", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ name: "stripe-live", kind: "secret" }, "secret"],
      [{ name: "stripe-live", kind: "secret", secret: "s", clientId: "c" }, "clientId"],
      [{ name: "github-app", kind: "oauth_client", clientId: "c" }, "clientSecret"],
      [{ name: "github-app", kind: "oauth_client", clientSecret: "s" }, "clientId"],
      [{ name: "github-app", kind: "oauth_client", clientId: "c", clientSecret: "s", secret: "s" }, "secret"],
    ];
    for (const [input, field] of cases) {
      const result = toolStudioCredentialSet.input.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain(field);
    }
  });

  it("refuses a name server.toml cannot reference, an empty or oversized secret, and an unknown field", () => {
    for (const input of [
      { name: "Stripe", kind: "secret", secret: "s" },
      { name: "-stripe", kind: "secret", secret: "s" },
      { name: "a".repeat(64), kind: "secret", secret: "s" },
      { name: "stripe", kind: "secret", secret: "" },
      { name: "stripe", kind: "secret", secret: "s".repeat(STUDIO_CREDENTIAL_SECRET_MAX + 1) },
      { name: "stripe", kind: "secret", secret: "s", scope: "org" },
      { name: "stripe", kind: "token", secret: "s" },
    ]) {
      expect(toolStudioCredentialSet.input.safeParse(input).success).toBe(false);
    }
  });

  it("exposes the unrefined object for the MCP tool's argument schema", () => {
    expect(Object.keys(toolStudioCredentialSetInputObject.shape)).toEqual([
      "name",
      "kind",
      "secret",
      "clientId",
      "clientSecret",
    ]);
  });
});

describe("set_mcp_credential output", () => {
  it("names the credential and never carries a secret field", () => {
    const out = { name: "stripe-live", reference: "oxagen:credential/stripe-live", created: true };
    expect(toolStudioCredentialSet.output.parse(out)).toEqual(out);
    expect(Object.keys(toolStudioCredentialSet.output.shape)).toEqual(["name", "reference", "created"]);
  });
});
