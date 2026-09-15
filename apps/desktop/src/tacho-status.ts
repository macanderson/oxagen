/**
 * `tacho status --json` as the app reads it: the document the CLI prints
 * (packages/tacho/src/cli/status.ts, `StatusReport`), narrowed to the
 * members the panels show. Parsing is a pure function of the sidecar's
 * stdout so it can be tested without a webview or a binary.
 */
export interface TachoHookPresence {
  complete: boolean;
  present: string[];
  missing: string[];
}

export interface TachoStatus {
  enrolled: boolean;
  hooks?: TachoHookPresence;
  codexHooks?: TachoHookPresence;
  service?: { kind: string; installed: boolean; running: boolean };
  wal?: { sessions: number; unshipped: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function presence(value: unknown): TachoHookPresence | undefined {
  if (!isRecord(value) || typeof value["complete"] !== "boolean")
    return undefined;
  const strings = (list: unknown): string[] =>
    Array.isArray(list)
      ? list.filter((x): x is string => typeof x === "string")
      : [];
  return {
    complete: value["complete"],
    present: strings(value["present"]),
    missing: strings(value["missing"]),
  };
}

/**
 * The status document, or `null` when stdout is not one: empty (the sidecar
 * failed to start), not JSON (a stray warning), or JSON of another shape.
 * Nothing the CLI prints before or after the document is tolerated — the
 * `--json` mode writes the document alone, and a partial read must not be
 * mistaken for "not enrolled".
 */
export function parseTachoStatus(stdout: string): TachoStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed["enrolled"] !== "boolean") return null;
  const status: TachoStatus = { enrolled: parsed["enrolled"] };
  const hooks = presence(parsed["hooks"]);
  if (hooks !== undefined) status.hooks = hooks;
  const codexHooks = presence(parsed["codexHooks"]);
  if (codexHooks !== undefined) status.codexHooks = codexHooks;
  const service = parsed["service"];
  if (
    isRecord(service) &&
    typeof service["kind"] === "string" &&
    typeof service["installed"] === "boolean" &&
    typeof service["running"] === "boolean"
  ) {
    status.service = {
      kind: service["kind"],
      installed: service["installed"],
      running: service["running"],
    };
  }
  const wal = parsed["wal"];
  if (
    isRecord(wal) &&
    typeof wal["sessions"] === "number" &&
    typeof wal["unshipped"] === "number"
  ) {
    status.wal = { sessions: wal["sessions"], unshipped: wal["unshipped"] };
  }
  return status;
}
