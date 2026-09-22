import { describe, expect, it } from "vitest";
import {
  tachoModelPatternSchema,
  tachoSessionPolicyRead,
} from "./tacho.session_policy.read";
import { getCapability } from "../registry";

describe("get_tacho_session_policy capability", () => {
  it("is registered under its name", () => {
    expect(getCapability("get_tacho_session_policy")).toBe(
      tachoSessionPolicyRead,
    );
  });

  it("is workspace-scoped, read-only, and readable by every role", () => {
    expect(tachoSessionPolicyRead.domain).toBe("tacho");
    expect(tachoSessionPolicyRead.scoped).toBe(true);
    expect(tachoSessionPolicyRead.mutates).toBe(false);
    // A person whose own session is about to be refused should be able to
    // read the reason, so Viewer reads it too.
    expect(tachoSessionPolicyRead.defaultRoles.workspace.Viewer).toBe("allow");
  });

  it("keeps a null allowlist apart from an empty one", () => {
    // `null` = no allowlist, every model permitted. `[]` = permit nothing.
    // Collapsing them would make the stricter decision the laxer one.
    const none = tachoSessionPolicyRead.output.parse({
      mode: "observed",
      sessionLimitUsd: null,
      modelAllow: null,
      modelDeny: [],
    });
    expect(none.modelAllow).toBeNull();
    const nothing = tachoSessionPolicyRead.output.parse({
      mode: "enforced",
      sessionLimitUsd: null,
      modelAllow: [],
      modelDeny: [],
    });
    expect(nothing.modelAllow).toEqual([]);
  });

  it("rejects a mode it does not know", () => {
    expect(() =>
      tachoSessionPolicyRead.output.parse({
        mode: "enforce",
        sessionLimitUsd: null,
        modelAllow: null,
        modelDeny: [],
      }),
    ).toThrow();
  });
});

describe("the model pattern", () => {
  it("accepts a model id and a trailing star", () => {
    expect(tachoModelPatternSchema.parse("claude-opus-5")).toBe(
      "claude-opus-5",
    );
    expect(tachoModelPatternSchema.parse("claude-opus-*")).toBe(
      "claude-opus-*",
    );
    expect(tachoModelPatternSchema.parse("*")).toBe("*");
  });

  it("refuses a pattern the host could not apply", () => {
    // The host matches an exact id or a trailing-star prefix and nothing
    // else. A pattern that reads like a glob and is not one would silently
    // match nothing, so it is refused at the edge instead.
    expect(() => tachoModelPatternSchema.parse("claude-*-5")).toThrow();
    expect(() => tachoModelPatternSchema.parse("claude opus")).toThrow();
    expect(() => tachoModelPatternSchema.parse("")).toThrow();
  });
});
