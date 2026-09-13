import { describe, expect, it } from "vitest";
import {
  AgentKey,
  Avatar,
  CommitSha,
  ConsequenceTag,
  Day,
  Digest,
  Instant,
  Ratio,
  Severity,
  Slug,
  STARTER_CONSEQUENCE_TAGS,
  ToolPattern,
  ToolVersionRef,
} from "./common";

const accepts = (
  schema: { safeParse(v: unknown): { success: boolean } },
  value: unknown,
) => schema.safeParse(value).success;

describe("scalar guards", () => {
  it.each([
    [
      AgentKey,
      "acme.core.release-manager",
      ["acme.core", "Acme.core.x", "acme..x", "acme.core.release manager"],
    ],
    [
      ToolVersionRef,
      "github__create_release@2",
      [
        "github__create_release",
        "github__create_release@",
        "@2",
        "claude_code__Bash@v2",
      ],
    ],
    [ToolPattern, "github__*@*", ["github__*@", "*@*@*", "a b"]],
    [
      Digest,
      "sha256:9f14c2…",
      ["9f14c2", "sha256:", "sha256:pending", "md5:abcd"],
    ],
    [CommitSha, "a4c91e2", ["a4c91e", "zzzzzzz", "A4C91E2"]],
    [Slug, "core-platform", ["Core", "-core", "core platform", ""]],
    [
      Instant,
      "2026-09-11T09:14:02Z",
      ["2026-09-11 09:14:02", "09:14:02", "2026-09-11"],
    ],
    [Day, "2026-09-11", ["2026-9-11", "2026-09-11T00:00:00Z"]],
    [ConsequenceTag, "moves_money", ["Moves_money", "moves-money", ""]],
  ] as const)(
    "%o accepts its form and rejects the rest (negative)",
    (schema, good, bad) => {
      expect(accepts(schema, good)).toBe(true);
      for (const value of bad) expect(accepts(schema, value)).toBe(false);
    },
  );

  it("bounds ratios and severities", () => {
    expect(accepts(Ratio, 0.83)).toBe(true);
    expect(accepts(Ratio, 1.36)).toBe(false);
    expect(accepts(Ratio, -0.1)).toBe(false);
    expect(accepts(Severity, 10)).toBe(true);
    expect(accepts(Severity, 5)).toBe(false);
    expect(accepts(Severity, "critical")).toBe(false);
  });

  it("carries the spec's starter consequence tags, and each is a valid tag", () => {
    expect(STARTER_CONSEQUENCE_TAGS).toContain("moves_money");
    for (const tag of STARTER_CONSEQUENCE_TAGS)
      expect(accepts(ConsequenceTag, tag)).toBe(true);
  });

  it("draws avatars only from the house tones", () => {
    expect(
      accepts(Avatar, { kind: "icon", icon: "rocket", tone: "solid" }),
    ).toBe(true);
    expect(
      accepts(Avatar, {
        kind: "initials",
        text: "MB",
        font: "sans",
        tone: "soft",
      }),
    ).toBe(true);
    expect(
      accepts(Avatar, { kind: "icon", icon: "rocket", tone: "#ff0000" }),
    ).toBe(false);
    expect(
      accepts(Avatar, {
        kind: "initials",
        text: "TOOLONG",
        font: "sans",
        tone: "soft",
      }),
    ).toBe(false);
    expect(accepts(Avatar, { kind: "emoji", text: "🚀" })).toBe(false);
  });
});
