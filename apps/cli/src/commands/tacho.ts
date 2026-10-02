/**
 * `oxagen agent <verb>` for this machine: put its agent sessions under Oxagen
 * control (docs/specs/tacho/spec.md section 5.1, #4879).
 *
 *   oxagen agent enroll     enroll this host: device key, host API key, collector service, hooks
 *   oxagen agent status     enrollment, daemon, hooks, bundle, spool
 *   oxagen agent reassign   move the host to another workspace; --default moves the CLI default too
 *   oxagen agent unenroll   remove hooks and service, revoke, delete the host key
 *   oxagen agent uninstall  unenroll every agent, then remove what the desktop app put here
 *   oxagen agent export     a session from the local WAL (tacho | trace | otlp)
 *   oxagen agent verify     one headless harness turn, confirmed chained
 *   oxagen agent backfill   record the Claude Code sessions run before enrollment
 *   oxagen agent hosts      every machine enrolled in this workspace, with its tier
 *   oxagen agent run        one agent session under Oxagen control
 *   oxagen agent detect     which harnesses this machine has, and which are enrolled
 *   oxagen work list        the work orders waiting on this machine
 *   oxagen work start       claim a work order and start its agent here
 *
 * The hidden `oxagen tacho <verb>` group calls the same handlers. The work
 * lives in `@oxagen/recorder/cli`; this module supplies the CLI's own
 * credentials (`oxagen login`, or OXAGEN_* env), its output plumbing, and
 * its runtime commands, so what enrollment writes into a machine names
 * `oxagen hook` and `oxagen daemon`, and `oxagen agent enroll` needs no
 * --token when the user is logged in.
 */
import {
  getApiUrl,
  getOrgId,
  getToken,
  getWorkspaceId,
  writeConfig,
} from "../lib/config.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { apiPostOrThrow, printTable } from "../lib/api.js";
import { moveOffTacho } from "./move-off-tacho.js";

export interface TachoEnrollOptions {
  token?: string;
  org?: string;
  workspace?: string;
  /** The control plane's base URL, when it is not the one `oxagen login` chose. */
  apiUrl?: string;
  /** `brokered` (the default) or `passthrough` (ADR-143). */
  credentials?: string;
  validityDays?: number;
  managed?: boolean;
  printManaged?: boolean;
  port?: number;
  service?: boolean;
  force?: boolean;
  /** `claude-code`, `codex`, `cursor`, `stella`, or a comma list. */
  harness?: string;
  verify?: boolean;
}

export interface TachoReassignOptions {
  token?: string;
  org?: string;
  workspace?: string;
  apiUrl?: string;
  harness?: string;
  reason?: string;
  /**
   * `--default`: after a successful reassign, also make the host's new org
   * and workspace the CLI's default pair in config.json. The CLI owns that
   * file; @oxagen/recorder only ever writes host.json.
   */
  default?: boolean;
}

export interface TachoUnenrollOptions {
  token?: string;
  purge?: boolean;
  reason?: string;
  /** The agent to remove, by the one harness it hooks (ADR-203). */
  harness?: string;
  /** Remove every agent enrolled on this machine. */
  all?: boolean;
}

export interface TachoUninstallOptions {
  token?: string;
  reason?: string;
}

export interface TachoExportOptions {
  session?: string;
  format?: "tacho" | "trace" | "otlp";
  out?: string;
  list?: boolean;
}

