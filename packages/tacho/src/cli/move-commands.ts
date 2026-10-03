/**
 * Move a machine's installed hooks and service off the `tacho` names (#4879).
 *
 * A machine enrolled before the `oxagen` CLI took the recorder's commands
 * runs `tacho-hook` (or `tacho hook`) from every harness hook and `tachod`
 * (or `tacho daemon`) from its user service. Those names stay as hidden
 * aliases, so nothing breaks while a machine waits. `oxagen agent enroll` and
 * `oxagen agent status` move it: each live agent whose `host.json` still
 * names a `tacho` executable is re-applied with the `oxagen` CLI's runtime
 * commands. The re-apply is `enroll`'s own (`repointCommands`), so
 * `host.json`, the Claude Code, Codex, Cursor, and Stella hook files, the
 * managed settings, Claude Code's credential helper, and the service unit
 * move together, and a host never runs its hook from one install and its
 * daemon from another.
 */
import { posix, win32 } from "node:path";
import { agentIsLive, listAgents } from "../host/agents";
import { harnessFilesRecord, type HostFile } from "../host/host-file";
import type { ModelCredentialHarness } from "../host/model-credential";
import type { TachoPaths } from "../host/paths";
import type { TachoHarness } from "../wire";
import { depsForAgent } from "./agent-deps";
import { type CredentialMode, MODEL_CREDENTIAL_HARNESSES } from "./credential";
import type { CliDeps } from "./deps";
import { enroll, type EnrollOptions, type EnrollResult } from "./enroll";

/** One agent the move re-applied. */
export interface MovedAgent {
  agentKey: string;
  /** The hook command `host.json` named before the move. */
  from: string;
  ok: boolean;
  /**
   * Set when the move left the agent alone because its recorded harness
   * files are not where this process finds them. A plain re-run from the
   * same shell would leave it again, so the caller says what else to do.
   */
  skipped?: "harness_files_elsewhere";
}

/** The base name of one executable word, without a Windows `.exe`. */
function executableName(word: string): string {
  const base = (/^[A-Za-z]:\\|\\/.test(word) ? win32 : posix).basename(word);
  return base.replace(/\.exe$/i, "").toLowerCase();
}

/**
 * The `tacho` executable's name: `tacho`, or the release asset name Scoop
 * installs it under, which adds the target triple
 * (`tacho-x86_64-pc-windows-msvc`).
 */
const TACHO_NAME = /^tacho(?:-[a-z0-9_]+(?:-[a-z0-9_]+){2,3})?$/;

/**
 * Whether `host.json` still runs the recorder under a `tacho` name: the hook
 * is `tacho-hook`, `tacho-hook.mjs`, or `tacho hook`, or the daemon is
 * `tachod`, `tachod.mjs`, or `tacho daemon`. `tacho` may carry the target
 * triple Scoop's asset name adds.
 */
