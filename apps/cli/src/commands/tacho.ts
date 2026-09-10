/**
 * `oxagen tacho` — put this machine's Claude Code sessions under Oxagen
 * control (docs/specs/tacho/spec.md section 5.1).
 *
 *   oxagen tacho enroll     enroll this host: device key, host API key, tachod service, hooks
 *   oxagen tacho status     enrollment, daemon, hooks, bundle, spool
 *   oxagen tacho unenroll   remove hooks and service, revoke, delete the host key
 *   oxagen tacho export     a session from the local WAL (tacho | trace | otlp)
 *   oxagen tacho verify     one headless Claude Code turn, confirmed chained
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
} from "../lib/config.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export interface TachoEnrollOptions {
  token?: string;
  org?: string;
  workspace?: string;
  managed?: boolean;
  printManaged?: boolean;
  port?: number;
  service?: boolean;
  force?: boolean;
  verify?: boolean;
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
  const { enroll, verify } = await import("@oxagen/tacho/cli");
  const deps = await tachoDeps(writer);
  const result = await enroll(
    {
      ...tachoCredentials(opts),
      ...(opts.managed !== undefined ? { managed: opts.managed } : {}),
      ...(opts.printManaged !== undefined
        ? { printManaged: opts.printManaged }
        : {}),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.service !== undefined ? { service: opts.service } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
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
  const result = await unenroll(
    { ...tachoCredentials(opts), ...opts },
    await tachoDeps(writer),
  );
  return result.ok;
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
