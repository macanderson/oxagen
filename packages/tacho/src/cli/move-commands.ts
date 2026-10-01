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
import type { HostFile } from "../host/host-file";
import type { ModelCredentialHarness } from "../host/model-credential";
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
}

/** The base name of one executable word, without a Windows `.exe`. */
function executableName(word: string): string {
  const base = (/^[A-Za-z]:\\|\\/.test(word) ? win32 : posix).basename(word);
  return base.replace(/\.exe$/i, "").toLowerCase();
}

/**
 * Whether `host.json` still runs the recorder under a `tacho` name: the hook
 * is `tacho-hook`, `tacho-hook.mjs`, or `tacho hook`, or the daemon is
 * `tachod`, `tachod.mjs`, or `tacho daemon`.
 */
export function namesTachoExecutable(
  host: Pick<HostFile, "hook_command" | "daemon_command">,
): boolean {
  const legacyHook =
    /(?:^|[\s'"/\\])tacho-hook(?:\.mjs)?(?=$|[\s'"])/i.test(
      host.hook_command,
    ) ||
    /(?:^|[\s'"/\\])tacho(?:\.exe)?['"]?\s+hook(?=$|\s)/i.test(
      host.hook_command,
    );
  const legacyDaemon = host.daemon_command.some((word, index) => {
    const name = executableName(word);
    if (name === "tachod" || name === "tachod.mjs") return true;
    return name === "tacho" && host.daemon_command[index + 1] === "daemon";
  });
  return legacyHook || legacyDaemon;
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
 * per agent it re-applied; an empty list when nothing needed moving or the
 * runtime cannot be recorded (a transient or missing executable, or a run
 * from source). `run` is `enroll`; a test may pass a stand-in.
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
      deps,
    );
    moved.push({
      agentKey: host.agent_key,
      from: host.hook_command,
      ok: result.ok,
    });
  }
  return moved;
}
