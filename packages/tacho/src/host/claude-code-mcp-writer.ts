/**
 * The Claude Code MCP config writer (#5287): the `oxagen` server in Claude
 * Code's user config, so a hooked Claude Code session can call Oxagen's own
 * tools through the collector's loopback gateway.
 *
 * ## Why Claude Code needs it
 *
 * The Stop hook asks a Claude Code run that showed trouble to call
 * `mcp__oxagen__record_reflection` (ADR-206). Hooks give a session no MCP
 * server, and before this writer enrolling Claude Code wrote hooks only, so
 * the session had no such tool. The hook blocked the stop, the agent found
 * nothing to call, and the reflection was lost.
 *
 * ## Why the loopback gateway, not the hosted MCP server
 *
 * `record_reflection` and `remember_lesson` answer only a call from a run
 * Oxagen watches (`assertWatchedRun`). The hosted MCP server knows the run
 * only when the local gateway forwards the call under the `tacho_gateway_v1`
 * key and names the chain. A session pointed straight at the hosted server
 * is refused with `no_watched_run`. Through the gateway, the call also
 * carries Claude Code's `claudecode/toolUseId`, so its frame seals on the
 * session's own chain (ADR-189). `run.reflect` reads it from there when the
 * run seals.
 *
 * ## Why stdio
 *
 * The entry is the one Claude Desktop gets: the `mcp-stdio` shim, which
 * posts each message to the gateway and keeps the bearer in `env`. The
 * capture that pins Claude Code's `claudecode/toolUseId` key was taken over
 * stdio (`fixtures/claude-code/mcp/tools-call-2.1.287.json`). No capture
 * covers Claude Code's HTTP transport yet.
 *
 * ## Where, checked against Claude Code 2.1.288
 *
 * User-scope servers live in `mcpServers` at the top level of
 * `~/.claude.json`, or of `.claude.json` inside `CLAUDE_CONFIG_DIR`
 * (`claudeUserConfigFor`). `claude mcp add --scope user` writes the same
 * place. In a project whose `.mcp.json`, or whose local-scope servers, name
 * another `oxagen` server, that server wins there, and
 * `claudeCodeSessionHasOxagenTools` answers no for a session in it.
 *
 * The file holds Claude Code's whole state for the user, not just its MCP
 * servers. The merge changes `mcpServers.oxagen` and nothing else, and the
 * write runs under the lock Claude Code saves the file with
 * (`claude-config-lock.ts`).
 *
 * Claude Code reads its MCP servers when a session starts. A session that
 * was already running gets the tools in the next session it starts.
 */
import { dirname, join, resolve } from "node:path";
import { readJsonFileIfExists } from "./fs";
import {
  type GatewayInstallConfig,
  isOxagenServerEntry,
  type McpMergeResult,
  type McpServerEntry,
  type McpServerPresence,
  type McpStripResult,
  mcpConfigShapeProblem,
  mergeOxagenMcpServer,
  OXAGEN_MCP_SERVER_KEY,
  oxagenMcpPresence,
  stripOxagenMcpServer,
} from "./mcp-config-writer";

/** Add the Oxagen gateway to Claude Code's user config. Always stdio. */
export function mergeClaudeCodeMcpConfig(
  existing: unknown,
  config: GatewayInstallConfig,
): McpMergeResult {
  return mergeOxagenMcpServer(existing, config, "stdio");
}

/** Remove it again, restoring whatever it displaced. */
export function stripClaudeCodeMcpConfig(
  existing: unknown,
  enrollmentId?: string,
  restore: Record<string, McpServerEntry> = {},
): McpStripResult {
  return stripOxagenMcpServer(existing, enrollmentId, restore);
}

/** Whether this enrollment's entry is installed, and what else is there. */
export function claudeCodeMcpPresence(
  existing: unknown,
  enrollmentId: string,
): McpServerPresence {
  return oxagenMcpPresence(existing, enrollmentId);
}

