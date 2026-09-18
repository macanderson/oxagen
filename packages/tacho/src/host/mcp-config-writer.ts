/**
 * The MCP-client config writer: what `settings-writer.ts` is to a *wrapped*
 * harness, this is to a *connected* one (ADR-078).
 *
 * A wrapped harness (Claude Code, Codex, Stella) runs a `PreToolUse` hook, so
 * Tacho sees and can refuse every action the agent takes, including the
 * harness's own built-in Bash and Edit. A connected app (Claude Desktop and
 * its kin) exposes no hook surface at all. The only thing Oxagen can govern
 * there is the set of tools it serves, so the enrollment writes one entry
 * into the app's MCP client config pointing at the collector's loopback
 * gateway, and everything Oxagen knows about that app is what came through
 * that gateway.
 *
 * The contract is `settings-writer.ts`'s, deliberately:
 *
 *   - pure functions over a parsed document, never file I/O;
 *   - idempotent — a second merge with the same config changes nothing;
 *   - marker-scoped to one enrollment id, so a `reassign` replaces its own
 *     entry and leaves every other one alone;
 *   - foreign entries survive; a foreign entry that collides with our key is
 *     displaced, recorded, and restored by `unenroll`, exactly as the env
 *     block's displaced values are.
 *
 * What differs is the document shape. Hooks live in arrays keyed by event, so
 * a foreign hook simply sits beside ours. MCP servers live in a map keyed by
 * server name, so two entries cannot share a key: a foreign `oxagen` server is
 * a genuine collision and the only honest answers are "displace and remember"
 * or "refuse". We displace and remember, because refusing would leave the app
 * ungoverned over a name clash the operator never chose.
 */

import { documentShapeProblem } from "./settings-writer";

/**
 * The key our server takes in `mcpServers`. It becomes the tool-name prefix
 * the user sees in the app (`oxagen__…` in Claude Desktop), so it is a name,
 * not an id: it stays the same across re-enrollments and does not carry the
 * enrollment id. The marker lives inside the entry instead.
 */
export const OXAGEN_MCP_SERVER_KEY = "oxagen";

/** One entry in an `mcpServers` map. Open-ended: vendors add their own keys. */
export interface McpServerEntry {
  /** stdio transport: the executable to spawn. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** HTTP transports: `"http"` (streamable) or `"sse"`. */
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export type McpConfigDocument = Record<string, unknown> & {
  mcpServers?: Record<string, McpServerEntry>;
};

/**
 * Which transport an app's config entry uses. `stdio` spawns our shim, which
 * dials the same loopback gateway; `http` points the app straight at it.
 * Per app, decided by what the vendor documents — see the writer for each.
 */
export type McpTransport = "stdio" | "http";

export interface GatewayInstallConfig {
  enrollmentId: string;
  /** The collector's loopback port, from `host.json`. */
  port: number;
  /** The per-install bearer the loopback listener requires. */
  localToken: string;
  /**
   * argv[0] for the stdio shim: the `tacho` executable, or the `node` that
   * runs `tacho.mjs`. Taken from `RuntimeCommands`, so it is the same binary
   * the hooks and the service already reference.
   */
  shimCommand: string;
  /** argv[1..] before our own flags, e.g. `["…/tacho.mjs"]` for a bundle. */
  shimArgs?: string[];
  /** `TACHO_HOME` when it is not the default, exported to the shim. */
  tachoHome?: string;
}

/** The loopback MCP endpoint, scoped to one enrollment. */
export function gatewayUrl(port: number, enrollmentId: string): string {
  return `http://127.0.0.1:${port}/mcp/${enrollmentId}`;
}

/**
 * The stdio entry: our shim, which speaks JSON-RPC on stdin/stdout and
 * forwards to `gatewayUrl`. The local bearer travels in `env`, never in
 * `args`, so it does not appear in a process listing.
 */
export function stdioServerEntry(config: GatewayInstallConfig): McpServerEntry {
  return {
    command: config.shimCommand,
    args: [
      ...(config.shimArgs ?? []),
      "mcp-stdio",
      "--enrollment",
      config.enrollmentId,
      "--port",
      String(config.port),
    ],
    env: {
      TACHO_LOCAL_TOKEN: config.localToken,
      ...(config.tachoHome !== undefined
        ? { TACHO_HOME: config.tachoHome }
        : {}),
    },
  };
}

/** The streamable-HTTP entry, for an app that dials a URL itself. */
export function httpServerEntry(config: GatewayInstallConfig): McpServerEntry {
  return {
    type: "http",
    url: gatewayUrl(config.port, config.enrollmentId),
    headers: { Authorization: `Bearer ${config.localToken}` },
  };
}

export function oxagenServerEntry(
  config: GatewayInstallConfig,
  transport: McpTransport,
): McpServerEntry {
  return transport === "stdio"
    ? stdioServerEntry(config)
    : httpServerEntry(config);
}

/**
 * The same enrollment-id marker `settings-writer.ts` uses, read out of
 * whichever field the transport puts it in. An entry with no marker is
 * somebody else's, whatever key it sits under.
 */
export function isOxagenServerEntry(
  entry: unknown,
  enrollmentId?: string,
): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const server = entry as McpServerEntry;
  const idPattern = enrollmentId ?? "tch_[a-z0-9]{22}";
  if (Array.isArray(server.args)) {
    const joined = server.args.join(" ");
    if (new RegExp(`--enrollment ${idPattern}(\\s|$)`).test(joined))
      return true;
  }
  if (typeof server.url === "string") {
    if (new RegExp(`/mcp/${idPattern}$`).test(server.url)) return true;
  }
  return false;
}

