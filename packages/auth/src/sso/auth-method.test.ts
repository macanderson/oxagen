import { describe, expect, it } from "vitest";
import { authMethodForPath, ssoAuthMethod } from "./auth-method";

describe("authMethodForPath", () => {
  it.each([
    ["/sso/callback/:providerId", { providerId: "acme" }, "sso:acme"],
    ["/sso/saml2/sp/acs/:providerId", { providerId: "acme" }, "sso:acme"],
    ["/sso/saml2/callback/:providerId", { providerId: "acme" }, "sso:acme"],
    ["/sso/callback", {}, "other"],
    ["/sign-in/email", undefined, "password"],
    ["/sign-up/email", undefined, "password"],
    ["/two-factor/verify-totp", undefined, "password"],
    ["/callback/:id", { id: "google" }, "social:google"],
    ["/callback/github", undefined, "social:github"],
    ["/magic", undefined, "other"],
    [undefined, undefined, "other"],
  ])("%s → %s", (path, params, expected) => {
    expect(authMethodForPath(path as string | undefined, params)).toBe(
      expected,
    );
  });

  it("formats an SSO method", () => {
    expect(ssoAuthMethod("okta")).toBe("sso:okta");
  });
});
