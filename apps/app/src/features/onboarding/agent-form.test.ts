import { describe, expect, it } from "vitest";
import { HARNESSES, wrapPathOf } from "./agent-form";

describe("wrapPathOf", () => {
  it("enrols a host for every harness Tacho hooks", () => {
    for (const harness of ["claude-code", "codex", "cursor"] as const) {
      expect(wrapPathOf(harness), harness).toBe("host");
    }
  });

  it("wraps the rest in the agent's own process", () => {
    for (const harness of ["stella", "claude-agent-sdk", "custom"] as const) {
      expect(wrapPathOf(harness), harness).toBe("sdk");
    }
  });

  it("offers codex and cursor in the register form", () => {
    expect(HARNESSES).toContain("codex");
    expect(HARNESSES).toContain("cursor");
  });
});
