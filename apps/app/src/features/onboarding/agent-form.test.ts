import { describe, expect, it } from "vitest";
import { HARNESSES, wrapPathOf } from "./agent-form";

describe("wrapPathOf", () => {
  it("enrols a host for every harness Tacho hooks", () => {
    for (const harness of [
      "claude-code",
      "codex",
      "cursor",
      "stella",
    ] as const) {
      expect(wrapPathOf(harness), harness).toBe("host");
    }
  });

  it("marks harnesses without an adapter unavailable", () => {
    for (const harness of ["claude-agent-sdk", "custom"] as const) {
      expect(wrapPathOf(harness), harness).toBe("unavailable");
    }
  });

  it("offers codex and cursor in the register form", () => {
    expect(HARNESSES).toContain("codex");
    expect(HARNESSES).toContain("cursor");
  });
});

it("offers only the four harnesses with installed host adapters", () => {
  expect(HARNESSES).toEqual(["claude-code", "codex", "cursor", "stella"]);
});
