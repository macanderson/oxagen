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

/**
 * The two credential placeholders, and why there are two.
 *
 * A shell expands `$OXAGEN_API_KEY`, so a CLI snippet can name the variable and
 * the operator never pastes the secret. **JSON does not expand anything.** A
 * config file carrying `$OXAGEN_API_KEY` sends that literal string as the
 * bearer credential, and the client fails to authenticate with no indication
 * why — the user followed the instructions exactly.
 *
 * Exported because the app's Developer → MCP page builds the same snippets for
 * a human (`developer/mcp/mcp-install-snippets.ts`) and the two drifted apart
 * once already: the page used the shell variable in its JSON tabs. Two places
 * generating install instructions that must agree share the strings rather than
 * a comment asking the next author to remember.
 */
export const SHELL_API_KEY_PLACEHOLDER = "$OXAGEN_API_KEY";
/** What a reader replaces by hand in a JSON config. */
export const JSON_API_KEY_PLACEHOLDER = "<your-api-key>";

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
      command: `claude mcp add --transport http oxagen "${mcpUrl}" --header "Authorization: Bearer ${SHELL_API_KEY_PLACEHOLDER}"`,
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
  // Cursor reads remote MCP servers from `mcpServers` in ~/.cursor/mcp.json
  // (every project) or .cursor/mcp.json (one project). A `url` entry is an
  // HTTP server, and `headers` carries the bearer key. JSON expands nothing,
  // so the key is a placeholder the reader replaces, not a shell variable.
  const configEntry = JSON.stringify(
    {
      mcpServers: {
        oxagen: {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${JSON_API_KEY_PLACEHOLDER}`,
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
    // No command: this capability takes no platform, and the file opens with
    // a different program on macOS, Linux, and Windows. The label names the
    // path on each so the reader opens it with whatever editor they use.
    {
      label:
        "Open your Cursor MCP config in any editor: ~/.cursor/mcp.json for every project (%USERPROFILE%\\.cursor\\mcp.json on Windows), or .cursor/mcp.json in the project for this one only",
    },
    {
      label: `Add the Oxagen server entry (merge into existing config) and replace ${JSON_API_KEY_PLACEHOLDER} with the key you just generated`,
      command: configEntry,
    },
    {
      label:
        "Reload Cursor. The Oxagen tools appear in Cursor Settings under MCP and in the agent's tool list",
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
            OXAGEN_AUTH_HEADER: `Bearer ${JSON_API_KEY_PLACEHOLDER}`,
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
    // No command, for the reason the Cursor step gives: Claude Desktop runs
    // on macOS and Windows, and `open` exists only on macOS.
    {
      label:
        "Open your Claude Desktop config in any editor: ~/Library/Application Support/Claude/claude_desktop_config.json on macOS, %APPDATA%\\Claude\\claude_desktop_config.json on Windows",
    },
    {
      label: `Add the Oxagen server entry (merge into existing config) and replace ${JSON_API_KEY_PLACEHOLDER} with the key you just generated`,
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
      command: `export OXAGEN_API_KEY=${JSON_API_KEY_PLACEHOLDER}\ncodex mcp add oxagen --url "${mcpUrl}" --bearer-token-env-var OXAGEN_API_KEY`,
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
              Authorization: `Bearer ${JSON_API_KEY_PLACEHOLDER}`,
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
      label: `Add the Oxagen server to your VS Code settings.json and replace ${JSON_API_KEY_PLACEHOLDER} with the key you just generated`,
      command: settingsEntry,
    },
    {
      label:
        "Reload the VS Code window — Oxagen tools are available in the Copilot/MCP panel",
    },
  ];
}

/** The install clients Tacho wraps with hooks, and the binary each one runs. */
type WrappedInstallClient = "claude-code" | "codex" | "cursor";

const WRAPPED_CLIENT_BINARY: Record<WrappedInstallClient, string> = {
  "claude-code": "claude",
  codex: "codex",
  // Cursor's CLI ships as `cursor-agent`. The Cursor IDE reads the same
  // ~/.cursor/hooks.json, so a machine with only the IDE is covered too.
  cursor: "cursor-agent",
};

function isWrappedInstallClient(
  client: InstallClient,
): client is WrappedInstallClient {
  return Object.hasOwn(WRAPPED_CLIENT_BINARY, client);
}

/**
 * The wrap for a hook-based harness when the caller holds an enrollment token
 * (#2967): the scripted path spec §14.1 names. The token is single use and
 * expires, so the step says so.
 */
function stepsForEnrollment(
  client: WrappedInstallClient,
  token: string,
): InstallStep[] {
  return [
    {
      label: "Install the Oxagen CLI",
      command: "npm install -g @oxagen/cli",
    },
    {
      label:
        "Enrol this machine with the one-time token: device key, host credential, collector service and the harness hooks (the token is single use and expires unused)",
      command: `oxagen agent enroll --token ${token} --harness ${client}`,
    },
    {
      label:
        "Start a session — its first frame is what registers the agent on Fleet",
      command: WRAPPED_CLIENT_BINARY[client],
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
  const steps =
    input.enrollmentToken !== undefined && isWrappedInstallClient(input.client)
      ? stepsForEnrollment(input.client, input.enrollmentToken)
      : STEP_BUILDERS[input.client](input.workspaceSlug);

  return {
    client: input.client,
    steps,
    render: {
      componentId: "install-instructions",
      props: { client: input.client, steps },
    },
  };
};
