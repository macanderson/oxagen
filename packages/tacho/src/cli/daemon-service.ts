/**
 * The user service that runs `tachod`. One service serves every agent on
 * the machine (ADR-203), so `enroll` installs it and `unenroll` reinstalls
 * it for the agents that remain, from the same spec.
 */
import type { ServiceSpec } from "../host/service";
import type { CliDeps } from "./deps";

/** The harness homes a shell can move, which tachod must read the same way. */
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
      // The harness homes the enrolling shell moved, so tachod reads the
      // same files the hooks were written to.
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
