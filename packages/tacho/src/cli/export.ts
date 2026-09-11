/**
 * `tacho export`: a session from the local WAL as `tacho/1.0` NDJSON, a
 * `contextgraph-trace` journal, or OTLP JSON (spec section 6.4).
 */
import { writeFileSync } from "node:fs";
import { exportSession, type ExportFormat } from "../collector/exporters";
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

export async function exportCommand(
  options: ExportOptions,
  deps: CliDeps,
): Promise<boolean> {
  const wal = new Wal(deps.paths.wal);
  if (options.list === true || options.session === undefined) {
    const rows = wal.sessions().map((uuid) => {
      const events = wal.read(uuid);
      const first = events[0];
      const last = events[events.length - 1];
      return `${uuid}  ${first?.session_id ?? "?"}  ${events.length} events  ${first?.ts ?? ""} .. ${last?.ts ?? ""}${last?.kind === "agent_stop" ? "  sealed" : ""}`;
    });
    deps.out(
      rows.length > 0 ? rows.join("\n") : `no sessions in ${deps.paths.wal}`,
    );
    return true;
  }
  const uuid = resolveSessionUuid(wal, options.session);
  if (uuid === undefined) {
    deps.err(`no session ${options.session} in ${deps.paths.wal}`);
    return false;
  }
  const text = exportSession(wal.read(uuid), options.format ?? "tacho");
  if (options.out !== undefined) {
    writeFileSync(options.out, text);
    deps.out(`wrote ${options.out}`);
  } else {
    deps.out(text.replace(/\n$/, ""));
  }
  return true;
}
