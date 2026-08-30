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
import {
  fetchWorkspaceMcpServers,
  buildWorkspaceServerConfigs,
  buildWorkspaceRemoteFetch,
  type WorkspaceMcpServer,
} from "../mcp/workspace-servers.js";
import { filterToolsForAgent } from "../agents/tools.js";
import { loadSkills, skillsPromptBlock, type Skill } from "../skills/index.js";
import type { OxagenSettings } from "../settings/schema.js";
import type { Rule } from "../rules/types.js";

export interface TurnExtrasOptions {
  cwd: string;
  /** Resolved settings.json (permissions, hooks, mcpServers). */
  settings: OxagenSettings;
  /** Workspace rules; defaults to `loadRules({ cwd })`. Injectable for tests. */
  rules?: Rule[];
  /** Discovered skills; defaults to `loadSkills({ cwd })`. Injectable for tests. */
  skills?: Skill[];
  /** Read-only mode: withhold MCP tools (they may mutate). */
  readOnly?: boolean;
  /** Named-agent tool allowlist — restricts the tool set the model sees. */
  agentTools?: string[];
  /**
   * Named-agent skill selection (AgentDefinition.skills): these skills'
   * instructions are injected into the system prompt in full; every other
   * discovered skill still appears in the compact name+description list.
   * Undefined ⇒ list-only awareness (no full bodies).
   */
  agentSkills?: string[];
  /**
   * Named-agent MCP-server selection (AgentDefinition.mcpServers): keys into
   * the global `settings.mcpServers` map. Undefined ⇒ inherit every
   * configured server (today's behavior); `[]` ⇒ connect none.
   */
  agentMcpServers?: string[];
  /**
   * When true, the tool gate ALSO enforces `settings.permissions` — for paths
   * with no workspace broker (`--agent`, fleet). REPL/one-shot leave this false
   * (their broker handles permissions) to avoid double-gating.
   */
  gatePermissions?: boolean;
  /**
   * DB-backed, workspace-installed MCP servers (resolved from the platform with
   * their credentials). Undefined ⇒ fetch them live (best-effort) when the CLI
   * is logged in and not read-only. Injectable so tests bypass the network.
   * See mcp/workspace-servers.ts for the security design.
   */
  workspaceMcpServers?: WorkspaceMcpServer[];
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
export async function buildTurnExtras(
  opts: TurnExtrasOptions,
): Promise<TurnExtras> {
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
    systemAppend +=
      "\n\n## Session context (from SessionStart hooks)\n" +
      sessionStart.output;
  }

  // Loadable skills (.oxagen/skills, .claude/skills, …): every turn sees the
  // compact name+description inventory; an agent's declared `skills` selection
  // additionally injects those skill instructions in full (progressive
  // disclosure — see skills/loader.ts's skillsPromptBlock).
  const skillsBlock = skillsPromptBlock(
    opts.skills ?? [...loadSkills({ cwd: opts.cwd }).values()],
    opts.agentSkills,
  );
  if (skillsBlock) systemAppend += "\n\n" + skillsBlock;

  // MCP tools — skipped in read-only mode (may mutate) and when none
  // configured. An agent's `mcpServers` selection narrows the global map to
  // just its declared servers (undefined inherits everything).
  //
  // DB-backed, workspace-installed servers (installed via the web app) are
  // fetched from the platform — with their credentials resolved SERVER-SIDE —
  // and merged into the file-based map. File-based config wins on a name
  // collision (an explicit local override is never clobbered). Their
  // credentials flow through a `remoteFetch` handed to loadMcpTools and are
  // never persisted to disk. See mcp/workspace-servers.ts.
  const configuredServers = opts.settings.mcpServers ?? {};
  const workspaceServers = opts.readOnly
    ? []
    : (opts.workspaceMcpServers ?? (await fetchWorkspaceMcpServers()));
  const workspaceConfigs = buildWorkspaceServerConfigs(
    workspaceServers,
    new Set(Object.keys(configuredServers)),
  );
  // File-based spread last so it wins on collision.
  const allServers = { ...workspaceConfigs, ...configuredServers };
  const selectedServers = opts.agentMcpServers
    ? Object.fromEntries(
        Object.entries(allServers).filter(([name]) =>
          opts.agentMcpServers!.includes(name),
        ),
      )
    : allServers;
  const hasServers = !opts.readOnly && Object.keys(selectedServers).length > 0;
  const mcp = hasServers
    ? await loadMcpTools(
        { ...opts.settings, mcpServers: selectedServers },
        {
          onStatus: opts.onMcpServer,
          credentials: {
            remoteFetch: buildWorkspaceRemoteFetch(workspaceServers),
            persistRemote: false,
          },
        },
      )
    : null;

  // Permission set for the tool gate: rule-guard denies always; the full
  // settings.permissions only when this path has no workspace broker.
  const basePerms = opts.gatePermissions
    ? opts.settings.permissions
    : undefined;
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
