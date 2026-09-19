/**
 * `oxagen agent enroll --token <one-time token>` — the scripted path of the
 * register flow (MC spec §14.1; #2967): put this machine under Oxagen control
 * as the registered agent the token names. No `oxagen login` is needed; the
 * token is the credential, and the control plane answers the organization
 * and workspace it belongs to. The work is `@oxagen/tacho/cli`'s `enroll`,
 * the same routine `oxagen tacho enroll` runs with the CLI's own session.
 */
import { getApiUrl } from "../lib/config.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export interface AgentEnrollOptions {
  token: string;
  /** `claude-code`, `codex`, `cursor`, `stella`, or a comma list. */
  harness?: string;
  port?: number;
  service?: boolean;
  force?: boolean;
}

export async function handleAgentEnroll(
  opts: AgentEnrollOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<boolean> {
  const { defaultCliDeps, enroll, parseHarnesses } = await import(
    "@oxagen/tacho/cli"
  );
  const deps = defaultCliDeps({
    out: (line) => writer.write(line),
    err: (line) => writer.writeErr(line),
  });
  const result = await enroll(
    {
      enrollmentToken: opts.token,
      apiUrl: getApiUrl(),
      ...(opts.harness !== undefined
        ? { harnesses: parseHarnesses(opts.harness) }
        : {}),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.service !== undefined ? { service: opts.service } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
    },
    deps,
  );
  return result.ok;
}
