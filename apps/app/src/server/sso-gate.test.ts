import { describe, expect, it } from "vitest";
import { routes } from "@/shared/safe-path";
import {
  evaluateSsoGate,
  type SsoPolicy,
  ssoGateApplies,
  ssoSignInPath,
} from "./sso-gate";

const required: SsoPolicy = {
  ssoRequired: true,
  providerIds: ["acme-okta", "acme-entra"],
};

const deny = { action: "sso", reason: "session_not_sso" } as const;
const allow = { action: "allow" } as const;

describe("evaluateSsoGate", () => {
  it("allows everyone when the organization has no policy", () => {
    expect(
      evaluateSsoGate({ role: "member", policy: null, authMethod: "password" }),
    ).toEqual(allow);
  });

  it("allows a password session when SSO is not required", () => {
    expect(
      evaluateSsoGate({
        role: "member",
        policy: { ssoRequired: false, providerIds: ["acme-okta"] },
        authMethod: "password",
      }),
    ).toEqual(allow);
  });

  it("allows a session from one of the organization's verified providers", () => {
    expect(
      evaluateSsoGate({
        role: "admin",
        policy: required,
        authMethod: "sso:acme-entra",
      }),
    ).toEqual(allow);
  });

  it.each([
    ["a password session", "password"],
    ["a social session", "social:google"],
    ["another method", "other"],
    ["a stale session with no recorded method", null],
    ["another organization's provider", "sso:globex-okta"],
    ["an SSO method naming no provider", "sso:"],
    ["a provider id that only shares a prefix", "sso:acme-okta-old"],
  ])("sends %s to SSO", (_label, authMethod) => {
    expect(
      evaluateSsoGate({ role: "member", policy: required, authMethod }),
    ).toEqual(deny);
  });

  it("sends every session to SSO when no provider is verified yet", () => {
    expect(
      evaluateSsoGate({
        role: "member",
        policy: { ssoRequired: true, providerIds: [] },
        authMethod: "sso:acme-okta",
      }),
    ).toEqual(deny);
  });

  it.each(["owner", "Owner", "OWNER"])(
    "lets the %s through on a password session (break-glass)",
    (role) => {
      expect(
        evaluateSsoGate({ role, policy: required, authMethod: "password" }),
      ).toEqual(allow);
    },
  );

  it("does not exempt an admin", () => {
    expect(
      evaluateSsoGate({ role: "Admin", policy: required, authMethod: null }),
    ).toEqual(deny);
  });

  it("fails closed for an unresolved role", () => {
    expect(
      evaluateSsoGate({ role: null, policy: required, authMethod: "password" }),
    ).toEqual(deny);
  });
});

describe("ssoGateApplies", () => {
  it("applies only when SSO is required and the role is not an owner", () => {
    expect(ssoGateApplies("member", required)).toBe(true);
    expect(ssoGateApplies("owner", required)).toBe(false);
    expect(ssoGateApplies("member", null)).toBe(false);
    expect(
      ssoGateApplies("member", { ssoRequired: false, providerIds: [] }),
    ).toBe(false);
  });
});

describe("ssoSignInPath", () => {
  it("is the login page with the SSO notice, carrying the page asked for", () => {
    expect(ssoSignInPath()).toBe("/login?sso=required");
    expect(ssoSignInPath(routes.people("acme"))).toBe(
      "/login?next=%2Facme&sso=required",
    );
  });
});
