import { describe, expect, it } from "vitest";
import {
  JSON_API_KEY_PLACEHOLDER,
  SHELL_API_KEY_PLACEHOLDER,
} from "@oxagen/handlers/system.install.instructions";
import { MCP_URL, buildSnippets } from "./mcp-install-snippets";

const byKey = (key: string) => {
  const entry = buildSnippets().find((s) => s.key === key);
  if (!entry) throw new Error(`no ${key} snippet`);
  return entry.raw;
};

describe("buildSnippets", () => {
  it("passes the Claude Code URL positionally — `claude mcp add` has no --url flag", () => {
    const raw = byKey("claude_code");
    expect(raw).toContain(`claude mcp add --transport http oxagen ${MCP_URL}`);
    expect(raw).not.toContain("--url");
  });

  it("bridges Claude Desktop through mcp-remote, not a nonexistent package or a url entry", () => {
    const server = JSON.parse(byKey("claude_desktop")).mcpServers.oxagen;
    expect(server.url).toBeUndefined();
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(
      expect.arrayContaining(["mcp-remote", MCP_URL, "--header"]),
    );
    expect(JSON.stringify(server)).not.toContain("@oxagen/mcp-client");
  });

  it("writes Cursor's mcp.json as an mcpServers map with url + headers", () => {
    const server = JSON.parse(byKey("cursor")).mcpServers.oxagen;
    expect(server.url).toBe(MCP_URL);
  });
});

/**
 * A shell expands `$OXAGEN_API_KEY`; JSON expands nothing. A config file
 * carrying the shell variable sends that literal string as the bearer
 * credential, so a user who followed the instructions exactly gets an
 * authentication failure with no indication why. These hold the two forms
 * apart, and hold both to the strings the agent-facing instructions use.
 */
describe("the credential placeholder, which is not one string", () => {
  it("names the shell variable for Claude Code, which a shell expands", () => {
    expect(byKey("claude_code")).toContain(
      `Authorization: Bearer ${SHELL_API_KEY_PLACEHOLDER}`,
    );
  });

  it("gives Claude Desktop a replacement placeholder, because JSON expands nothing", () => {
    const server = JSON.parse(byKey("claude_desktop")).mcpServers.oxagen;
    expect(server.env.OXAGEN_AUTH_HEADER).toBe(
      `Bearer ${JSON_API_KEY_PLACEHOLDER}`,
    );
    expect(server.env.OXAGEN_AUTH_HEADER).not.toContain("$OXAGEN_API_KEY");
  });

  it("gives Cursor a replacement placeholder for the same reason", () => {
    const server = JSON.parse(byKey("cursor")).mcpServers.oxagen;
    expect(server.headers.Authorization).toBe(
      `Bearer ${JSON_API_KEY_PLACEHOLDER}`,
    );
    expect(server.headers.Authorization).not.toContain("$OXAGEN_API_KEY");
  });

  it("puts no shell variable in any JSON tab", () => {
    for (const key of ["claude_desktop", "cursor"]) {
      expect(byKey(key), key).not.toContain("$OXAGEN_API_KEY");
    }
  });

  it("shares both strings with the agent-facing instructions rather than restating them", () => {
    // The two drifted apart once already, with a comment asking the next author
    // to keep them in step.
    expect(SHELL_API_KEY_PLACEHOLDER).toBe("$OXAGEN_API_KEY");
    expect(JSON_API_KEY_PLACEHOLDER).toBe("<your-api-key>");
  });
});
