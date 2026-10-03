/**
 * Adding Oxagen's MCP server to an enrolled Claude Code (#5287).
 *
 * `enroll` calls `registerClaudeCodeMcp` each time it writes Claude Code's
 * hooks, a re-apply included, so enrolling again repairs a missing entry.
 * `oxagen agent status` calls `addMissingClaudeCodeMcp`, which adds the entry
 * once to each live enrollment made before enroll wrote it. The desktop app
 * polls status, so a machine it updates gains the entry with no step from
 * the person. Both go through `registerClaudeCodeMcp`, so there is one write
 * path. The writer and the reasons for the loopback gateway are in
 * `host/claude-code-mcp-writer.ts`.
 *
 * Codex, Cursor, and Stella get no entry here:
 *
 * - Stella reads MCP servers only from each workspace's `.stella/mcp.toml`.
 *   The user-scope `[mcp.servers]` table in `stella.toml` parses and does
 *   nothing yet, so there is no user-scope file to write.
 * - Codex documents `[mcp_servers.<name>]` in `~/.codex/config.toml`, but it
 *   sends no tool call id with an MCP call. The gateway then seals the call
 *   on the daemon's chain, not the Codex run's (ADR-189 decision 6), and
 *   `run.reflect` never finds it, while the handler still answers that it
 *   noted the call. A Codex entry needs a way to join the call to its run
 *   first.
 * - Cursor has no Stop hook ask (ADR-206), and enrollment writes no
 *   `mcp.json` for it.
 */
import { agentIsLive, listAgents } from "../host/agents";
import {
  claudeUserConfigShapeProblem,
  mergeClaudeCodeMcpConfig,
} from "../host/claude-code-mcp-writer";
import { HarnessFileError } from "../host/harness-file";
import {
  type HostFile,
  readHostFile,
  writeHostFile,
} from "../host/host-file";
import { acquireInstallLock } from "../host/install-lock";
import { depsForAgent } from "./agent-deps";
import type { CliDeps } from "./deps";

/** The one harness `registerClaudeCodeMcp` registers the server for. */
const HARNESS = "claude-code";

export interface ClaudeCodeMcpOutcome {
  /** `host`, with what the registration recorded in `host.json`. */
  host: HostFile;
  /**
   * `written`: the entry was added or brought up to date. `present`: the
   * entry was already right. `skipped`: nothing was written, for `reason`.
   */
  result: "written" | "present" | "skipped";
  /** Why it was skipped, in words for the person running the command. */
  reason?: string;
  /** A server of the user's held the `oxagen` name and was moved aside. */
  displaced: boolean;
}

/**
 * Whether this enrollment has what the gateway needs to serve Claude Code
 * Oxagen's tools: the `tacho_gateway_v1` key it forwards with. A host
 * enrolled before the gateway existed has none, and its gateway serves no
 * tools, so an entry would only list a server that answers nothing.
 */
export function canServeOxagenTools(
  host: Pick<HostFile, "gateway_api_key">,
): boolean {
  return host.gateway_api_key !== undefined;
}

/**
 * Write the `oxagen` server into Claude Code's user config for this
 * enrollment, pointing at the collector's loopback gateway through the stdio
 * shim. Idempotent. A server of the user's that held the name is moved
 * aside and recorded in `host.json` before the file is written, and
 * `unenroll` puts it back. Throws when the file cannot be read, has the
 * wrong shape, or stays locked; the caller reports that and carries on,
 * because the hooks work without the entry.
 */
