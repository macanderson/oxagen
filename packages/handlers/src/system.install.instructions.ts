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

// ── Step builders ─────────────────────────────────────────────────────────────

function stepsForClaudeCode(wsSlug: string | undefined): InstallStep[] {
  const ws = wsSlug ?? "<your-workspace-slug>";
  const mcpUrl = `${PROD_MCP_URL}/mcp`;
  return [
    {
      label: "Install the Oxagen CLI (requires Node 20+)",
      command: "npm install -g @oxagen/cli",
    },
    {
      label: "Authenticate and link your workspace",
      command: `oxagen auth login && oxagen workspace use ${ws}`,
    },
    {
      label: "Add the Oxagen MCP server to Claude Code",
      command: `claude mcp add oxagen --transport http --url "${mcpUrl}" --header "Authorization: Bearer $OXAGEN_API_KEY"`,
    },
    {
      label: "Verify the server appears in the tool list",
      command: "claude mcp list",
    },
    {
      label: "Start a session — Oxagen tools are now available to the agent",
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
      command: `${PROD_APP_URL}/settings/api-keys`,
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
  // The entry carries a `headers` block with a placeholder bearer token: the
  // MCP server is API-key scoped, so a snippet without somewhere to put the key
  // is a config the user can only ever 401 with.
  const configEntry = JSON.stringify(
    {
      mcpServers: {
        oxagen: {
          url: mcpUrl,
          transport: "http",
          headers: {
            Authorization: "Bearer <your-api-key>",
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
      command: `${PROD_APP_URL}/settings/api-keys`,
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
      command: `${PROD_APP_URL}/settings/api-keys`,
    },
    {
      label: "Add the Oxagen MCP server to your codex.yaml",
      command: [
        "mcp_servers:",
        "  oxagen:",
        `    url: "${mcpUrl}"`,
        "    transport: http",
        "    headers:",
        '      Authorization: "Bearer <your-api-key>"',
      ].join("\n"),
    },
    {
      label: "Run codex to confirm the tools are registered",
      command: "codex tools list",
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
      command: `${PROD_APP_URL}/settings/api-keys`,
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
