/**
 * `oxagen agent run -- <command> [args...]`: put one agent session under
 * Oxagen control (#4879). Built on the recorder's run command (`run.ts`).
 *
 * Three cases, by what the command names:
 *
 *   - `--contained`: the contained launcher (`runContained`, ADR-152), for
 *     Claude Code or Codex on Linux with Docker.
 *   - A harness this machine wraps (`claude`, `codex`, `cursor-agent`,
 *     `stella`): the command runs as it is, and its own hooks record the
 *     session. A harness this machine does not wrap is refused, because
 *     running it would record nothing.
 *   - Anything else is a custom agent. The session opens with a
 *     `SessionStart` hook call under the agent's name, which an operator's
 *     pause or suspension refuses before the agent starts. The agent then runs
 *     with `OXAGEN_AGENT`, `OXAGEN_SESSION_ID`, and `OXAGEN_HOOK` in its
 *     environment, so it can report its own steps on the same session, and
 *     the session closes with `SessionEnd` when it exits. Every call names
 *     the live enrollment the session reports under.
 *
 * Only the start and the end are recorded for a custom agent that never
 * calls `OXAGEN_HOOK` itself. The hook call is voluntary, the same limit the
 * docs state for every custom agent.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:os";
import { posix, win32 } from "node:path";
import { runHookCall } from "../claude-code/hook-process";
import { spawnInvocation } from "../host/codex-app-server";
import { agentHolding, agentIsLive, listAgents } from "../host/agents";
import {
  customAgentNameProblem,
  HARNESS_BINARY,
  TACHO_HARNESS_LABELS,
  type WrappedHarness,
} from "../wire";
import type { CliDeps } from "./deps";
import { CONTAINED_AGENTS, type ContainedRunDeps, runContained } from "./run";

export interface AgentRunCommand {
  /** The agent's command line, everything after `--`. */
  command: string[];
  /** A custom agent's name; derived from the command when absent. */
  name?: string;
  /** Run in the contained launcher instead (`--contained`). */
  contained?: boolean;
  image?: string;
  workspace?: string;
  githubRepository?: string;
}

/** How a spawned agent ended. */
export interface AgentExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the command could not be started at all. */
  error?: Error;
}

export interface AgentRunDeps
  extends ContainedRunDeps,
    Pick<CliDeps, "runtime"> {
  /** One hook call; `runHookCall` unless a test passes a stand-in. */
  hook?: (
    payload: string,
    argv: readonly string[],
  ) => Promise<{ stdout: string }>;
  /** Start the agent and wait for it; `spawnAgent` unless a test passes one. */
  spawnAgent?: (
    command: string,
    args: string[],
    options: { env: Record<string, string | undefined>; cwd: string },
  ) => Promise<AgentExit>;
  /** The contained launcher; `runContained` unless a test passes one. */
  contained?: typeof runContained;
  newSessionId?: () => string;
}

/** The harness each wrapped harness's executable is. */
const HARNESS_FOR_BINARY: Readonly<Record<string, WrappedHarness>> =
  Object.fromEntries(
    Object.entries(HARNESS_BINARY).map(([harness, binary]) => [
      binary,
      harness as WrappedHarness,
    ]),
  );

/** The executable's own name: no directory, no Windows extension, lowercase. */
function programName(program: string): string {
  const base = (program.includes("\\") ? win32 : posix).basename(program);
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/**
 * A custom agent name from its command: the executable's name, lowercased,
 * with every character the name pattern refuses turned into `-`.
 */
export function agentNameFromCommand(program: string): string {
  return programName(program)
    .replace(/\.(mjs|cjs|js|ts|py|sh)$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
}

/**
 * Why a hook's answer refuses the session, or undefined when it lets it
 * start: `continue: false` (a paused or suspended host) or a block. An
 * answer that does not parse lets the session start, the same as an empty
 * one, because the hook answers `{}` whenever it cannot decide.
 */
export function sessionRefusal(stdout: string): string | undefined {
  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof answer !== "object" || answer === null) return undefined;
  const fields = answer as Record<string, unknown>;
  const reason =
    typeof fields["stopReason"] === "string"
      ? fields["stopReason"]
      : typeof fields["reason"] === "string"
        ? fields["reason"]
        : undefined;
  if (fields["continue"] === false || fields["decision"] === "block")
    return reason ?? "the control plane refused this session";
  return undefined;
}

/** The exit code this command reports for the agent's own exit. */
export function exitCodeOf(exit: AgentExit): number {
  if (exit.error !== undefined) return 1;
  if (exit.code !== null) return exit.code;
  const number =
    exit.signal !== null ? constants.signals[exit.signal] : undefined;
  return number !== undefined ? 128 + number : 1;
}

/**
 * Run the agent with the terminal attached and wait for it. A Ctrl-C reaches
 * the agent from the terminal itself, so this process only stays alive for
 * it; a SIGTERM or SIGHUP sent to this process is passed on.
 */
export function spawnAgent(
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined>; cwd: string },
): Promise<AgentExit> {
  const invocation = spawnInvocation(
    command,
    args,
    process.platform,
    options.env,
  );
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      ...(invocation.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });
    const stay = () => undefined;
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGINT", stay);
    process.on("SIGTERM", forward);
    process.on("SIGHUP", forward);
    const done = (exit: AgentExit) => {
      process.off("SIGINT", stay);
      process.off("SIGTERM", forward);
      process.off("SIGHUP", forward);
      resolve(exit);
    };
    child.once("error", (error) => done({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => done({ code, signal }));
  });
}

