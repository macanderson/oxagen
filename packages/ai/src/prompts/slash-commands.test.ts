import { describe, expect, it } from "vitest";
import {
  SLASH_COMMANDS,
  matchSlashCommands,
  slashCommandsPromptSection,
} from "./slash-commands";

describe("SLASH_COMMANDS registry", () => {
  it("every command has a unique name and a summary", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of SLASH_COMMANDS) {
      expect(c.name).toMatch(/^[a-z]+$/);
      expect(c.summary.length).toBeGreaterThan(0);
    }
  });

  it("agent-interpreted commands carry guidance; client actions do not", () => {
    for (const c of SLASH_COMMANDS) {
      if (c.clientAction) {
        expect(c.agentGuidance).toBeUndefined();
      } else {
        expect(c.agentGuidance).toBeTruthy();
      }
    }
  });

  it("exposes the expected core commands", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["pr", "diff", "ci", "repos", "pin"]),
    );
    expect(SLASH_COMMANDS.find((c) => c.name === "pin")?.clientAction).toBe(
      "pin",
    );
  });
});

describe("matchSlashCommands", () => {
  it("returns everything for an empty query", () => {
    expect(matchSlashCommands("")).toHaveLength(SLASH_COMMANDS.length);
  });

  it("prefix-filters by name (case-insensitive)", () => {
    expect(
      matchSlashCommands("p")
        .map((c) => c.name)
        .sort(),
    ).toEqual(["pin", "pr"]);
    expect(matchSlashCommands("CI").map((c) => c.name)).toEqual(["ci"]);
  });

  it("returns nothing for a non-matching prefix", () => {
    expect(matchSlashCommands("zzz")).toHaveLength(0);
  });
});

describe("slashCommandsPromptSection", () => {
  it("documents each agent-interpreted command (and omits pure client actions)", () => {
    const section = slashCommandsPromptSection();
    expect(section).toContain("## Slash commands");
    for (const c of SLASH_COMMANDS) {
      if (c.agentGuidance) {
        expect(section).toContain(`/${c.name}`);
      }
    }
    // `/pin` is a client-only action, so it isn't given agent guidance in the
    // prompt table.
    expect(section).not.toContain("`/pin`");
  });
});
