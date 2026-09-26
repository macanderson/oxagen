import { describe, expect, it } from "vitest";
import type { NamedRuntime } from "@/data/contracts/runtimes";
import {
  AgentForm,
  agentFieldErrors,
  agentKeyOf,
  agentSlugFromName,
  HARNESSES,
  holderOf,
  WRAP_TABS,
  wrapTabFor,
} from "./agent-form";

const VALID = {
  name: "Mac's Claude",
  slug: "macs-claude",
  harness: "claude-code",
  runtimeId: "rtm_macslaptop",
  toolbeltId: "",
};

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
    const parsed = AgentForm.safeParse({ ...VALID, harness: "codex-cli" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("agentHarnessInvalid");
  });
});

describe("AgentForm", () => {
  it("takes a name, a slug, a harness, a runtime and the All tools belt", () => {
    expect(AgentForm.safeParse(VALID).success).toBe(true);
    expect(
      AgentForm.safeParse({ ...VALID, toolbeltId: "tbt_reviewbelt" }).success,
    ).toBe(true);
  });

  it("refuses a registration with no runtime chosen (negative)", () => {
    const parsed = AgentForm.safeParse({ ...VALID, runtimeId: "" });
    expect(parsed.success).toBe(false);
    expect(agentFieldErrors(parsed.error?.issues ?? [])).toEqual({
      runtimeId: "agentRuntimeRequired",
    });
  });

  it("refuses a slug over 18 characters (negative)", () => {
    const parsed = AgentForm.safeParse({ ...VALID, slug: "a".repeat(19) });
    expect(agentFieldErrors(parsed.error?.issues ?? [])).toEqual({
      slug: "agentSlugInvalid",
    });
  });
});

describe("agentSlugFromName", () => {
  it("drops apostrophes and special characters and cuts to 18 characters", () => {
    expect(agentSlugFromName("Mac's Claude")).toBe("macs-claude");
    expect(agentSlugFromName("R&D review bot for the platform")).toBe(
      "rd-review-bot-for",
    );
  });
});

describe("holderOf", () => {
  const runtime: NamedRuntime = {
    id: "rtm_macslaptop",
    name: "Mac's laptop",
    slug: "macs-laptop",
    createdAt: "2026-09-20T10:00:00.000Z",
    agents: [
      {
        id: "agt_macclaude",
        name: "Mac Claude",
        slug: "mac-claude",
        harness: "claude-code",
      },
    ],
    liveHosts: 1,
    lastSeenAt: null,
  };

  it("names the agent that already runs the harness on the runtime", () => {
    expect(holderOf(runtime, "claude-code")?.slug).toBe("mac-claude");
  });

  it("answers null for a free pair, or when either side is not chosen", () => {
    expect(holderOf(runtime, "codex")).toBeNull();
    expect(holderOf(runtime, null)).toBeNull();
    expect(holderOf(undefined, "claude-code")).toBeNull();
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