/** Returns the process exit code: the agent's, 1 when it never started, 2 for a usage error. */
export async function runAgentSession(
  command: AgentRunCommand,
  deps: AgentRunDeps,
): Promise<number> {
  const [program, ...args] = command.command;
  if (program === undefined || program.length === 0) {
    deps.err(
      "Name the agent's command after --: `oxagen agent run -- ./my-agent --task build`.",
    );
    return 2;
  }
  if (command.contained === true)
    return (deps.contained ?? runContained)(
      {
        agent: program,
        args,
        ...(command.image !== undefined ? { image: command.image } : {}),
        ...(command.workspace !== undefined
          ? { workspace: command.workspace }
          : {}),
        ...(command.githubRepository !== undefined
          ? { githubRepository: command.githubRepository }
          : {}),
      },
      deps,
    );
  const run = deps.spawnAgent ?? spawnAgent;
  const harness = HARNESS_FOR_BINARY[programName(program)];
  if (harness !== undefined && command.name === undefined) {
    const label = TACHO_HARNESS_LABELS[harness];
    const agent = agentHolding(deps.paths, harness);
    if (agent === undefined) {
      const containable = Object.values(CONTAINED_AGENTS).includes(
        harness as (typeof CONTAINED_AGENTS)[keyof typeof CONTAINED_AGENTS],
      );
      deps.err(
        `${label} is not wrapped on this machine, so nothing would record this session. Run \`oxagen agent enroll --harness ${harness}\` first${containable ? ", or add --contained to start it in the contained launcher" : ""}.`,
      );
      return 2;
    }
    deps.err(
      `${label} records this session through its own hooks, as ${agent.host.agent_key}.`,
    );
    return exitCodeOf(
      await run(program, args, { env: deps.env, cwd: deps.cwd }),
    );
  }

  const name = command.name ?? agentNameFromCommand(program);
  const problem = customAgentNameProblem(name);
  if (problem !== undefined) {
    deps.err(
      `Cannot record ${program} as the custom agent ${JSON.stringify(name)}: ${problem}. Name it with --name.`,
    );
    return 2;
  }
  // The session reports under one live agent, named by its enrollment in
  // every hook call. A call that names none falls back to the first agent
  // directory, which may be a retired one whose spool never ships.
  const live = listAgents(deps.paths).find(agentIsLive);
  if (live === undefined) {
    deps.err(
      "This machine is not enrolled, so nothing would record this session. Run `oxagen agent enroll` first.",
    );
    return 1;
  }
  const enrollment = live.host.host_enrollment_id;
  const hook =
    deps.hook ??
    ((payload: string, argv: readonly string[]) =>
      runHookCall(payload, argv, deps.env));
  const sessionId = (deps.newSessionId ?? randomUUID)();
  const hookArgv = [
    "node",
    "oxagen",
    "hook",
    "--enrollment",
    enrollment,
    "--agent",
    name,
  ];
  const start = await hook(
    JSON.stringify({
      session_id: sessionId,
      hook_event_name: "SessionStart",
      source: "startup",
      cwd: deps.cwd,
      transcript_path: null,
    }),
    hookArgv,
  );
  const refusal = sessionRefusal(start.stdout);
  if (refusal !== undefined) {
    deps.err(
      `Oxagen refused this session before ${program} started: ${refusal}`,
    );
    return 1;
  }
  const exit = await run(program, args, {
    env: {
      ...deps.env,
      OXAGEN_AGENT: name,
      OXAGEN_SESSION_ID: sessionId,
      OXAGEN_HOOK: `${deps.runtime.hookCommand} --enrollment ${enrollment} --agent ${name}`,
    },
    cwd: deps.cwd,
  });
  await hook(
    JSON.stringify({
      session_id: sessionId,
      hook_event_name: "SessionEnd",
      reason: "other",
      cwd: deps.cwd,
      transcript_path: null,
    }),
    hookArgv,
  );
  if (exit.error !== undefined)
    deps.err(`Could not start ${program}: ${exit.error.message}`);
  return exitCodeOf(exit);
}
