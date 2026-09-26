/**
 * The user service that runs `tachod`. One service serves every enrollment
 * slot on the machine (ADR-202), so `enroll` installs it and `unenroll`
 * reinstalls it for the slots that remain, from the same spec.
 */
import type { ServiceSpec } from "../host/service";
import type { CliDeps } from "./deps";
import { rootPathsOf } from "./slot-deps";

/** The harness homes a shell can move, which tachod must read the same way. */
const HARNESS_HOME_VARS = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "STELLA_HOME",
  "CURSOR_CONFIG_DIR",
] as const;

export function daemonServiceSpec(
  daemonCommand: string[],
  deps: Pick<CliDeps, "env" | "home" | "paths" | "rootPaths">,
): ServiceSpec {
  const root = rootPathsOf(deps);
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
    // One tachod serves every slot, so its log and directory are the root's
    // whichever slot the enrollment went into.
    logPath: root.log,
    workingDirectory: root.root,
  };
}
