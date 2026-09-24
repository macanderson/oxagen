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

/**
 * The daemon's loopback model proxy (ADR-094), as `tacho status` reports it.
 * Absent while the daemon is down or predates the proxy: that is "no
 * gateway seam yet", never "gateway off".
 */
export interface TachoGateway {
  listening: boolean;
  port: number;
}

/** Whether one harness's model base URL points at the proxy. */
export interface TachoModelBaseUrl {
  harness: string;
  /** Our base URL is the one the file names. */
  ours: boolean;
  /** A managed settings file overrides ours, so calls are not routed. */
  shadowed: boolean;
}

/**
 * The tier ladder word (ADR-095): what a harness's runs actually earned,
 * never what is merely installed. `contained` is the fourth word and has no
 * build yet, so it never appears here.
 */
export type TachoTier = "observe" | "harness" | "gateway";

export interface TachoStatus {
  enrolled: boolean;
  hooks?: TachoHookPresence;
  codexHooks?: TachoHookPresence;
  /**
   * Cursor's hooks, folded from the one entry per file `tacho status` prints
   * (a moved config directory means Oxagen writes two). Complete only when
   * every file is complete, so a half-written pair never reads as covered.
   */
  cursorHooks?: TachoHookPresence;
  stellaHooks?: TachoHookPresence;
  /** Present once the host connects Claude Desktop. */
  claudeDesktop?: TachoMcpPresence;
  service?: {
    kind: string;
    installed: boolean;
    running: boolean | null;
    detail?: string;
  };
  wal?: { sessions: number; unshipped: number };
  /** Present once the daemon reports a well-formed gateway block. */
  gateway?: TachoGateway;
  /** One entry per harness the model base URL contract covers. */
  modelBaseUrls?: TachoModelBaseUrl[];
  /** One entry per harness the credential seam covers (ADR-143). */
  modelCredentials?: TachoModelCredential[];
  /** The tier each harness's sessions earned since the collector started. */
  tiers?: Partial<Record<string, TachoTier>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `tacho status` reports Cursor as a list, one entry per hooks file. The app
 * shows one row per harness, so the list is folded: complete only when every
 * file is, and the missing events are the union. A veto hook someone edited
 * to fail open is counted as missing rather than present, because Cursor
 * allows the action when a fail-open hook cannot answer.
 */
function cursorPresence(value: unknown): TachoHookPresence | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const entries = value
    .map((entry) => presence(entry))
    .filter((entry): entry is TachoHookPresence => entry !== undefined);
  if (entries.length === 0) return undefined;
  const missing = new Set<string>();
  for (const entry of entries)
    for (const event of entry.missing) missing.add(event);
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const failOpen = entry["failOpenEnforcement"];
    if (Array.isArray(failOpen))
      for (const event of failOpen)
        if (typeof event === "string") missing.add(event);
  }
  const present = entries[0]?.present.filter((event) => !missing.has(event));
  return {
    complete: missing.size === 0,
    present: present ?? [],
    missing: [...missing],
  };
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

function gateway(value: unknown): TachoGateway | undefined {
  if (
    !isRecord(value) ||
    typeof value["listening"] !== "boolean" ||
    typeof value["port"] !== "number"
  )
    return undefined;
  return { listening: value["listening"], port: value["port"] };
}

const TIER_WORDS = new Set(["observe", "harness", "gateway"]);

function modelBaseUrls(value: unknown): TachoModelBaseUrl[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: TachoModelBaseUrl[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry["harness"] !== "string") continue;
    out.push({
      harness: entry["harness"],
      ours: entry["ours"] === true,
      shadowed: isRecord(entry["shadowedBy"]),
    });
  }
  return out;
}

function tiers(value: unknown): Partial<Record<string, TachoTier>> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Partial<Record<string, TachoTier>> = {};
  for (const [harness, tier] of Object.entries(value))
    if (typeof tier === "string" && TIER_WORDS.has(tier))
      out[harness] = tier as TachoTier;
  return out;
}

/**
 * How a harness gets its model credential (ADR-143). `brokered`: it holds a
 * run token and the gateway supplies the vendor key from custody. Otherwise
 * its own credential crosses the proxy, and `reason` says why when the file
 * said so (a ChatGPT login, a symlinked file, no file yet, nothing to take).
 */
export interface TachoModelCredential {
  harness: string;
  brokered: boolean;
  reason?: string;
}

function modelCredentials(value: unknown): TachoModelCredential[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: TachoModelCredential[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry["harness"] !== "string") continue;
    const reason = entry["reason"];
    out.push({
      harness: entry["harness"],
      brokered: entry["brokered"] === true,
      ...(typeof reason === "string" ? { reason } : {}),
    });
  }
  return out;
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
  const cursorHooks = cursorPresence(parsed["cursorHooks"]);
  if (cursorHooks !== undefined) status.cursorHooks = cursorHooks;
  const stellaHooks = presence(parsed["stellaHooks"]);
  if (stellaHooks !== undefined) status.stellaHooks = stellaHooks;
  const claudeDesktop = mcpPresence(parsed["claudeDesktop"]);
  if (claudeDesktop !== undefined) status.claudeDesktop = claudeDesktop;
  const service = parsed["service"];
  if (
    isRecord(service) &&
    typeof service["kind"] === "string" &&
    typeof service["installed"] === "boolean" &&
    (typeof service["running"] === "boolean" || service["running"] === null)
  ) {
    status.service = {
      kind: service["kind"],
      installed: service["installed"],
      running: service["running"],
      ...(typeof service["detail"] === "string"
        ? { detail: service["detail"] }
        : {}),
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
  const gatewayBlock = gateway(parsed["gateway"]);
  if (gatewayBlock !== undefined) status.gateway = gatewayBlock;
  const baseUrls = modelBaseUrls(parsed["modelBaseUrls"]);
  if (baseUrls !== undefined) status.modelBaseUrls = baseUrls;
  const credentials = modelCredentials(parsed["modelCredentials"]);
  if (credentials !== undefined) status.modelCredentials = credentials;
  const tierMap = tiers(parsed["tiers"]);
  if (tierMap !== undefined) status.tiers = tierMap;
  return status;
}

export function serviceStatusText(
  service: NonNullable<TachoStatus["service"]>,
): string {
  return `${service.kind} ${service.running === null ? `state unknown${service.detail ? `: ${service.detail}` : ""}` : service.running ? "running" : service.installed ? "installed, stopped" : "not installed"}`;
}

/**
 * The Gateway line of the This machine panel: the model proxy, then the tier
 * each wrapped harness earned. What the app has not been told reads as
 * unknown. The line used to say "not available on this build" whenever
 * `tacho status` had not answered, and "no run yet" for every harness with
 * the collector down, neither of which the app knew.
 */
export function gatewayText(
  tacho: TachoStatus | null,
  daemonUp: boolean,
  harnesses: readonly string[],
): string {
  const proxy = tacho?.gateway
    ? `model proxy ${tacho.gateway.listening ? `listening on 127.0.0.1:${tacho.gateway.port}` : "not listening"}`
    : tacho === null || !daemonUp
      ? "model proxy unknown"
      : // The collector answered and reported no proxy: it predates one.
        "not available on this build";
  if (harnesses.length === 0) return proxy;
  const tiers = harnesses
    .map(
      (h) =>
        `${h}: ${tacho === null || !daemonUp ? "unknown" : (tacho.tiers?.[h] ?? "no run yet")}`,
    )
    .join(", ");
  return `${proxy}; ${tiers}`;
}
