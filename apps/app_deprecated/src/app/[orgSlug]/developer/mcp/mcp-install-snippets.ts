import {
  JSON_API_KEY_PLACEHOLDER,
  SHELL_API_KEY_PLACEHOLDER,
} from "@oxagen/handlers/system.install.instructions";
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
 * THE CREDENTIAL PLACEHOLDER IS NOT ONE STRING. A shell expands
 * `$OXAGEN_API_KEY`, so the Claude Code snippet names the variable and the
 * operator never pastes a secret. JSON expands nothing: a config file carrying
 * `$OXAGEN_API_KEY` sends that literal as the bearer credential and the client
 * fails to authenticate with no indication why, having followed the
 * instructions exactly. The JSON clients get `<your-api-key>` and the page
 * tells the reader to replace it.
 *
 * Both strings come from packages/handlers/src/system.install.instructions.ts,
 * which serves the same instructions to agents. This module used to carry a
 * comment asking the next author to keep the two in step, and they drifted
 * anyway — the JSON tabs shipped the shell variable. Two places generating
 * install instructions that must agree share the strings instead.
 */
export function buildSnippets(): Array<Omit<McpTabEntry, "highlightedHtml">> {
  return [
    {
      key: "claude_code",
      client: "Claude Code",
      raw: `claude mcp add --transport http oxagen ${MCP_URL} \\\n  --header "Authorization: Bearer ${SHELL_API_KEY_PLACEHOLDER}"`,
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
        "OXAGEN_AUTH_HEADER": "Bearer ${JSON_API_KEY_PLACEHOLDER}"
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
        "Authorization": "Bearer ${JSON_API_KEY_PLACEHOLDER}"
      }
    }
  }
}`,
    },
  ];
}