export function registerClaudeCodeMcp(
  host: HostFile,
  deps: CliDeps,
): ClaudeCodeMcpOutcome {
  const edit = deps.editClaudeUserConfig;
  if (edit === undefined)
    return {
      host,
      result: "skipped",
      reason: "this build cannot edit Claude Code's user config",
      displaced: false,
    };
  if (!canServeOxagenTools(host))
    return {
      host,
      result: "skipped",
      reason:
        "this enrollment has no gateway key, so the collector cannot serve Oxagen's tools. Run `oxagen agent enroll --force` to enroll this machine again with one",
      displaced: false,
    };
  const path = deps.paths.claudeUserConfig;
  const shim = host.mcp_stdio_command ?? deps.runtime.mcpStdioCommand;
  let current = host;
  // Where the entry goes, recorded before it is written, so `unenroll` finds
  // the file even when it runs in an environment with another
  // CLAUDE_CONFIG_DIR. A re-apply rewrites `harness_files` only when the
  // commands move, so this cannot wait for that.
  if (current.harness_files?.claude_user_config !== path) {
    current = {
      ...current,
      harness_files: { ...current.harness_files, claude_user_config: path },
    };
    writeHostFile(deps.paths.hostFile, current);
  }
  let result: ClaudeCodeMcpOutcome["result"] = "present";
  let displaced = false;
  let wroteEntry = false;
  edit((document) => {
    const problem = claudeUserConfigShapeProblem(document);
    if (problem !== undefined) throw new HarnessFileError(path, problem);
    const merged = mergeClaudeCodeMcpConfig(document, {
      enrollmentId: current.host_enrollment_id,
      port: current.port,
      localToken: current.local_token,
      shimCommand: shim[0] as string,
      shimArgs: shim.slice(1, -1),
      ...(deps.env["TACHO_HOME"] !== undefined
        ? { tachoHome: deps.env["TACHO_HOME"] }
        : {}),
    });
    if (!merged.changed) return undefined;
    // The user's own server goes to host.json before the file is replaced,
    // so a run that dies between the two still knows what to put back.
    if (Object.keys(merged.displaced).length > 0) {
      displaced = true;
      current = {
        ...current,
        displaced_mcp_servers: {
          ...current.displaced_mcp_servers,
          [HARNESS]: {
            ...current.displaced_mcp_servers[HARNESS],
            // The server the person put under the name most recently wins:
            // one there now replaced whatever an earlier run moved aside.
            ...(merged.displaced as Record<string, Record<string, unknown>>),
          },
        },
      };
      writeHostFile(deps.paths.hostFile, current);
    }
    result = "written";
    wroteEntry = true;
    return merged.config;
  });
  // The time the entry took its present form. A session that started before
  // it has no such tool, so the Stop hook leaves it alone. An entry found in
  // place with no time recorded (a run that died after writing it) gets this
  // run's time, which can only hold the ask back, never ask too early.
  if (wroteEntry || current.mcp_registered_at?.[HARNESS] === undefined) {
    current = {
      ...current,
      mcp_registered_at: {
        ...current.mcp_registered_at,
        [HARNESS]: new Date(deps.now()).toISOString(),
      },
    };
    writeHostFile(deps.paths.hostFile, current);
  }
  return { host: current, result, displaced };
}

/** One agent `addMissingClaudeCodeMcp` acted on. */
export interface ClaudeCodeMcpAdded {
  agentKey: string;
  /** Claude Code's user config. */
  path: string;
  ok: boolean;
  /** Why it failed, when it did. */
  problem?: string;
}

/**
 * Whether a live enrollment hooks Claude Code, can serve Oxagen's tools, and
 * has never had the `oxagen` server written: one enrolled before #5287.
 */
export function needsClaudeCodeMcp(host: HostFile): boolean {
  return (
    host.revoked_at === null &&
    host.harnesses.includes(HARNESS) &&
    canServeOxagenTools(host) &&
    host.mcp_registered_at?.[HARNESS] === undefined
  );
}

/**
 * Add the `oxagen` server once to each live agent that `needsClaudeCodeMcp`.
 * Runs under the install lock, and does nothing while an enroll, unenroll,
 * or reassign holds it, because that run writes the entry itself or takes
 * the enrollment away. A failure is reported and tried again on the next
 * call, since `mcp_registered_at` is set only once the entry is written.
 */
export function addMissingClaudeCodeMcp(deps: CliDeps): ClaudeCodeMcpAdded[] {
  if (deps.editClaudeUserConfig === undefined) return [];
  const pending = listAgents(deps.paths).filter(
    (agent) => agentIsLive(agent) && needsClaudeCodeMcp(agent.host),
  );
  if (pending.length === 0) return [];
  const lock = acquireInstallLock(deps.paths.tachoDir, deps.now);
  if ("heldBy" in lock) return [];
  const added: ClaudeCodeMcpAdded[] = [];
  try {
    for (const agent of pending) {
      const own = depsForAgent(deps, agent);
      // Read again under the lock: an enroll that finished a moment ago may
      // have written the entry, or retired the agent.
      const host = readHostFile(own.paths.hostFile);
      if (host === undefined || !needsClaudeCodeMcp(host)) continue;
      // An enrollment from before #5287 recorded where Claude Code's
      // settings were, not its user config. When that settings file is not
      // the one this process finds, the enrolling shell had another
      // CLAUDE_CONFIG_DIR, and either `.claude.json` could be the one Claude
      // Code reads, so nothing is written. Enroll records the path itself.
      const recorded = host.harness_files;
      if (
        recorded?.claude_user_config === undefined &&
        recorded?.claude_settings !== undefined &&
        recorded.claude_settings !== agent.paths.claudeSettings
      ) {
        added.push({
          agentKey: host.agent_key,
          path: own.paths.claudeUserConfig,
          ok: false,
          problem: `this agent was enrolled with Claude Code's settings at ${recorded.claude_settings}, and this command finds them at ${agent.paths.claudeSettings}, so it cannot tell which .claude.json Claude Code reads. Run \`oxagen agent enroll\` from a shell with the CLAUDE_CONFIG_DIR you enrolled with`,
        });
        continue;
      }
      try {
        const outcome = registerClaudeCodeMcp(host, own);
        added.push({
          agentKey: host.agent_key,
          path: own.paths.claudeUserConfig,
          ok: outcome.result !== "skipped",
          ...(outcome.reason !== undefined ? { problem: outcome.reason } : {}),
        });
      } catch (error) {
        added.push({
          agentKey: host.agent_key,
          path: own.paths.claudeUserConfig,
          ok: false,
          problem: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    lock.release();
  }
  return added;
}
