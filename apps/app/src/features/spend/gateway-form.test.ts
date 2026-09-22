/**
 * `GatewayPolicyForm`: the Spend page's gateway fields as
 * `update_tacho_session_policy` takes them.
 *
 * Tested directly rather than only through the dialog, because this parser is
 * the first of three layers that enforce the same two rules (the handler and
 * a check constraint are the others) and it is the only one that can say
 * which field is wrong while a person is still looking at it.
 *
 * The rule that matters most: a blank allowlist box means *no allowlist*, so
 * every model is permitted, and it reaches the contract as `null`. An empty
 * array would mean the opposite. Getting that backwards would turn the
 * laxest policy into the strictest, or the other way round.
 */
import { describe, expect, it } from "vitest";
import { GatewayPolicyForm, gatewayFieldErrors } from "./forms";

/** The observed-only values a freshly opened dialog holds. */
const BLANK = {
  mode: "observed" as const,
  sessionLimit: "",
  modelAllow: "",
  modelDeny: "",
};

/** The first issue's message, or "" when the parse succeeded. */
function refusal(values: Parameters<typeof GatewayPolicyForm.parse>[0]) {
  const parsed = GatewayPolicyForm.safeParse(values);
  return parsed.success ? "" : (parsed.error.issues[0]?.message ?? "?");
}

describe("GatewayPolicyForm", () => {
  it("reads a blank allowlist as no allowlist, not an empty one", () => {
    const parsed = GatewayPolicyForm.parse(BLANK);
    expect(parsed.modelAllow).toBeNull();
    expect(parsed.modelDeny).toEqual([]);
    expect(parsed.sessionLimitUsd).toBeNull();
  });

  it("splits a filled box on newlines and drops blank lines and padding", () => {
    const parsed = GatewayPolicyForm.parse({
      ...BLANK,
      modelAllow: "  claude-opus-*  \n\n gpt-5 \n",
      modelDeny: "gpt-4o",
    });
    expect(parsed.modelAllow).toEqual(["claude-opus-*", "gpt-5"]);
    expect(parsed.modelDeny).toEqual(["gpt-4o"]);
  });

  it("reads the ceiling as a number and a blank one as no ceiling", () => {
    expect(
      GatewayPolicyForm.parse({ ...BLANK, sessionLimit: "25.50" })
        .sessionLimitUsd,
    ).toBe(25.5);
    expect(
      GatewayPolicyForm.parse({ ...BLANK, sessionLimit: "   " })
        .sessionLimitUsd,
    ).toBeNull();
  });

  it("refuses a ceiling that is not a positive number", () => {
    for (const sessionLimit of ["0", "-1", "abc", "1e5x"])
      expect(refusal({ ...BLANK, sessionLimit })).toBe("sessionLimitInvalid");
  });

  it("refuses a model pattern the host could not apply, naming its field", () => {
    // A star anywhere but the end is not a wildcard the host honours, so a
    // rule written that way would silently match nothing.
    const allow = GatewayPolicyForm.safeParse({
      ...BLANK,
      modelAllow: "claude-*-5",
    });
    expect(allow.success).toBe(false);
    expect(allow.success === false && allow.error.issues[0]?.path).toEqual([
      "modelAllow",
    ]);
    const deny = GatewayPolicyForm.safeParse({
      ...BLANK,
      modelDeny: "gpt 4o",
    });
    expect(deny.success).toBe(false);
    expect(deny.success === false && deny.error.issues[0]?.path).toEqual([
      "modelDeny",
    ]);
  });

  it("accepts an exact id, a trailing star, and a bare star", () => {
    const parsed = GatewayPolicyForm.parse({
      ...BLANK,
      modelDeny: "gpt-4o\nclaude-opus-*\n*",
    });
    expect(parsed.modelDeny).toEqual(["gpt-4o", "claude-opus-*", "*"]);
  });

  it("refuses enforced with nothing to enforce, naming the mode", () => {
    const parsed = GatewayPolicyForm.safeParse({ ...BLANK, mode: "enforced" });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.message).toBe(
      "nothingToEnforce",
    );
    expect(parsed.success === false && parsed.error.issues[0]?.path).toEqual([
      "mode",
    ]);
  });

  it("accepts enforced on any one clause, including an allowlist of nothing", () => {
    // Three separate reasons a policy has something to enforce. The third is
    // the one a naive emptiness check gets wrong: an allowlist that permits
    // nothing is a decision, not an absent clause.
    expect(refusal({ ...BLANK, mode: "enforced", sessionLimit: "5" })).toBe("");
    expect(refusal({ ...BLANK, mode: "enforced", modelDeny: "gpt-4o" })).toBe(
      "",
    );
    expect(refusal({ ...BLANK, mode: "enforced", modelAllow: "*" })).toBe("");
  });

  it("never refuses observed, which needs no clause", () => {
    expect(refusal(BLANK)).toBe("");
  });
});

describe("gatewayFieldErrors", () => {
  it("maps both the form's path and the contract's to the same field", () => {
    // The form says `sessionLimit`; the contract, parsing again on invoke,
    // says `sessionLimitUsd`. A person sees one field either way.
    expect(gatewayFieldErrors([{ path: ["sessionLimit"] }])).toEqual({
      sessionLimit: "sessionLimitInvalid",
    });
    expect(gatewayFieldErrors([{ path: ["sessionLimitUsd"] }])).toEqual({
      sessionLimit: "sessionLimitInvalid",
    });
  });

  it("maps each list and the mode to its own key", () => {
    expect(
      gatewayFieldErrors([
        { path: ["modelAllow"] },
        { path: ["modelDeny"] },
        { path: ["mode"] },
      ]),
    ).toEqual({
      modelAllow: "modelPatternInvalid",
      modelDeny: "modelPatternInvalid",
      mode: "nothingToEnforce",
    });
  });

  it("ignores a path it does not know rather than inventing a field", () => {
    expect(gatewayFieldErrors([{ path: [] }, { path: ["surprise"] }])).toEqual(
      {},
    );
  });
});
