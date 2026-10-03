/**
 * `tacho export`: a session from the local WAL as `tacho/1.0` NDJSON, a
 * `contextgraph-trace` journal, or OTLP JSON (spec section 6.4).
 */
import { writeFileSync } from "node:fs";
import { exportSession, type ExportFormat } from "../collector/exporters";
import { listAgents } from "../host/agents";
import { Wal } from "../host/wal";
import type { CliDeps } from "./deps";

export interface ExportOptions {
  /** Claude Code session id or Tacho session uuid; `list` prints what is there. */
  session?: string;
  format?: ExportFormat;
  out?: string;
  list?: boolean;
}

/** Resolve a harness session id or a uuid to the WAL file's uuid. */
export function resolveSessionUuid(wal: Wal, key: string): string | undefined {
  const sessions = wal.sessions();
  if (sessions.includes(key)) return key;
  for (const uuid of sessions) {
    const head = wal.read(uuid)[0];
    if (head?.session_id === key) return uuid;
  }
  return undefined;
}

/**
 * The WAL directory of every agent on this machine (ADR-203), oldest first,
 * then the one `deps.paths` names when it is not among them, as on a machine
 * with no agent. Each agent records into its own WAL, so a session the
 * second agent recorded is only in the second one.
 */
function walDirs(deps: CliDeps): string[] {
  const dirs = listAgents(deps.paths).map((agent) => agent.paths.wal);
  if (!dirs.includes(deps.paths.wal)) dirs.push(deps.paths.wal);
  return dirs;
}

export async function exportCommand(
  options: ExportOptions,
  deps: CliDeps,
): Promise<boolean> {
  const dirs = walDirs(deps);
  const wals = dirs.map((dir) => new Wal(dir));
  if (options.list === true || options.session === undefined) {
    const rows = wals.flatMap((wal) =>
      wal.sessions().map((uuid) => {
        const events = wal.read(uuid);
        const first = events[0];
        const last = events[events.length - 1];
        return `${uuid}  ${first?.session_id ?? "?"}  ${events.length} events  ${first?.ts ?? ""} .. ${last?.ts ?? ""}${last?.kind === "agent_stop" ? "  sealed" : ""}`;
      }),
    );
    deps.out(
      rows.length > 0 ? rows.join("\n") : `no sessions in ${dirs.join(" or ")}`,
    );
    return true;
  }
  const session = options.session;
  let found: { wal: Wal; uuid: string } | undefined;
  for (const wal of wals) {
    const uuid = resolveSessionUuid(wal, session);
    if (uuid !== undefined) {
      found = { wal, uuid };
      break;
    }
  }
  if (found === undefined) {
    deps.err(`no session ${session} in ${dirs.join(" or ")}`);
    return false;
  }
  const text = exportSession(
    found.wal.read(found.uuid),
    options.format ?? "tacho",
  );
  if (options.out !== undefined) {
    // An export carries the run's prompts, tool input and output: private
    // to its owner, like the WAL it came from.
    writeFileSync(options.out, text, { mode: 0o600 });
    deps.out(`wrote ${options.out}`);
  } else {
    deps.out(text.replace(/\n$/, ""));
  }
  return true;
}
