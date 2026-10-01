/**
 * `oxagen agent enroll --token <one-time token>` — the scripted path of the
 * register flow (MC spec §14.1; #2967): put this machine under Oxagen control
 * as the registered agent the token names. No `oxagen login` is needed; the
 * token is the credential, and the control plane answers the organization
 * and workspace it belongs to. The work is `@oxagen/recorder/cli`'s `enroll`,
 * the same routine `oxagen agent enroll` runs with the CLI's own session, and
 * what it writes into the machine names `oxagen hook` and `oxagen daemon`
 * (#4879).
 */
import { getApiUrl } from "../lib/config.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import { moveOffTacho } from "./move-off-tacho.js";

export interface AgentEnrollOptions {
  token: string;
  /** `claude-code`, `codex`, `cursor`, `stella`, or a comma list. */
  harness?: string;
  port?: number;
  service?: boolean;
  force?: boolean;
  /** The control plane's base URL (default: the CLI's). */
  apiUrl?: string;
  /** `brokered` (the default) or `passthrough` (ADR-143). */
  credentials?: string;
  validityDays?: number;
}

export async function handleAgentEnroll(
  opts: AgentEnrollOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const {
    defaultCliDeps,
    enroll,
    oxagenRuntimeCommands,
    parseCredentialMode,
    parseHarnesses,
  } = await import("@oxagen/recorder/cli");
  const deps = defaultCliDeps({
    out: (line) => writer.write(line),
    err: (line) => writer.writeErr(line),
    runtime: oxagenRuntimeCommands(),
  });
  const result = await enroll(
    {
      enrollmentToken: opts.token,
      apiUrl: opts.apiUrl ?? getApiUrl(),
      ...(opts.harness !== undefined
        ? { harnesses: parseHarnesses(opts.harness) }
        : {}),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.service !== undefined ? { service: opts.service } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
      ...(opts.credentials !== undefined
        ? { credentials: parseCredentialMode(opts.credentials) }
        : {}),
      ...(opts.validityDays !== undefined
        ? { validityDays: opts.validityDays }
        : {}),
    },
    deps,
  );
  if (!result.ok) return false;
  // The other agents on this machine move to the new names too.
  await moveOffTacho(writer);
  return true;
}
