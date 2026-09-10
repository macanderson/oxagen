import { describe, expect, it } from "vitest";
import { orgModelCredentialDelete } from "./org.model_credential.delete";
import { getCapability } from "../registry";

describe("org.model_credential.delete capability", () => {
  it("is registered under the ADR-025 verb-first name", () => {
    expect(getCapability("delete_model_credential")).toBe(
      orgModelCredentialDelete,
    );
  });

  it("takes no input", () => {
    expect(orgModelCredentialDelete.input.parse({})).toEqual({});
  });

  it("returns the same REDACTED view as the read capability", () => {
    const out = orgModelCredentialDelete.output.parse({
      configured: false,
      provider: null,
      status: null,
      keyHint: null,
      lastVerifiedAt: null,
      rotatedAt: null,
      // A handler bug that echoed the removed key — stripped by the schema.
      apiKey: "sk-or-v1-s3cret",
    });
    expect(out.configured).toBe(false);
    expect(out).not.toHaveProperty("apiKey");
    expect(JSON.stringify(out)).not.toContain("s3cret");
  });

  it("is governed: org-admin only, high sensitivity, deny by default, no billing gate", () => {
    expect(orgModelCredentialDelete.scoped).toBe(false);
    expect(orgModelCredentialDelete.sensitivity).toBe("high");
    expect(orgModelCredentialDelete.defaultEffect).toBe("deny");
    expect(orgModelCredentialDelete.noBillingGate).toBe(true);
    expect(orgModelCredentialDelete.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(orgModelCredentialDelete.surfaces).toEqual(["api", "mcp"]);
  });

  it("is NOT an agent tool: the in-app agent must not move its own turns onto the platform key", () => {
    expect("agent" in orgModelCredentialDelete).toBe(false);
  });
});
