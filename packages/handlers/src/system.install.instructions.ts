import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  systemInstallInstructions,
  type InstallClient,
  type InstallStep,
} from "@oxagen/oxagen/contracts/system.install.instructions";

// ── Production URLs (from CLAUDE.md) ─────────────────────────────────────────

// The MCP protocol endpoint is served by the xmcp server (apps/mcp), deployed
// separately at mcp.oxagen.sh on the default `/mcp` path over
// streamable HTTP. The REST API host (oxagen-v2-api) has NO MCP endpoint.
// Org + workspace scope is carried by the API key (auth.api_keys is org- and
// workspace-bound), so the connect URL needs no org/workspace path segment.
const PROD_MCP_URL = process.env["MCP_URL"] ?? "https://mcp.oxagen.sh";
const PROD_APP_URL = process.env["APP_URL"] ?? "https://app.oxagen.sh";

// Where a human mints the API key every one of these clients authenticates
// with. Org + workspace scope rides on the key itself, so the connect URL needs
// no org/workspace path segment — but the page that ISSUES the key is org-scoped
// and the contract's only input slug is the WORKSPACE slug, so the org segment
// stays a placeholder the reader substitutes.
const API_KEY_URL = `${PROD_APP_URL}/<your-org-slug>/developer/tokens`;

// ── Step builders ─────────────────────────────────────────────────────────────

function stepsForClaudeCode(_wsSlug: string | undefined): InstallStep[] {
  const mcpUrl = `${PROD_MCP_URL}/mcp`;
  return [
    {
      label: "Generate an API key — it carries your org + workspace scope",
      command: API_KEY_URL,
    },
    {
      label: "Add the Oxagen MCP server to Claude Code",
      // The URL is positional: `claude mcp add` has no `--url` flag, and passing
      // one makes the command fail.
      command: `claude mcp add --transport http oxagen "${mcpUrl}" --header "Authorization: Bearer $OXAGEN_API_KEY"`,
    },
    {
      label: "Verify the server appears in the tool list",
      command: "claude mcp list",
    },
    {
      label:
        "Start a session — Claude Code now reaches Oxagen's governed capabilities, and every tool call is metered and audited against your workspace",
    },
    {
      label:
        "Optional: install the Oxagen CLI to inspect the same fleet record from a terminal",
      command: "npm install -g @oxagen/cli && oxagen login && oxagen init",
    },
  ];
}

function stepsForCursor(_wsSlug: string | undefined): InstallStep[] {
  const mcpUrl = `${PROD_MCP_URL}/mcp`;
  return [
    {
      label: "Open Cursor Settings → MCP Servers",
    },
    {
      label: "Click 'Add new server' and enter the Oxagen endpoint",
      command: mcpUrl,
    },
    {
      label: "Set transport to HTTP and save",
    },
    {
      label: "Generate an API key at the Oxagen dashboard",
      command: API_KEY_URL,
    },
    {
      label: "Paste the API key into the Authorization header field in Cursor",
    },
    {
      label: "Reload Cursor — the Oxagen tools appear in the agent tool list",
    },
  ];
}

function stepsForClaudeDesktop(_wsSlug: string | undefined): InstallStep[] {
  const mcpUrl = `${PROD_MCP_URL}/mcp`;
  // claude_desktop_config.json only launches local stdio servers; a `url` entry
  // is ignored. Remote servers otherwise go through Settings → Connectors, which
  // authenticate with OAuth, and the Oxagen MCP server takes API keys only. So
  // the entry runs the `mcp-remote` stdio bridge, which forwards to the HTTP
  // endpoint with the bearer header. The header value comes from `env` because
  // a space inside an `args` entry is split by some launchers.
  const configEntry = JSON.stringify(
    {
      mcpServers: {
        oxagen: {
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            mcpUrl,
            "--header",
            "Authorization:${OXAGEN_AUTH_HEADER}",
          ],
          env: {
            OXAGEN_AUTH_HEADER: "Bearer <your-api-key>",
          },
        },
      },
    },
    null,
    2,
  );
  return [
    {
      label: "Generate an API key",
      command: API_KEY_URL,
    },
    {
      label: "Open your Claude Desktop config file",
      command:
        "open ~/Library/Application\\ Support/Claude/claude_desktop_config.json",
    },
    {
      label:
        "Add the Oxagen server entry (merge into existing config) and replace <your-api-key> with the key you just generated",
      command: configEntry,
    },
    {
      label:
        "Restart Claude Desktop — Oxagen tools are now listed in the agent panel",
    },
  ];
}

function stepsForCodex(_wsSlug: string | undefined): InstallStep[] {
  const mcpUrl = `${PROD_MCP_URL}/mcp`;
  return [
    {
      label: "Generate an API key",
      command: API_KEY_URL,
    },
    // Codex reads ~/.codex/config.toml (there is no codex.yaml) and has no
    // `tools list` subcommand. `--bearer-token-env-var` keeps the key out of
    // the config file; Codex reads the variable when it connects.
    {
      label:
        "Export the key, then add the Oxagen MCP server to Codex (writes [mcp_servers.oxagen] to ~/.codex/config.toml)",
      command: `export OXAGEN_API_KEY=<your-api-key>\ncodex mcp add oxagen --url "${mcpUrl}" --bearer-token-env-var OXAGEN_API_KEY`,
    },
    {
      label: "Confirm the server is registered",
      command: "codex mcp list",
    },
  ];
}

function stepsForVscode(_wsSlug: string | undefined): InstallStep[] {
  const mcpUrl = `${PROD_MCP_URL}/mcp`;
  // VS Code reads MCP servers from a top-level `mcp` object with a `servers`
  // map — not a flat "mcp.servers" key. The entry carries a `headers` block
  // with a placeholder bearer token so the key has somewhere to go.
  const settingsEntry = JSON.stringify(
    {
      mcp: {
        servers: {
          oxagen: {
            url: mcpUrl,
            type: "http",
            headers: {
              Authorization: "Bearer <your-api-key>",
            },
          },
        },
      },
    },
    null,
    2,
  );
  return [
    {
      label: "Generate an API key",
      command: API_KEY_URL,
    },
    {
      label:
        "Add the Oxagen server to your VS Code settings.json and replace <your-api-key> with the key you just generated",
      command: settingsEntry,
    },
    {
      label:
        "Reload the VS Code window — Oxagen tools are available in the Copilot/MCP panel",
    },
  ];
}

const STEP_BUILDERS: Record<
  InstallClient,
  (ws: string | undefined) => InstallStep[]
> = {
  "claude-code": stepsForClaudeCode,
  cursor: stepsForCursor,
  "claude-desktop": stepsForClaudeDesktop,
  codex: stepsForCodex,
  vscode: stepsForVscode,
};

// ── Handler ───────────────────────────────────────────────────────────────────

export const systemInstallInstructionsHandler: CapabilityHandler<
  typeof systemInstallInstructions
> = async (input, _ctx) => {
  const builder = STEP_BUILDERS[input.client];
  const steps = builder(input.workspaceSlug);

  return {
    client: input.client,
    steps,
    render: {
      componentId: "install-instructions",
      props: { client: input.client, steps },
    },
  };
};
