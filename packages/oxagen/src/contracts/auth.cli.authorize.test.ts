import { describe, expect, it } from "vitest";
import { authCliAuthorize } from "./auth.cli.authorize";
import { getCapability } from "../registry";
import { getSurfaces } from "../types";

const VALID_INPUT = {
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  codeChallengeMethod: "S256",
  redirectUri: "http://127.0.0.1:53682/callback",
  label: "Oxagen CLI",
  state: "st_8f2a",
} as const;

describe("auth.cli.authorize capability", () => {
  it("is registered under its verb-first name", () => {
    expect(getCapability("authorize_cli")).toBe(authCliAuthorize);
  });

  it("is a scoped, unmetered write on no API or MCP surface, for org Owner and Admin", () => {
    expect(authCliAuthorize.mutates).toBe(true);
    expect(authCliAuthorize.scoped).toBe(true);
    expect(authCliAuthorize.noBillingGate).toBe(true);
    expect(authCliAuthorize.surfaces).toEqual([]);
    // An explicit empty list is what keeps the kernel's default pair off it.
    expect(getSurfaces(authCliAuthorize)).toEqual([]);
    // WL-50 added "app": /cli/authorize is a real page a person lands on.
    expect(authCliAuthorize.layers).toEqual(["schema", "unit", "docs", "app"]);
    expect(authCliAuthorize.sensitivity).toBe("high");
    expect(authCliAuthorize.defaultEffect).toBe("deny");
    expect(authCliAuthorize.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("parses a valid PKCE request", () => {
    expect(authCliAuthorize.input.parse(VALID_INPUT)).toEqual(VALID_INPUT);
  });

  it("trims the label", () => {
    const parsed = authCliAuthorize.input.parse({
      ...VALID_INPUT,
      label: "  my laptop  ",
    });
    expect(parsed.label).toBe("my laptop");
  });

  it.each([
    ["plain as the method", { codeChallengeMethod: "plain" }],
    ["a challenge shorter than 43 chars", { codeChallenge: "abc" }],
    [
      "a challenge with base64 padding",
      { codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c=" },
    ],
    ["an empty redirectUri", { redirectUri: "" }],
    ["an empty state", { state: "" }],
    ["a blank label", { label: "   " }],
    ["a label over 120 chars", { label: "x".repeat(121) }],
  ])("rejects %s", (_name, override) => {
    expect(
      authCliAuthorize.input.safeParse({ ...VALID_INPUT, ...override }).success,
    ).toBe(false);
  });

  it("outputs only the code", () => {
    expect(authCliAuthorize.output.parse({ code: "c0de" })).toEqual({
      code: "c0de",
    });
    expect(authCliAuthorize.output.safeParse({}).success).toBe(false);
  });
});
