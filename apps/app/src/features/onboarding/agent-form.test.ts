import { describe, expect, it } from "vitest";
import {
  AgentForm,
  agentKeyOf,
  HARNESSES,
  nameFromSlug,
  WRAP_TABS,
  wrapTabFor,
} from "./agent-form";

describe("the harness list", () => {
  it("offers every harness register_agent accepts, the four wrapped ones first", () => {
    expect(HARNESSES).toEqual([
      "claude-code",
      "codex",
      "cursor",
      "stella",
      "claude-agent-sdk",
      "custom",
    ]);
  });

  it("refuses a harness the contract does not know (negative)", () => {
    const parsed = AgentForm.safeParse({
      slug: "perf-watch",
      name: "Perf watch",
      description: "",
      harness: "codex-cli",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("agentHarnessInvalid");
  });
});

describe("wrapTabFor", () => {
  it("opens each hook-based harness on its own tab", () => {
    expect(wrapTabFor("claude-code")).toBe("claude-code");
    expect(wrapTabFor("codex")).toBe("codex");
    expect(wrapTabFor("cursor")).toBe("cursor");
  });

  it.each(["stella", "claude-agent-sdk", "custom"] as const)(
    "sends %s to the SDK tab, as the design's regTabFor does",
    (harness) => {
      expect(wrapTabFor(harness)).toBe("sdk");
    },
  );

  it("draws the tabs in the design's order with Cursor beside Codex CLI", () => {
    expect(WRAP_TABS).toEqual(["claude-code", "codex", "cursor", "sdk"]);
  });
});

describe("agentKeyOf", () => {
  it("normalises the slug live: lower case, hyphens for anything else, trimmed", () => {
    expect(agentKeyOf("a-intel.core", "Perf Watch")).toBe(
      "a-intel.core.perf-watch",
    );
    expect(agentKeyOf("a-intel.core", "--perf__watch--")).toBe(
      "a-intel.core.perf-watch",
    );
  });

  it("reads `agent` while the slug is empty", () => {
    expect(agentKeyOf("a-intel.core", "   ")).toBe("a-intel.core.agent");
  });
});

describe("nameFromSlug", () => {
  it("writes the slug in words for the display name register_agent requires", () => {
    expect(nameFromSlug("perf-watch")).toBe("Perf watch");
    expect(nameFromSlug("release-bot-2")).toBe("Release bot 2");
  });
});
