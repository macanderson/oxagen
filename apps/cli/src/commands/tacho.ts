/**
 * `oxagen tacho` — put this machine's Claude Code sessions under Oxagen
 * control (docs/specs/tacho/spec.md section 5.1).
 *
 *   oxagen tacho enroll     enroll this host: device key, host API key, tachod service, hooks
 *   oxagen tacho status     enrollment, daemon, hooks, bundle, spool
 *   oxagen tacho reassign   move the host to another workspace; --default moves the CLI default too
 *   oxagen tacho unenroll   remove hooks and service, revoke, delete the host key
 *   oxagen tacho export     a session from the local WAL (tacho | trace | otlp)
 *   oxagen tacho verify     one headless Claude Code turn, confirmed chained
 *   oxagen tacho hosts      every machine enrolled in this workspace, with its tier
 *
 * The work lives in `@oxagen/tacho/cli`; this module only supplies the CLI's
 * own credentials (`oxagen login`, or OXAGEN_* env) and output plumbing, so
 * `oxagen tacho enroll` needs no --token when the user is logged in.
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

export interface TachoEnrollOptions {
  token?: string;
  org?: string;
  workspace?: string;
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
  harness?: string;
  reason?: string;
  /**
   * `--default`: after a successful reassign, also make the host's new org
   * and workspace the CLI's default pair in config.json. The CLI owns that
   * file; @oxagen/tacho only ever writes host.json.
   */
  default?: boolean;
}

export interface TachoUnenrollOptions {
  token?: string;
  purge?: boolean;
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

async function tachoDeps(writer: CommandWriter) {
  const { defaultCliDeps } = await import("@oxagen/tacho/cli");
  return defaultCliDeps({
    out: (line) => writer.write(line),
    err: (line) => writer.writeErr(line),
  });
}

export async function handleTachoEnroll(
  opts: TachoEnrollOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { enroll, parseHarnesses, verify } = await import("@oxagen/tacho/cli");
  const deps = await tachoDeps(writer);
  // Without `apiUrl`: tacho reads the same env and config.json when the
  // machine has no host yet, and on an enrolled host its own `api_url` must
  // win, which an explicit value here would override.
  const { apiUrl: _cliDefaultApiUrl, ...credentials } = tachoCredentials(opts);
  const result = await enroll(
    {
      ...credentials,
      ...(opts.managed !== undefined ? { managed: opts.managed } : {}),
      ...(opts.printManaged !== undefined
        ? { printManaged: opts.printManaged }
        : {}),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.service !== undefined ? { service: opts.service } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.harness !== undefined
        ? { harnesses: parseHarnesses(opts.harness) }
        : {}),
    },
    deps,
  );
  if (!result.ok) return false;
  if (opts.verify === true) {
    const verified = await verify({}, deps);
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
  const { status } = await import("@oxagen/tacho/cli");
  const report = await status(opts, await tachoDeps(writer));
  return report.enrolled;
}

export async function handleTachoUnenroll(
  opts: TachoUnenrollOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { unenroll } = await import("@oxagen/tacho/cli");
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
    },
    await tachoDeps(writer),
  );
  return result.ok;
}

export async function handleTachoReassign(
  opts: TachoReassignOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { parseHarnesses, reassign } = await import("@oxagen/tacho/cli");
  const credentials = tachoCredentials(opts);
  const result = await reassign(
    {
      ...(credentials.token !== undefined ? { token: credentials.token } : {}),
      ...(opts.org !== undefined ? { org: opts.org } : {}),
      ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts.harness !== undefined
        ? { harnesses: parseHarnesses(opts.harness) }
        : {}),
    },
    await tachoDeps(writer),
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
  const { exportCommand } = await import("@oxagen/tacho/cli");
  return exportCommand(opts, await tachoDeps(writer));
}

export async function handleTachoVerify(
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { verify } = await import("@oxagen/tacho/cli");
  const result = await verify({}, await tachoDeps(writer));
  writer.write(result.ok ? `OK: ${result.detail}` : `FAILED: ${result.detail}`);
  return result.ok;
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
 * `oxagen tacho hosts` — the fleet, from the control plane rather than from
 * this machine's `host.json`. Unlike the other `tacho` subcommands this one
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
 * ADR-152). The platform CLI adds nothing to the run: tacho's own command
 * asks the local daemon, which measures and registers the container before
 * the agent starts.
 */
export async function handleContainedRun(
  command: string[],
  opts: { image?: string; workspace?: string; githubRepository?: string },
  writer: CommandWriter = stdoutWriter,
): Promise<number> {
  const { runContained } = await import("@oxagen/tacho/cli");
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
