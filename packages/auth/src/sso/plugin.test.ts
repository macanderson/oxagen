import { describe, expect, it } from "vitest";
import { SSO_DISABLED_PATHS, buildSsoPlugin } from "./plugin";

function options() {
  const plugin = buildSsoPlugin({ provisionUser: async () => undefined }) as {
    id: string;
    options?: {
      provisionUserOnEveryLogin?: boolean;
      organizationProvisioning?: { disabled?: boolean };
      domainVerification?: { enabled?: boolean };
      saml?: {
        allowIdpInitiated?: boolean;
        requireTimestamps?: boolean;
        algorithms?: { onDeprecated?: string };
      };
    };
  };
  expect(plugin.id).toBe("sso");
  return plugin.options!;
}

describe("buildSsoPlugin", () => {
  it("maps groups on every sign-in and leaves Better Auth's org plugin alone", () => {
    const o = options();
    expect(o.provisionUserOnEveryLogin).toBe(true);
    expect(o.organizationProvisioning?.disabled).toBe(true);
    expect(o.domainVerification?.enabled).toBe(true);
  });

  it("hardens SAML: no IdP-initiated responses, timestamps required, deprecated algorithms refused", () => {
    const saml = options().saml!;
    expect(saml.allowIdpInitiated).toBe(false);
    expect(saml.requireTimestamps).toBe(true);
    expect(saml.algorithms?.onDeprecated).toBe("reject");
  });

  it("disables every provider-management endpoint", () => {
    expect([...SSO_DISABLED_PATHS].sort()).toEqual([
      "/sso/delete-provider",
      "/sso/get-provider",
      "/sso/providers",
      "/sso/register",
      "/sso/request-domain-verification",
      "/sso/update-provider",
      "/sso/verify-domain",
    ]);
  });
});
