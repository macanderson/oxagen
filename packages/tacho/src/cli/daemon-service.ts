/**
 * The user service that runs `tachod`. One service serves every agent on
 * the machine (ADR-203), so `enroll` installs it and `unenroll` reinstalls
 * it for the agents that remain, from the same spec.
 */
import type { ServiceSpec } from "../host/service";
import type { CliDeps } from "./deps";

/**
 * The harness homes a shell can move: tachod's fallback for an agent whose
 * host.json records no harness files.
 */
const HARNESS_HOME_VARS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "STELLA_HOME",
  "CURSOR_CONFIG_DIR",
] as const;

export function daemonServiceSpec(
  daemonCommand: string[],
  deps: Pick<CliDeps, "env" | "home" | "paths">,
): ServiceSpec {
  return {
    command: daemonCommand,
    env: {
      ...(deps.env["TACHO_HOME"] !== undefined
        ? { TACHO_HOME: deps.env["TACHO_HOME"] }
        : {}),
      // The harness homes this shell moved. tachod reads each agent's
      // harness files where its host.json recorded them at enroll
      // (`harness_files`), so these no longer decide that for an agent with
      // a record. They stay for an agent enrolled before the record existed,
      // and for a home a record does not name: tachod has nothing else to
      // resolve those from. One service serves every agent, so they come
      // from whichever shell installed it last.
      ...Object.fromEntries(
        HARNESS_HOME_VARS.flatMap((key) => {
          const value = deps.env[key];
          return value !== undefined ? [[key, value]] : [];
        }),
      ),
      PATH: deps.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: deps.home,
    },
    // One tachod serves every agent, so its log and working directory are
    // the tacho directory's, whichever agent the enrollment went into.
    logPath: deps.paths.log,
    workingDirectory: deps.paths.tachoDir,
  };
}