/** What `claudeCodeSessionHasOxagenTools` judges a session by. */
export interface OxagenToolsCheck {
  /** The enrollment that would have written the entry. */
  enrollmentId: string;
  /** Whether the enrollment holds the key the gateway serves tools with. */
  hasGatewayKey: boolean;
  /** When the entry last took its present form (`mcp_registered_at`). */
  registeredAt: string | undefined;
  /** When the daemon first saw the session. */
  sessionStartedAt: string;
  /** Claude Code's user config, read only when every other test passes. */
  readUserConfig: () => unknown;
  /**
   * The directory the session runs in. Absent, only the user scope is read,
   * and a project server named `oxagen` goes unseen.
   */
  cwd?: string;
  /**
   * Reads a project's `.mcp.json`, undefined when there is none. Defaults to
   * reading the file from disk.
   */
  readProjectConfig?: (file: string) => unknown;
}

/**
 * Whether a Claude Code session can call Oxagen's tools: the enrollment
 * holds the gateway key, wrote the `oxagen` entry before the session
 * started, the entry is still in the user config, and no local-scope or
 * project-scope `oxagen` server wins over it where the session runs. Claude
 * Code loads MCP servers when a session starts, so a session already running
 * when the entry was written does not have the tools.
 */
export function claudeCodeSessionHasOxagenTools(
  check: OxagenToolsCheck,
): boolean {
  if (!check.hasGatewayKey || check.registeredAt === undefined) return false;
  const registered = Date.parse(check.registeredAt);
  const started = Date.parse(check.sessionStartedAt);
  if (!Number.isFinite(registered) || !Number.isFinite(started)) return false;
  if (started < registered) return false;
  const userConfig = check.readUserConfig();
  if (!oxagenMcpPresence(userConfig, check.enrollmentId).present) return false;
  return (
    check.cwd === undefined ||
    !shadowedInProject(
      userConfig,
      check.cwd,
      check.enrollmentId,
      check.readProjectConfig ?? readProjectFile,
    )
  );
}

/**
 * Whether an `oxagen` server that is not this enrollment's wins over ours
 * for a session in `cwd`. Claude Code 2.1.288 ranks local scope over
 * project scope over user scope. It reads local-scope servers from
 * `projects[<dir>].mcpServers` in the user config, keyed by the
 * repository root or else the working directory, and project-scope ones
 * from `.mcp.json` in the working directory and in every directory above
 * it. Checking both for each directory from `cwd` up covers the
 * repository root without asking git.
 *
 * A project server Claude Code has not approved does not win. This does not
 * check approval, so it counts that server as winning too. That costs one
 * reflection, where asking for a tool the hosted server refuses
 * (`no_watched_run`) would block the stop for nothing.
 */
function shadowedInProject(
  userConfig: unknown,
  cwd: string,
  enrollmentId: string,
  readProjectConfig: (file: string) => unknown,
): boolean {
  const projects = member(userConfig, "projects");
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (shadows(member(projects, dir), enrollmentId)) return true;
    if (shadows(readProjectConfig(join(dir, ".mcp.json")), enrollmentId))
      return true;
    if (dirname(dir) === dir) return false;
  }
}

/** Whether `config` names an `oxagen` server that is not this enrollment's. */
function shadows(config: unknown, enrollmentId: string): boolean {
  const entry = member(member(config, "mcpServers"), OXAGEN_MCP_SERVER_KEY);
  return entry !== undefined && !isOxagenServerEntry(entry, enrollmentId);
}

/** `value[key]` when `value` is a JSON object. */
function member(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * A `.mcp.json` from disk. One that does not parse is read as none, since
 * Claude Code reports it and loads nothing from it.
 */
function readProjectFile(file: string): unknown {
  try {
    return readJsonFileIfExists(file);
  } catch {
    return undefined;
  }
}

/** Why the user config cannot be merged into, or undefined when it can. */
export function claudeUserConfigShapeProblem(
  document: unknown,
): string | undefined {
  return mcpConfigShapeProblem(document);
}
