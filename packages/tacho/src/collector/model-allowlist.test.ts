/**
 * The model allow and deny lists the loopback proxy refuses on.
 *
 * Three things here are load-bearing and each is asserted rather than left to
 * reading the regex:
 *
 *   1. `allow: null` and `allow: []` are different decisions. Collapsing them
 *      would make "permit nothing" mean "permit everything", which is the
 *      fail-open the bundle's `gateway_tools` note describes.
 *   2. A model the proxy could not read is permitted. An unreadable body is
 *      not evidence of a forbidden model, and refusing on one would take out
 *      every non-JSON call the proxy forwards untouched.
 *   3. Deny beats allow, and the trailing `*` is a prefix and not a glob.
 */
import { describe, expect, it } from "vitest";
import { modelVerdict } from "./model-allowlist";

/** Whether the allowlist `[pattern]` lets `model` through. */
const permits = (pattern: string, model: string) =>
  modelVerdict({ allow: [pattern], deny: [] }, model) === undefined;

describe("how a pattern matches", () => {
  it("matches an exact id, ignoring case", () => {
    expect(permits("claude-opus-5", "claude-opus-5")).toBe(true);
    expect(permits("Claude-Opus-5", "claude-opus-5")).toBe(true);
    expect(permits("claude-opus-5", "claude-opus-5-20260101")).toBe(false);
  });

  it("matches by prefix on a trailing star, and only on a trailing star", () => {
    expect(permits("claude-opus-*", "claude-opus-5-20260101")).toBe(true);
    expect(permits("claude-opus-*", "claude-sonnet-5")).toBe(false);
    // Not a glob: a star anywhere else is an ordinary character, so a policy
    // that reads like a wildcard and is not one matches nothing rather than
    // quietly permitting a family.
    expect(permits("claude-*-5", "claude-opus-5")).toBe(false);
  });

  it("treats a bare star as every model", () => {
    expect(permits("*", "anything-at-all")).toBe(true);
  });
});

describe("modelVerdict", () => {
  it("permits every model when no policy and no allowlist are stated", () => {
    expect(modelVerdict(undefined, "claude-opus-5")).toBeUndefined();
    expect(
      modelVerdict({ allow: null, deny: [] }, "claude-opus-5"),
    ).toBeUndefined();
  });

  it("refuses every model on an allowlist that permits nothing", () => {
    expect(modelVerdict({ allow: [], deny: [] }, "claude-opus-5")).toBe(
      "not_allowed",
    );
  });

  it("permits a model on the allowlist and refuses one off it", () => {
    const policy = { allow: ["claude-opus-*", "gpt-5"], deny: [] };
    expect(modelVerdict(policy, "claude-opus-5")).toBeUndefined();
    expect(modelVerdict(policy, "gpt-5")).toBeUndefined();
    expect(modelVerdict(policy, "gpt-4o")).toBe("not_allowed");
  });

  it("lets a deny beat an allow, and says which it was", () => {
    const policy = { allow: ["claude-opus-*"], deny: ["claude-opus-5-legacy"] };
    expect(modelVerdict(policy, "claude-opus-5-legacy")).toBe("denied");
    expect(modelVerdict(policy, "claude-opus-5")).toBeUndefined();
  });

  it("permits a call whose model it could not read", () => {
    // Negative control: the strictest policy there is, and an unknown model
    // still passes. The alternative refuses calls nobody has shown to be
    // against policy.
    expect(modelVerdict({ allow: [], deny: ["*"] }, undefined)).toBeUndefined();
  });
});
