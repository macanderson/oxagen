import type { McpTabEntry } from "./mcp-install-tabs";

export const MCP_URL = "https://mcp.oxagen.sh/mcp";

/**
 * Copy-paste install snippets for the Oxagen MCP server, shared by the
 * Developer → MCP page and the workbench MCP page.
 *
 * The server is streamable HTTP and authenticates with an API key only (no
 * OAuth), which decides each client's form:
 * - Claude Code takes the URL as a positional argument; it has no `--url` flag.
 * - Claude Desktop's config file only launches local stdio servers, so it runs
 *   the `mcp-remote` bridge to reach the HTTP endpoint with the bearer header.
 * - Cursor's mcp.json is an `mcpServers` map with `url` + `headers`.
 *
 * Keep in step with packages/handlers/src/system.install.instructions.ts, which
 * serves the same instructions to agents.
 */
export function buildSnippets(
  apiKey: string,
): Array<Omit<McpTabEntry, "highlightedHtml">> {
  return [
    {
      key: "claude_code",
      client: "Claude Code",
      raw: `claude mcp add --transport http oxagen ${MCP_URL} \\\n  --header "Authorization: Bearer ${apiKey}"`,
    },
    {
      key: "claude_desktop",
      client: "Claude Desktop",
      raw: `{
  "mcpServers": {
    "oxagen": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${MCP_URL}", "--header", "Authorization:\${OXAGEN_AUTH_HEADER}"],
      "env": {
        "OXAGEN_AUTH_HEADER": "Bearer ${apiKey}"
      }
    }
  }
}`,
    },
    {
      key: "cursor",
      client: "Cursor",
      raw: `{
  "mcpServers": {
    "oxagen": {
      "url": "${MCP_URL}",
      "headers": {
        "Authorization": "Bearer ${apiKey}"
      }
    }
  }
}`,
    },
  ];
}
