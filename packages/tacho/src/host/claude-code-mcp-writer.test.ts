/**
 * The Oxagen MCP server in Claude Code's user config (#5287): the merge adds
 * one entry and changes nothing else in a file that holds all of Claude
 * Code's state, a second merge changes nothing, and the strip takes out only
 * this enrollment's entry and puts back a server it displaced.
 */
import { describe, expect, it } from "vitest";
import {
  claudeCodeMcpPresence,
  claudeUserConfigShapeProblem,
  mergeClaudeCodeMcpConfig,
  stripClaudeCodeMcpConfig,
} from "./claude-code-mcp-writer";
import type { GatewayInstallConfig } from "./mcp-config-writer";
import { TEST_ENROLLMENT } from "./test-support";

const OTHER_ENROLLMENT = "tch_zyxwvutsrqpnmkjhgfedcb";

const CONFIG: GatewayInstallConfig = {
  enrollmentId: TEST_ENROLLMENT,
  port: 47123,
  localToken: "local-token-0123456789abcdef",
  shimCommand: "/Applications/Oxagen.app/Contents/MacOS/oxagen",
};

/** The shape of a real `~/.claude.json`: much more than MCP servers. */
function userConfig(servers: Record<string, unknown> = {}) {
  return {
    numStartups: 412,
    installMethod: "native",
    autoUpdates: true,
    hasCompletedOnboarding: true,
    oauthAccount: {
      accountUuid: "11111111-2222-4333-8444-555555555555",
      emailAddress: "dev@example.com",
    },
    tipsHistory: { "new-user-warmup": 1 },
    projects: {
      "/Users/dev/code/app": {
        allowedTools: [],
        mcpServers: { local: { command: "local-server" } },
        hasTrustDialogAccepted: true,
      },
    },
    mcpServers: {
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ghp_redacted" },
      },
      motion: { type: "stdio", command: "npx", args: ["-y", "motion-mcp"] },
      zread: { type: "http", url: "https://example.test/mcp" },
      ...servers,
    },
  };
}

describe("mergeClaudeCodeMcpConfig", () => {
  it("adds the stdio shim under `oxagen`, idempotently, and keeps every other key", () => {
    const before = userConfig();
    const merged = mergeClaudeCodeMcpConfig(before, CONFIG);
    expect(merged.changed).toBe(true);
    expect(merged.displaced).toEqual({});
    const document = merged.config;
    const servers = document.mcpServers ?? {};
    expect(servers["oxagen"]).toEqual({
      command: "/Applications/Oxagen.app/Contents/MacOS/oxagen",
      args: ["mcp-stdio", "--enrollment", TEST_ENROLLMENT, "--port", "47123"],
      // The bearer travels in env, never in args, so no process listing
      // shows it.
      env: { TACHO_LOCAL_TOKEN: "local-token-0123456789abcdef" },
    });
    // Everything but `mcpServers.oxagen` is exactly what it was.
    const others = Object.fromEntries(
      Object.entries(servers).filter(([name]) => name !== "oxagen"),
    );
    expect({ ...document, mcpServers: others }).toEqual(before);
    // The input document is not changed in place.
    expect(before.mcpServers).not.toHaveProperty("oxagen");

    const again = mergeClaudeCodeMcpConfig(merged.config, CONFIG);
    expect(again.changed).toBe(false);
    expect(again.config).toEqual(merged.config);
  });

  it("writes a whole document when Claude Code has never run", () => {
    const merged = mergeClaudeCodeMcpConfig(undefined, CONFIG);
    expect(merged.changed).toBe(true);
    expect(Object.keys(merged.config)).toEqual(["mcpServers"]);
    expect(
      claudeCodeMcpPresence(merged.config, TEST_ENROLLMENT).present,
    ).toBe(true);
  });

  it("replaces another enrollment's entry without recording it as the user's", () => {
    const old = mergeClaudeCodeMcpConfig(userConfig(), {
      ...CONFIG,
      enrollmentId: OTHER_ENROLLMENT,
    }).config;
    const merged = mergeClaudeCodeMcpConfig(old, CONFIG);
    expect(merged.changed).toBe(true);
    expect(merged.displaced).toEqual({});
    expect(claudeCodeMcpPresence(merged.config, TEST_ENROLLMENT)).toMatchObject(
      { present: true, foreignEnrollment: false },
    );
  });

  it("moves a server of the user's that holds the name aside, and the strip puts it back", () => {
    const theirs = { type: "http", url: "https://mcp.oxagen.sh/mcp" };
    const before = userConfig({ oxagen: theirs });
    const merged = mergeClaudeCodeMcpConfig(before, CONFIG);
    expect(merged.displaced).toEqual({ oxagen: theirs });
    const stripped = stripClaudeCodeMcpConfig(
      merged.config,
      TEST_ENROLLMENT,
      merged.displaced,
    );
    expect(stripped.changed).toBe(true);
    expect(stripped.config).toEqual(before);
  });
});