/** The credentials the platform CLI already holds, for the tacho commands. */
export function tachoCredentials(
  overrides: { token?: string; org?: string; workspace?: string } = {},
): { token?: string; org?: string; workspace?: string; apiUrl: string } {
  const token = overrides.token ?? getToken();
  const org = overrides.org ?? getOrgId();
  const workspace = overrides.workspace ?? getWorkspaceId();
  return {
    ...(token !== undefined ? { token } : {}),
    ...(org !== undefined ? { org } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    apiUrl: getApiUrl(),
  };
}

/**
 * The recorder's deps for a command the CLI runs: its output goes through
 * the CLI's writer, and its runtime commands name this `oxagen` executable,
 * so every hook, service unit, and credential helper an enroll writes runs
 * `oxagen` (#4879). `recorded` binds the harness files the machine's enroll
 * recorded, which `unenroll` and `reassign` take hooks back out of, whatever
 * this shell's environment says.
 */
async function tachoDeps(writer: CommandWriter, recorded = false) {
  const { defaultCliDeps, oxagenRuntimeCommands } = await import(
    "@oxagen/recorder/cli"
  );
  const overrides = {
    out: (line: string) => writer.write(line),
    err: (line: string) => writer.writeErr(line),
    runtime: oxagenRuntimeCommands(),
  };
  if (!recorded) return defaultCliDeps(overrides);
  const { recordedCliDeps } = await import("@oxagen/recorder/program");
  return recordedCliDeps(overrides);
}

export async function handleTachoEnroll(
  opts: TachoEnrollOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { enroll, parseCredentialMode, parseHarnesses, verify } =
    await import("@oxagen/recorder/cli");
  const deps = await tachoDeps(writer);
  // Without the CLI's default `apiUrl`: the recorder reads the same env and
  // config.json when the machine has no host yet, and on an enrolled host its
  // own `api_url` must win, which an implicit value here would override. An
  // explicit --api-url is the operator's, and goes through.
  const { apiUrl: _cliDefaultApiUrl, ...credentials } = tachoCredentials(opts);
  const harnesses =
    opts.harness !== undefined ? parseHarnesses(opts.harness) : undefined;
  const result = await enroll(
    {
      ...credentials,
      ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
      ...(opts.credentials !== undefined
        ? { credentials: parseCredentialMode(opts.credentials) }
        : {}),
      ...(opts.validityDays !== undefined
        ? { validityDays: opts.validityDays }
        : {}),
      ...(opts.managed !== undefined ? { managed: opts.managed } : {}),
      ...(opts.printManaged !== undefined
        ? { printManaged: opts.printManaged }
        : {}),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.service !== undefined ? { service: opts.service } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(harnesses !== undefined ? { harnesses } : {}),
    },
    deps,
  );
  if (!result.ok) return false;
  // The other agents on this machine move to the new names too, unless this
  // run only printed the managed settings document.
  if (opts.printManaged !== true) await moveOffTacho(writer);
  if (opts.verify === true) {
    // Drive a harness this enrollment hooks, so the turn lands in the
    // collector just enrolled (ADR-203), the way the recorder's own
    // `enroll --verify` does.
    const wrapped = harnesses?.find((harness) => harness !== "claude-desktop");
    const verified = await verify(
      wrapped !== undefined ? { harness: wrapped } : {},
      deps,
    );
    writer.write(
      verified.ok
        ? `Verified: ${verified.detail}`
        : `Verify failed: ${verified.detail}`,
    );
    return verified.ok;
  }
  return true;
}

export async function handleTachoStatus(
  opts: { json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { status } = await import("@oxagen/recorder/cli");
  // Before the report, so it describes the machine as it now is.
  await moveOffTacho(writer);
  const report = await status(opts, await tachoDeps(writer));
  // The same exit rule as `tacho status`: a host whose events are not
  // reaching Oxagen is not working, and every agent on the machine counts.
  const reports = [report, ...(report.enrollments ?? [])];
  return (
    report.enrolled &&
    !reports.some((entry) => entry.shipping?.healthy === false)
  );
}

export async function handleTachoUnenroll(
  opts: TachoUnenrollOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { parseHarnesses, unenroll } = await import("@oxagen/recorder/cli");
  // `--harness` names one agent, so it takes one harness, as `tacho
  // unenroll` does.
  const harnesses =
    opts.harness !== undefined ? parseHarnesses(opts.harness) : undefined;
  const [harness] = harnesses ?? [];
  if (harnesses !== undefined && harnesses.length !== 1)
    throw new Error("--harness names one harness");
  // Only the token is lent: the revoke targets the org and workspace in
  // host.json, and the CLI's default pair may name another org (the app's
  // "also make it the CLI default" is optional, and `oxagen login --org`
  // rescopes config.json without touching the host), which would 403.
  const { token } = tachoCredentials(opts);
  const result = await unenroll(
    {
      ...(token !== undefined ? { token } : {}),
      ...(opts.purge !== undefined ? { purge: opts.purge } : {}),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(harness !== undefined ? { harness } : {}),
      ...(opts.all === true ? { all: true } : {}),
    },
    await tachoDeps(writer, true),
  );
  return result.ok;
}

/**
 * `oxagen agent uninstall`: unenroll every agent on this machine, then take
 * off what the desktop app put here, from the journal it keeps (ADR-230).
 * It works with the app already gone, from the app's per-user copy of this
 * CLI.
 */
export async function handleTachoUninstall(
  opts: TachoUninstallOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { uninstall } = await import("@oxagen/recorder/cli");
  // Only the token is lent, for the reason `handleTachoUnenroll` gives.
  const { token } = tachoCredentials(opts);
  const result = await uninstall(
    {
      ...(token !== undefined ? { token } : {}),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    },
    await tachoDeps(writer, true),
  );
  return result.ok;
}

export async function handleTachoReassign(
  opts: TachoReassignOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { parseHarnesses, reassign } = await import("@oxagen/recorder/cli");
  const credentials = tachoCredentials(opts);
  const result = await reassign(
    {
      ...(credentials.token !== undefined ? { token: credentials.token } : {}),
      ...(opts.org !== undefined ? { org: opts.org } : {}),
      ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
      ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts.harness !== undefined
        ? { harnesses: parseHarnesses(opts.harness) }
        : {}),
    },
    await tachoDeps(writer, true),
  );
  if (!result.ok) return false;
  if (opts.default === true && result.to !== undefined) {
    writeConfig({
      orgSlug: result.to.org,
      workspaceSlug: result.to.workspace,
    });
    writer.write(
      `CLI default is now ${result.to.org}/${result.to.workspace} (config.json).`,
    );
  }
  return true;
}

export async function handleTachoExport(
  opts: TachoExportOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { exportCommand } = await import("@oxagen/recorder/cli");
  return exportCommand(opts, await tachoDeps(writer));
}

/**
 * `oxagen agent backfill`: record the Claude Code sessions this machine ran
 * before it enrolled (ADR-161). Answers the exit code: 0 finished, 1
 * stopped, 2 invalid options, 3 no daemon, 4 not enrolled.
 */
export async function handleTachoBackfill(
  opts: {
    since?: string;
    until?: string;
    project?: string[];
    excludeProject?: string[];
    session?: string[];
    dryRun?: boolean;
    json?: boolean;
  },
  writer: CommandWriter = stdoutWriter,
): Promise<number> {
  const { backfillCommand } = await import("@oxagen/recorder/cli");
  return backfillCommand(opts, await tachoDeps(writer));
}

export async function handleTachoVerify(
  opts: { harness?: string; json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { parseHarnesses, verify } = await import("@oxagen/recorder/cli");
  const [harness] =
    opts.harness !== undefined ? parseHarnesses(opts.harness) : [];
  const result = await verify(
    harness !== undefined ? { harness } : {},
    await tachoDeps(writer),
  );
  if (opts.json === true) writer.write(JSON.stringify(result));
  else
    writer.write(
      result.ok ? `OK: ${result.detail}` : `FAILED: ${result.detail}`,
    );
  return result.ok;
}

/** `oxagen agent detect`: which harnesses this machine has, and which are enrolled. */
export async function handleAgentDetect(
  opts: { json?: boolean },
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { detect } = await import("@oxagen/recorder/cli");
  detect(
    opts.json !== undefined ? { json: opts.json } : {},
    await tachoDeps(writer),
  );
  return true;
}

export interface AgentRunOptions {
  name?: string;
  contained?: boolean;
  image?: string;
  workspace?: string;
  githubRepository?: string;
}

/**
 * `oxagen agent run -- <command>`: one agent session under Oxagen control.
 * A custom agent is recorded under its name, a wrapped harness through its
 * own hooks, and `--contained` starts Claude Code or Codex in the contained
 * launcher (`runAgentSession` in the recorder).
 */
export async function handleAgentRun(
  command: string[],
  opts: AgentRunOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<number> {
  const { runAgentSession } = await import("@oxagen/recorder/cli");
  const deps = await tachoDeps(writer);
  const controller = new AbortController();
  const stop = () => controller.abort();
  // Only the contained launcher stops on these; a session's own agent
  // receives the terminal's signals itself (`spawnAgent`).
  if (opts.contained === true) {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
  try {
    return await runAgentSession(
      {
        command,
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(opts.contained === true ? { contained: true } : {}),
        ...(opts.image !== undefined ? { image: opts.image } : {}),
        ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
        ...(opts.githubRepository !== undefined
          ? { githubRepository: opts.githubRepository }
          : {}),
      },
      {
        ...deps,
        cwd: process.cwd(),
        signal: controller.signal,
        write: (stream, text) =>
          (stream === "stdout" ? process.stdout : process.stderr).write(text),
      },
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

/**
 * `oxagen work list`: the work orders Oxagen sent to the agents on this
 * machine that no one has started yet (`workList` in the recorder).
 */
export async function handleWorkList(
  writer: CommandWriter = stdoutWriter,
): Promise<number> {
  const { workList } = await import("@oxagen/recorder/cli");
  const deps = await tachoDeps(writer);
  return workList({ ...deps, cwd: process.cwd() });
}

/**
 * `oxagen work start <wo>`: claim a work order, then start the agent's
 * harness in this directory with the order's first prompt (`workStart` in
 * the recorder, ADR-251). The harness gets the terminal's signals itself.
 */
export async function handleWorkStart(
  workOrderId: string,
  writer: CommandWriter = stdoutWriter,
): Promise<number> {
  const { workStart } = await import("@oxagen/recorder/cli");
  const deps = await tachoDeps(writer);
  return workStart(workOrderId, { ...deps, cwd: process.cwd() });
}

export interface TachoHostsOptions {
  status?: "active" | "paused" | "suspended" | "revoked";
  limit?: number;
  json?: boolean;
}

interface HostRow {
  hostEnrollmentId: string;
  hostname: string;
  status: string;
  harnesses: string[];
  tiers: Record<string, "gateway" | "harness">;
  lastSeenAt: string | null;
  sessionsCount: number;
  incidentsOpen: number;
}

/**
 * `oxagen agent hosts` — the fleet, from the control plane rather than from
 * this machine's `host.json`. Unlike the other machine subcommands this one
 * does no local work at all; it calls `list_tacho_hosts` and prints what came
 * back.
 *
 * Each app is printed with its tier (ADR-078), because "Claude Code, Claude
 * Desktop" says which apps a machine has and nothing about what Oxagen
 * records for them — and those two apps are recorded in entirely different
 * ways. `--json` carries the same `tiers` map the API returns.
 */
export async function handleTachoHosts(
  opts: TachoHostsOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  // Every page. A truncated fleet listing is worse than a slow one: the
  // machine the operator is looking for is simply absent. Bounded so a
  // pathological cursor cannot loop forever.
  const hosts: HostRow[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < 20; page += 1) {
    const chunk = await apiPostOrThrow<{
      hosts: HostRow[];
      nextCursor: string | null;
    }>("tacho/hosts", {
      ...(opts.status ? { status: opts.status } : {}),
      limit: opts.limit ?? 50,
      ...(cursor === undefined ? {} : { cursor }),
    });
    hosts.push(...chunk.hosts);
    if (chunk.nextCursor === null) break;
    cursor = chunk.nextCursor;
    if (page === 19) truncated = true;
  }
  const output = { hosts, nextCursor: truncated ? (cursor ?? null) : null };
  if (opts.json === true) {
    writer.write(JSON.stringify(output, null, 2));
    return true;
  }
  if (output.hosts.length === 0) {
    writer.write("No machines are enrolled in this workspace.");
    return true;
  }
  printTable(
    ["HOST", "STATUS", "APPS", "LAST SEEN", "SESSIONS", "INCIDENTS"],
    output.hosts.map((host) => [
      host.hostname,
      host.status,
      host.harnesses
        .map(
          (harness) =>
            `${harness} (${host.tiers[harness] === "gateway" ? "connected" : "wrapped"})`,
        )
        .join(", "),
      host.lastSeenAt ?? "never",
      String(host.sessionsCount),
      String(host.incidentsOpen),
    ]),
    writer,
  );
  if (output.nextCursor !== null)
    writer.write(
      "\nMore machines follow than this command will page through; narrow with --status.",
    );
  // The legend, every time. "wrapped" and "connected" are not degrees of the
  // same thing, and a reader who assumes they are will read this table wrong.
  writer.write(
    "\nwrapped   every action recorded, and Oxagen does not run the app, so the record is what it reported",
  );
  writer.write(
    "connected only the Oxagen tools it calls, recorded and refused on the server; nothing else it does",
  );
  return true;
}

/**
 * `oxagen run -- <agent> [args...]`: the contained launcher (ADR-096,
 * ADR-152), the same as `oxagen agent run --contained`. The platform CLI adds
 * nothing to the run: the recorder's run command asks the local daemon,
 * which measures and registers the container before the agent starts.
 */
export async function handleContainedRun(
  command: string[],
  opts: { image?: string; workspace?: string; githubRepository?: string },
  writer: CommandWriter = stdoutWriter,
): Promise<number> {
  const { runContained } = await import("@oxagen/recorder/cli");
  const deps = await tachoDeps(writer);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const [agent, ...args] = command;
    return await runContained(
      {
        agent,
        args,
        ...(opts.image !== undefined ? { image: opts.image } : {}),
        ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
        ...(opts.githubRepository !== undefined
          ? { githubRepository: opts.githubRepository }
          : {}),
      },
      {
        ...deps,
        cwd: process.cwd(),
        signal: controller.signal,
        write: (stream, text) =>
          (stream === "stdout" ? process.stdout : process.stderr).write(text),
      },
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