export function namesTachoExecutable(
  host: Pick<HostFile, "hook_command" | "daemon_command">,
): boolean {
  const legacyHook =
    /(?:^|[\s'"/\\])tacho-hook(?:\.mjs)?(?=$|[\s'"])/i.test(
      host.hook_command,
    ) ||
    /(?:^|[\s'"/\\])tacho(?:-[a-z0-9_]+(?:-[a-z0-9_]+){2,3})?(?:\.exe)?['"]?\s+hook(?=$|\s)/i.test(
      host.hook_command,
    );
  const legacyDaemon = host.daemon_command.some((word, index) => {
    const name = executableName(word);
    if (name === "tachod" || name === "tachod.mjs") return true;
    return (
      TACHO_NAME.test(name) && host.daemon_command[index + 1] === "daemon"
    );
  });
  return legacyHook || legacyDaemon;
}

/**
 * The harness files `host.json` recorded at enroll that this process finds
 * somewhere else. An enroll run from a shell with another CLAUDE_CONFIG_DIR,
 * CODEX_HOME, CURSOR_CONFIG_DIR, or STELLA_HOME wrote its hooks to files
 * this process does not resolve. Empty when the host recorded none.
 */
function relocatedHarnessFiles(
  host: HostFile,
  paths: TachoPaths,
): { recorded: string; here: string }[] {
  const recorded: Record<string, unknown> = host.harness_files ?? {};
  const named = (value: unknown): string => {
    const files = [value]
      .flat()
      .filter((path): path is string => typeof path === "string");
    return files.length > 0 ? files.join(", ") : "(none)";
  };
  return Object.entries(harnessFilesRecord(paths)).flatMap(([key, here]) => {
    const then = recorded[key];
    return then === undefined || JSON.stringify(then) === JSON.stringify(here)
      ? []
      : [{ recorded: named(then), here: named(here) }];
  });
}

/**
 * How the agent's model credentials are held now, so the re-apply keeps
 * that. `enroll` brokers by default, and a machine left on passthrough must
 * not have its keys taken because someone ran `status`. Undefined when the
 * deps cannot read credential state.
 */
async function currentCredentialMode(
  host: HostFile,
  deps: CliDeps,
): Promise<CredentialMode | undefined> {
  if (deps.modelCredentials === undefined) return undefined;
  const harnesses = host.harnesses.filter((harness) =>
    (MODEL_CREDENTIAL_HARNESSES as readonly string[]).includes(harness),
  ) as ModelCredentialHarness[];
  if (harnesses.length === 0) return undefined;
  const state = await deps.modelCredentials.read({
    home: deps.home,
    harnesses,
    helperCommand: deps.runtime.credentialHelperCommand,
  });
  return state.harnesses.some((entry) => entry.brokered)
    ? "brokered"
    : "passthrough";
}

/**
 * Re-apply every live agent whose `host.json` names a `tacho` executable,
 * with `deps.runtime`, which must name the `oxagen` CLI. Returns one entry
 * per agent it re-applied, or left as it was because this process finds its
 * harness files somewhere other than where its enroll wrote them; an empty
 * list when nothing needed moving or the runtime cannot be recorded (a
 * transient or missing executable, or a run from source). `run` is
 * `enroll`; a test may pass a stand-in.
 */
export async function moveOffTachoNames(
  deps: CliDeps,
  run: (options: EnrollOptions, deps: CliDeps) => Promise<EnrollResult> = enroll,
): Promise<MovedAgent[]> {
  const runtime = deps.runtime;
  if (
    runtime.program !== "oxagen" ||
    runtime.transient !== undefined ||
    runtime.executableProblem !== undefined
  )
    return [];
  const moved: MovedAgent[] = [];
  for (const agent of listAgents(deps.paths)) {
    if (!agentIsLive(agent) || !namesTachoExecutable(agent.host)) continue;
    const host = agent.host;
    // This runs on every `oxagen agent status`, often from the desktop app,
    // whose environment rarely sets the harness homes the enrolling shell
    // did. A re-apply from here would write hooks to files the harness does
    // not read, and record those files, so a later unenroll would miss the
    // hooks that still run.
    const relocated = relocatedHarnessFiles(host, agent.paths);
    if (relocated.length > 0) {
      deps.err(
        `${host.agent_key} was enrolled with its harness files at ${relocated.map((file) => file.recorded).join(", ")}, and this command finds them at ${relocated.map((file) => file.here).join(", ")}, so its hooks stay where they are. Run \`oxagen agent enroll\` from a shell that sets the harness homes it was enrolled with, such as CLAUDE_CONFIG_DIR.`,
      );
      moved.push({
        agentKey: host.agent_key,
        from: host.hook_command,
        ok: false,
        skipped: "harness_files_elsewhere",
      });
      continue;
    }
    const own = depsForAgent(deps, agent);
    const credentials = await currentCredentialMode(host, own);
    // A machine enrolled with --no-service runs the daemon some other way,
    // and a re-apply must not install a service it never had.
    const serviceInstalled = deps.serviceManager.status().installed;
    const result = await run(
      {
        harnesses: host.harnesses as TachoHarness[],
        ...(credentials !== undefined ? { credentials } : {}),
        ...(serviceInstalled ? {} : { service: false }),
      },
      own,
    );
    moved.push({
      agentKey: host.agent_key,
      from: host.hook_command,
      ok: result.ok,
    });
  }
  return moved;
}
