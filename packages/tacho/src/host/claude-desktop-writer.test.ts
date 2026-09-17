import { describe, expect, it } from "vitest";
import {
  CLAUDE_DESKTOP_PLATFORMS,
  CLAUDE_DESKTOP_RESTART_NOTE,
  claudeDesktopConfigPath,
  claudeDesktopPresence,
  mergeClaudeDesktopConfig,
  stripClaudeDesktopConfig,
} from "./claude-desktop-writer";
import {
  type GatewayInstallConfig,
  OXAGEN_MCP_SERVER_KEY,
} from "./mcp-config-writer";

const ENROLLMENT = "tch_abcdefghijklmnopqrstuv";

const config: GatewayInstallConfig = {
  enrollmentId: ENROLLMENT,
  port: 45231,
  localToken: "local-token-0123456789abcdef",
  shimCommand: "/Applications/Oxagen.app/Contents/Resources/tacho",
};

describe("config path", () => {
  it("is the documented macOS path", () => {
    expect(claudeDesktopConfigPath("darwin", "/Users/kim")).toBe(
      "/Users/kim/Library/Application Support/Claude/claude_desktop_config.json",
    );
  });

  it("is the documented Windows path, honouring a roaming APPDATA", () => {
    expect(
      claudeDesktopConfigPath("win32", "C:\\Users\\kim", {
        APPDATA: "C:\\Users\\kim\\AppData\\Roaming",
      }),
    ).toContain("Claude");
    expect(
      claudeDesktopConfigPath("win32", "C:\\Users\\kim", {
        APPDATA: "\\\\server\\profiles\\kim\\AppData\\Roaming",
      }),
    ).toContain("server");
  });

  it("falls back to the default APPDATA when the variable is unset", () => {
    expect(claudeDesktopConfigPath("win32", "C:\\Users\\kim", {})).toContain(
      "AppData",
    );
  });

  it("has no Linux path, because Anthropic ships no Linux build", () => {
    // Writing a config for a binary that does not exist would enroll a
    // harness that can never report, which reads as a broken host rather
    // than an unavailable one.
    expect(claudeDesktopConfigPath("linux", "/home/kim")).toBeUndefined();
    expect(
      claudeDesktopConfigPath("freebsd" as NodeJS.Platform, "/home/kim"),
    ).toBeUndefined();
    expect(CLAUDE_DESKTOP_PLATFORMS).toEqual(["darwin", "win32"]);
  });
});

describe("the entry it writes", () => {
  it("is stdio, because this file takes nothing else", () => {
    const merged = mergeClaudeDesktopConfig({}, config);
    const entry = merged.config.mcpServers?.[OXAGEN_MCP_SERVER_KEY];
    expect(entry?.command).toBe(
      "/Applications/Oxagen.app/Contents/Resources/tacho",
    );
    expect(entry?.args?.[0]).toBe("mcp-stdio");
    // No url/type: Claude Desktop's config file documents neither, and an
    // entry carrying them would be silently ignored.
    expect(entry).not.toHaveProperty("url");
    expect(entry).not.toHaveProperty("type");
  });

  it("keeps the bearer out of the process listing", () => {
    const entry = mergeClaudeDesktopConfig({}, config).config.mcpServers?.[
      OXAGEN_MCP_SERVER_KEY
    ];
    expect(entry?.env?.["TACHO_LOCAL_TOKEN"]).toBe(config.localToken);
    expect(JSON.stringify(entry?.args)).not.toContain(config.localToken);
  });

  it("tells the user to restart, in plain words", () => {
    expect(CLAUDE_DESKTOP_RESTART_NOTE).toContain("Quit Claude Desktop");
    expect(CLAUDE_DESKTOP_RESTART_NOTE).toContain("next launch");
  });
});

describe("a real config survives a round trip", () => {
  /** What a user who already uses MCP actually has in this file. */
  const theirs = () => ({
    globalShortcut: "Ctrl+Space",
    mcpServers: {
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/kim"],
      },
      github: {
        command: "docker",
        args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],
        env: { GITHUB_TOKEN: "ghp_theirs" },
      },
    },
  });

  it("enroll adds one server and changes nothing else", () => {
    const before = theirs();
    const merged = mergeClaudeDesktopConfig(before, config);
    expect(Object.keys(merged.config.mcpServers ?? {}).sort()).toEqual([
      "filesystem",
      "github",
      "oxagen",
    ]);
    expect(merged.config.mcpServers?.["github"]).toEqual(
      before.mcpServers.github,
    );
    expect(merged.config["globalShortcut"]).toBe("Ctrl+Space");
  });

  it("unenroll removes exactly what enroll wrote and nothing else", () => {
    const before = theirs();
    const merged = mergeClaudeDesktopConfig(before, config);
    const stripped = stripClaudeDesktopConfig(
      merged.config,
      ENROLLMENT,
      merged.displaced,
    );
    expect(stripped.config).toEqual(before);
  });

  it("re-enrolling in a new workspace replaces our entry in place", () => {
    const first = mergeClaudeDesktopConfig(theirs(), config);
    const second = mergeClaudeDesktopConfig(first.config, {
      ...config,
      enrollmentId: "tch_zyxwvutsrqponmlkjihgfe",
    });
    expect(Object.keys(second.config.mcpServers ?? {})).toHaveLength(3);
    expect(
      (second.config.mcpServers?.["oxagen"]?.args ?? []).join(" "),
    ).toContain("tch_zyxwvutsrqponmlkjihgfe");
  });

  it("enroll twice is enroll once", () => {
    const once = mergeClaudeDesktopConfig(theirs(), config);
    const twice = mergeClaudeDesktopConfig(once.config, config);
    expect(twice.changed).toBe(false);
  });
});

describe("presence reports the size of the gap, not just our own entry", () => {
  it("names the servers that route around Oxagen", () => {
    const merged = mergeClaudeDesktopConfig(
      {
        mcpServers: {
          filesystem: { command: "npx" },
          slack: { command: "npx" },
        },
      },
      config,
    );
    const presence = claudeDesktopPresence(merged.config, ENROLLMENT);
    expect(presence.present).toBe(true);
    // ADR-078 §3: the operator is entitled to know how much of this app we
    // do not see, because nothing in code can close that gap.
    expect(presence.otherServers).toBe(2);
    expect(presence.otherServerNames.sort()).toEqual(["filesystem", "slack"]);
  });

  it("reports absent before enrollment", () => {
    expect(claudeDesktopPresence({}, ENROLLMENT).present).toBe(false);
  });
});