export interface McpMergeResult {
  config: McpConfigDocument;
  changed: boolean;
  /**
   * A foreign server that held our key and was moved aside, so `unenroll`
   * can put it back. At most one entry, under `OXAGEN_MCP_SERVER_KEY`.
   */
  displaced: Record<string, McpServerEntry>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function documentOf(existing: unknown): McpConfigDocument {
  return existing !== null && typeof existing === "object"
    ? clone(existing as McpConfigDocument)
    : {};
}

/**
 * Why a parsed MCP client config cannot be merged into, or undefined when it
 * can: `mcpServers` as a list or a string was spread into index keys and the
 * user's value lost.
 */
export function mcpConfigShapeProblem(document: unknown): string | undefined {
  return documentShapeProblem(document, ["mcpServers"]);
}

/**
 * Merge the Oxagen gateway into an MCP client config. Idempotent. Every
 * other server survives untouched; a foreign server already under our key is
 * returned in `displaced` and restored by `stripOxagenMcpServer`.
 */
export function mergeOxagenMcpServer(
  existing: unknown,
  config: GatewayInstallConfig,
  transport: McpTransport,
): McpMergeResult {
  const document = documentOf(existing);
  const before = JSON.stringify(document);
  const servers = { ...(document.mcpServers ?? {}) };
  const displaced: Record<string, McpServerEntry> = {};
  const current = servers[OXAGEN_MCP_SERVER_KEY];
  if (current !== undefined && !isOxagenServerEntry(current)) {
    displaced[OXAGEN_MCP_SERVER_KEY] = clone(current);
  }
  servers[OXAGEN_MCP_SERVER_KEY] = oxagenServerEntry(config, transport);
  document.mcpServers = servers;
  return {
    config: document,
    changed: JSON.stringify(document) !== before,
    displaced,
  };
}

export interface McpStripResult {
  config: McpConfigDocument;
  changed: boolean;
}

/**
 * Remove the Oxagen gateway (for one enrollment, or any when omitted) and put
 * back whatever it displaced. An entry under our key that is not ours and was
 * not displaced by us is left alone: it belongs to somebody, and unenroll
 * deletes only what enroll wrote.
 */
export function stripOxagenMcpServer(
  existing: unknown,
  enrollmentId?: string,
  restore: Record<string, McpServerEntry> = {},
): McpStripResult {
  // Not an MCP client config: nothing of ours is in it, and it goes back as it is.
  if (mcpConfigShapeProblem(existing) !== undefined)
    return { config: existing as McpConfigDocument, changed: false };
  const document = documentOf(existing);
  const before = JSON.stringify(document);
  if (document.mcpServers !== undefined) {
    const servers: Record<string, McpServerEntry> = {};
    for (const [key, entry] of Object.entries(document.mcpServers)) {
      if (isOxagenServerEntry(entry, enrollmentId)) continue;
      servers[key] = entry;
    }
    for (const [key, entry] of Object.entries(restore)) {
      // Only if the slot is free: a server the operator added under that key
      // after we displaced theirs is theirs now, and is not overwritten.
      if (servers[key] === undefined) servers[key] = entry;
    }
    if (Object.keys(servers).length > 0) document.mcpServers = servers;
    else delete document.mcpServers;
  } else if (Object.keys(restore).length > 0) {
    document.mcpServers = { ...restore };
  }
  return { config: document, changed: JSON.stringify(document) !== before };
}

export interface McpServerPresence {
  /** Our entry is installed for this enrollment, on the expected transport. */
  present: boolean;
  /** An entry for a *different* enrollment is installed (a stale reassign). */
  foreignEnrollment: boolean;
  /** How many other MCP servers the app has, which we cannot govern. */
  otherServers: number;
  /** Their names, so the panel can say which ones route around Oxagen. */
  otherServerNames: string[];
}

/**
 * What is installed in this app's config. `otherServers` is not a warning
 * about those servers; it is the honest size of the gap ADR-078 names — a
 * connected app can always reach a tool Oxagen never sees by adding one.
 */
export function oxagenMcpPresence(
  existing: unknown,
  enrollmentId: string,
): McpServerPresence {
  const document = documentOf(existing);
  const servers = document.mcpServers ?? {};
  let present = false;
  let foreignEnrollment = false;
  const otherServerNames: string[] = [];
  for (const [key, entry] of Object.entries(servers)) {
    if (isOxagenServerEntry(entry, enrollmentId)) {
      present = true;
      continue;
    }
    if (isOxagenServerEntry(entry)) {
      foreignEnrollment = true;
      continue;
    }
    otherServerNames.push(key);
  }
  return {
    present,
    foreignEnrollment,
    otherServers: otherServerNames.length,
    otherServerNames,
  };
}
