import { describe, expect, it } from "vitest";
import { MCP_URL, buildSnippets } from "./mcp-install-snippets";

const KEY = "ox_test_key";
const byKey = (key: string) => {
  const entry = buildSnippets(KEY).find((s) => s.key === key);
  if (!entry) throw new Error(`no ${key} snippet`);
  return entry.raw;
};

describe("buildSnippets", () => {
  it("passes the Claude Code URL positionally — `claude mcp add` has no --url flag", () => {
    const raw = byKey("claude_code");
    expect(raw).toContain(`claude mcp add --transport http oxagen ${MCP_URL}`);
    expect(raw).not.toContain("--url");
    expect(raw).toContain(`Authorization: Bearer ${KEY}`);
  });

  it("bridges Claude Desktop through mcp-remote, not a nonexistent package or a url entry", () => {
    const server = JSON.parse(byKey("claude_desktop")).mcpServers.oxagen;
    expect(server.url).toBeUndefined();
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(
      expect.arrayContaining(["mcp-remote", MCP_URL, "--header"]),
    );
    expect(JSON.stringify(server)).not.toContain("@oxagen/mcp-client");
    expect(server.env.OXAGEN_AUTH_HEADER).toBe(`Bearer ${KEY}`);
  });

  it("writes Cursor's mcp.json as an mcpServers map with url + headers", () => {
    const server = JSON.parse(byKey("cursor")).mcpServers.oxagen;
    expect(server.url).toBe(MCP_URL);
    expect(server.headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});
