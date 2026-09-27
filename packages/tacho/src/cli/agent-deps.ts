/**
 * Deps for a command acting on one agent (`host/agents.ts`, ADR-203).
 * Everything that reads or writes an enrollment moves to the agent's
 * directory: its `host.json`, the daemon ports behind it, its credential
 * store and its install receipts. The service and the terminal stay as they
 * were, since one `tachod` serves every agent and one person is reading.
 */
import { type Agent, agentHolding } from "../host/agents";
import {
  readHostFileLenient,
  withRecordedHarnessFiles,
} from "../host/host-file";
import type { TachoPaths } from "../host/paths";
import type { CliDeps } from "./deps";

/** `deps` rebound to `paths`, or `deps` itself when it already acts on them. */
export function agentDeps<D extends CliDeps>(deps: D, paths: TachoPaths): D {
  if (JSON.stringify(paths) === JSON.stringify(deps.paths)) return deps;
  const rebound = deps.atAgent?.(paths) ?? { ...deps, paths };
  return {
    ...deps,
    ...rebound,
    paths,
    serviceManager: deps.serviceManager,
    out: deps.out,
    err: deps.err,
  };
}

/**
 * `deps` bound to the live agent that hooks `harness`, with the harness
 * files its enroll recorded. A command a harness runs (its credential
 * helper, its Git credential helper) names only the harness, and this is how
 * it reaches the enrollment that owns it. `deps` unchanged when no agent
 * hooks it.
 */
export function depsForHarness<D extends CliDeps>(deps: D, harness: string): D {
  const agent = agentHolding(deps.paths, harness);
  return agent === undefined ? deps : depsForAgent(deps, agent);
}

/**
 * `deps` bound to `agent`, with the harness files its enroll recorded. A
 * `host.json` that does not read in full still names them when they can be
 * salvaged, so an unenroll cleans the files that agent's enroll wrote.
 */
export function depsForAgent<D extends CliDeps>(deps: D, agent: Agent): D {
  const host =
    agent.host ?? readHostFileLenient(agent.paths.hostFile).salvaged;
  return agentDeps(deps, withRecordedHarnessFiles(agent.paths, host));
}
