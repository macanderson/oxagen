/**
 * CLI turn extras — the single place that assembles everything the ONE engine
 * loop needs beyond the raw workspace: workspace rules, lifecycle hooks, MCP
 * tools, and the tool gate. It produces exactly the two engine seams
 * ({@link RunTurnOptions.extraTools} / {@link RunTurnOptions.wrapTools}) plus a
 * system-prompt append, so every entry point — REPL, one-shot, `--agent`, the
 * fleet — runs the same engine with the same safety wiring instead of a second
 * hand-rolled loop.
 *
 * ## Two permission mechanisms, no double-gating
 *
 * The REPL/one-shot paths gate PERMISSIONS at the workspace level (a
 * {@link PermissionBroker} wraps `writeFile`/`editFile`/`exec` via
 * `createGatedWorkspace`). Those callers pass `gatePermissions: false` here, so
 * the tool gate applies ONLY the rule-guard denies + hooks — it does not
 * re-check `settings.permissions` (the broker already did). The `--agent`/fleet
 * paths have no workspace broker, so they pass `gatePermissions: true` and the
 * tool gate enforces `settings.permissions` too. This keeps exactly one
 * permission check per call on every path.
 */
import type { ToolSet } from "ai";
import { loadRules } from "../rules/loader.js";
import { renderRulesSection, guardsToDeny } from "../rules/enforce.js";
import { wrapToolsWithGate } from "../settings/gate.js";
import { runHooks } from "../settings/hooks.js";
import { loadMcpTools, type McpServerStatus } from "../mcp/client.js";
import { filterToolsForAgent } from "../agents/tools.js";
import type { OxagenSettings } from "../settings/schema.js";
import type { Rule } from "../rules/types.js";

export interface TurnExtrasOptions {
  cwd: string;
  /** Resolved settings.json (permissions, hooks, mcpServers). */
  settings: OxagenSettings;
  /** Workspace rules; defaults to `loadRules({ cwd })`. Injectable for tests. */
  rules?: Rule[];
  /** Read-only mode: withhold MCP tools (they may mutate). */
  readOnly?: boolean;
  /** Named-agent tool allowlist — restricts the tool set the model sees. */
  agentTools?: string[];
  /**
   * When true, the tool gate ALSO enforces `settings.permissions` — for paths
   * with no workspace broker (`--agent`, fleet). REPL/one-shot leave this false
   * (their broker handles permissions) to avoid double-gating.
   */
  gatePermissions?: boolean;
  /** Turn abort signal (aborts hook commands + gates). */
  signal?: AbortSignal;
  /** Fired when a tool call is blocked by a permission rule / PreToolUse hook. */
  onBlocked?: (toolName: string, reason: string) => void;
  /** Fired once per external MCP server after its connect attempt. */
  onMcpServer?: (status: McpServerStatus) => void;
}

export interface TurnExtras {
  /** Rules section (Tier 1) + SessionStart hook output — append to the system prompt. */
  systemAppend: string;
  /** External MCP tools to merge, or undefined when none. */
  extraTools?: ToolSet;
  /** Final tool transform: agent allowlist → permission/hook gate. */
  wrapTools: (tools: ToolSet) => ToolSet;
  /** Disconnect MCP servers. Always call in the turn's finally. */
  closeMcp: () => Promise<void>;
}

/**
 * Assemble the CLI turn extras. Connects MCP servers (unless read-only / none),
 * runs SessionStart hooks, and builds the tool gate. The returned `wrapTools`
 * applies: the agent allowlist, then the permission/hook gate (rule-guard denies
 * always; `settings.permissions` only when `gatePermissions`).
 */
export async function buildTurnExtras(opts: TurnExtrasOptions): Promise<TurnExtras> {
  const rules = opts.rules ?? loadRules({ cwd: opts.cwd });
  const ruleDenies = guardsToDeny(rules);

  // System additions: Tier-1 rules text + SessionStart hook output.
  let systemAppend = renderRulesSection(rules);
  const sessionStart = await runHooks(
    opts.settings.hooks,
    { event: "SessionStart", cwd: opts.cwd },
    opts.signal,
  );
  if (sessionStart.output) {
    systemAppend += "\n\n## Session context (from SessionStart hooks)\n" + sessionStart.output;
  }

  // MCP tools — skipped in read-only mode (may mutate) and when none configured.
  const hasServers =
    !opts.readOnly && Object.keys(opts.settings.mcpServers ?? {}).length > 0;
  const mcp = hasServers
    ? await loadMcpTools(opts.settings, { onStatus: opts.onMcpServer })
    : null;

  // Permission set for the tool gate: rule-guard denies always; the full
  // settings.permissions only when this path has no workspace broker.
  const basePerms = opts.gatePermissions ? opts.settings.permissions : undefined;
  const permissions =
    ruleDenies.deny.length || basePerms
      ? {
          ...(basePerms ?? {}),
          deny: [...(basePerms?.deny ?? []), ...ruleDenies.deny],
        }
      : undefined;

  const wrapTools = (tools: ToolSet): ToolSet => {
    const allowed = filterToolsForAgent(tools, opts.agentTools);
    if (!permissions && !opts.settings.hooks) return allowed;
    return wrapToolsWithGate(allowed, {
      cwd: opts.cwd,
      permissions,
      hooks: opts.settings.hooks,
      signal: opts.signal,
      onBlocked: opts.onBlocked,
      denyReasons: ruleDenies.reasons,
    });
  };

  return {
    systemAppend,
    extraTools: mcp?.tools,
    wrapTools,
    closeMcp: async () => {
      await mcp?.close();
    },
  };
}