describe("stripClaudeCodeMcpConfig", () => {
  it("takes out this enrollment's entry and nothing else", () => {
    const before = userConfig();
    const merged = mergeClaudeCodeMcpConfig(before, CONFIG);
    const stripped = stripClaudeCodeMcpConfig(merged.config, TEST_ENROLLMENT);
    expect(stripped.changed).toBe(true);
    expect(stripped.config).toEqual(before);
    // A second strip has nothing to do.
    expect(
      stripClaudeCodeMcpConfig(stripped.config, TEST_ENROLLMENT).changed,
    ).toBe(false);
  });

  it("leaves another enrollment's entry in place", () => {
    const merged = mergeClaudeCodeMcpConfig(userConfig(), CONFIG);
    const stripped = stripClaudeCodeMcpConfig(merged.config, OTHER_ENROLLMENT);
    expect(stripped.changed).toBe(false);
    expect(
      claudeCodeMcpPresence(stripped.config, TEST_ENROLLMENT).present,
    ).toBe(true);
  });

  it("leaves a server the user put under the name after enroll alone", () => {
    const merged = mergeClaudeCodeMcpConfig(userConfig(), CONFIG);
    const replaced = {
      ...(merged.config as object),
      mcpServers: {
        ...(merged.config.mcpServers ?? {}),
        oxagen: { command: "their-own-server" },
      },
    };
    const stripped = stripClaudeCodeMcpConfig(replaced, TEST_ENROLLMENT);
    expect(stripped.changed).toBe(false);
  });
});

describe("claudeCodeMcpPresence", () => {
  it("reports this enrollment's entry and names the other servers", () => {
    const merged = mergeClaudeCodeMcpConfig(userConfig(), CONFIG);
    expect(claudeCodeMcpPresence(merged.config, TEST_ENROLLMENT)).toEqual({
      present: true,
      foreignEnrollment: false,
      otherServers: 3,
      otherServerNames: ["github", "motion", "zread"],
    });
    expect(claudeCodeMcpPresence(merged.config, OTHER_ENROLLMENT)).toMatchObject(
      { present: false, foreignEnrollment: true },
    );
    expect(claudeCodeMcpPresence(userConfig(), TEST_ENROLLMENT).present).toBe(
      false,
    );
    expect(claudeCodeMcpPresence(undefined, TEST_ENROLLMENT).present).toBe(
      false,
    );
  });
});

describe("claudeUserConfigShapeProblem", () => {
  it("refuses a document the merge would damage", () => {
    expect(claudeUserConfigShapeProblem(userConfig())).toBeUndefined();
    expect(claudeUserConfigShapeProblem(undefined)).toBeUndefined();
    expect(claudeUserConfigShapeProblem({ mcpServers: [] })).toContain(
      "`mcpServers` is an array",
    );
    expect(claudeUserConfigShapeProblem([])).toContain("an array");
  });
});
