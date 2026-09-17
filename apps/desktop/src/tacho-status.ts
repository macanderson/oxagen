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

/**
 * What `tacho status` reports about a connected app's MCP config (ADR-078).
 * Not called `hooks`, because there are none.
 */
export interface TachoMcpPresence {
  present: boolean;
  /** An entry from an earlier enrollment is still in the file. */
  foreignEnrollment: boolean;
  /** MCP servers in that app Oxagen does not see. */
  otherServers: number;
  otherServerNames: string[];
}

export interface TachoStatus {
  enrolled: boolean;
  hooks?: TachoHookPresence;
  codexHooks?: TachoHookPresence;
  stellaHooks?: TachoHookPresence;
  /** Present once the host connects Claude Desktop. */
  claudeDesktop?: TachoMcpPresence;
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
 * A connected app's MCP-config presence. Validated like `presence()` rather
 * than cast: `present` is what decides whether the panel calls the row
 * degraded, and `otherServerNames` is the disclosure of what Oxagen does not
 * see in that app — neither may come from an unchecked shape.
 */
function mcpPresence(value: unknown): TachoMcpPresence | undefined {
  if (!isRecord(value) || typeof value["present"] !== "boolean")
    return undefined;
  const names = Array.isArray(value["otherServerNames"])
    ? value["otherServerNames"].filter(
        (x): x is string => typeof x === "string",
      )
    : [];
  return {
    present: value["present"],
    foreignEnrollment: value["foreignEnrollment"] === true,
    // Trust the names over the count: the count is what a surface prints, and
    // a count that disagrees with the list it came from is the kind of thing
    // that turns "2 servers Oxagen cannot see" into a number nobody can check.
    otherServers:
      typeof value["otherServers"] === "number"
        ? value["otherServers"]
        : names.length,
    otherServerNames: names,
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
  const stellaHooks = presence(parsed["stellaHooks"]);
  if (stellaHooks !== undefined) status.stellaHooks = stellaHooks;
  const claudeDesktop = mcpPresence(parsed["claudeDesktop"]);
  if (claudeDesktop !== undefined) status.claudeDesktop = claudeDesktop;
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
