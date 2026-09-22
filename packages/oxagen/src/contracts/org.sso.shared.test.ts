import { describe, expect, it } from "vitest";
import {
  RESERVED_SSO_PROVIDER_IDS,
  normalizeSsoGroups,
  resolveSsoGrantedRole,
  ssoProviderIdSchema,
} from "./org.sso.shared";

describe("ssoProviderIdSchema", () => {
  it("accepts a slug", () => {
    expect(ssoProviderIdSchema.safeParse("acme-okta").success).toBe(true);
  });

  // An SSO provider sharing an id with another account source could sign in
  // as that source's users: Better Auth matches (providerId, accountId).
  it.each(["credential", "github", "google", "microsoft", "email-otp"])(
    "refuses %s, an id another sign-in method uses",
    (id) => {
      expect(RESERVED_SSO_PROVIDER_IDS.has(id)).toBe(true);
      expect(ssoProviderIdSchema.safeParse(id).success).toBe(false);
    },
  );

  it.each(["Acme", "-acme", "a", "acme_okta"])(
    "refuses the malformed id %s",
    (id) => {
      expect(ssoProviderIdSchema.safeParse(id).success).toBe(false);
    },
  );
});

describe("resolveSsoGrantedRole", () => {
  const mappings = [
    { group: "all", role: "member" as const },
    { group: "fin", role: "billing" as const },
    { group: "ops", role: "admin" as const },
  ];

  it("grants the highest-ranked mapped role", () => {
    expect(resolveSsoGrantedRole(["all", "ops", "fin"], mappings)).toBe(
      "admin",
    );
  });

  it("grants nothing for unmapped groups or no groups", () => {
    expect(resolveSsoGrantedRole(["eng"], mappings)).toBeNull();
    expect(resolveSsoGrantedRole([], mappings)).toBeNull();
  });

  it("matches group names case-sensitively", () => {
    expect(resolveSsoGrantedRole(["OPS"], mappings)).toBeNull();
  });
});

describe("normalizeSsoGroups", () => {
  it("reads an array, a comma-separated string, and ignores anything else", () => {
    expect(normalizeSsoGroups(["a", " b ", "a", 3, ""])).toEqual(["a", "b"]);
    expect(normalizeSsoGroups("a, b")).toEqual(["a", "b"]);
    expect(normalizeSsoGroups(undefined)).toEqual([]);
    expect(normalizeSsoGroups({ groups: ["a"] })).toEqual([]);
  });
});
