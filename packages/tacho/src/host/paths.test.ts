/**
 * Claude Code's two paths under an exported but empty `CLAUDE_CONFIG_DIR`,
 * resolved the way Claude Code 2.1.288 resolves them: the user config with
 * `||`, so it falls back to the home directory, and the config directory
 * with `??`, so it does not.
 */
import { describe, expect, it } from "vitest";
import { claudeConfigDirFor, claudeUserConfigFor, tachoHome } from "./paths";

describe("an empty CLAUDE_CONFIG_DIR", () => {
  it("puts .claude.json in the home directory, where Claude Code reads it", () => {
    expect(claudeUserConfigFor({ CLAUDE_CONFIG_DIR: "" }, "/home/x")).toBe(
      "/home/x/.claude.json",
    );
    expect(
      tachoHome({ CLAUDE_CONFIG_DIR: "" }, "/home/x").claudeUserConfig,
    ).toBe("/home/x/.claude.json");
    expect(claudeUserConfigFor({ CLAUDE_CONFIG_DIR: "/c" }, "/home/x")).toBe(
      "/c/.claude.json",
    );
    expect(claudeUserConfigFor({}, "/home/x")).toBe("/home/x/.claude.json");
  });

  it("keeps the config directory empty, as Claude Code does", () => {
    expect(claudeConfigDirFor({ CLAUDE_CONFIG_DIR: "" }, "/home/x")).toBe("");
    expect(claudeConfigDirFor({}, "/home/x")).toBe("/home/x/.claude");
  });
});
