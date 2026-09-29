// config.ts: the relay's settings, read once from its own environment.
//
// The relay holds no settings file. Everything comes from environment
// variables, so the container's Secret and the Helm values are the whole
// configuration. loadRelayConfig checks every variable and reports every
// problem at once, so one restart fixes them all.
import { createPublicKey, type KeyObject } from "node:crypto";
import { hostSchema, RELAY_NAME_PATTERN, workspacePublicIdSchema } from "@oxagen/mcp-studio";
import { normalizePublicKeyPem, RELAY_CONNECT_PATH, relayKeyId } from "@oxagen/relay-broker/protocol";

/** The prefix of every variable that holds a customer credential. */
export const CREDENTIAL_ENV_PREFIX = "RELAY_CREDENTIAL_";

export const DEFAULT_CLOCK_SKEW_MS = 5_000;
export const MAX_CLOCK_SKEW_MS = 60_000;

export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MIN_MAX_RESPONSE_BYTES = 1024;
export const MAX_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

export interface HostAllowlist {
  /** host:port entries, each allowing one port. */
  exact: ReadonlySet<string>;
  /** Bare host entries, each allowing the scheme's default port only: 443 for https, 80 for http. */
  defaultPort: ReadonlySet<string>;
}

export interface RelayConfig {
  /** The broker's WebSocket URL, ending in the connect path. */
  brokerUrl: string;
  token: string;
  relay: string;
  /** The workspace's public id, wrk_…. */
  workspace: string;
  /** Each trusted signing key by its key id. */
  trustedKeys: ReadonlyMap<string, KeyObject>;
  allowedHosts: HostAllowlist;
  clockSkewMs: number;
  maxResponseBytes: number;
  /** Every RELAY_CREDENTIAL_* variable, by name. */
  credentials: ReadonlyMap<string, string>;
}

/** Every problem the environment has. The message lists them one per line. */
export class RelayConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The relay cannot start:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "RelayConfigError";
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function brokerUrl(value: string | undefined, problems: string[]): string {
  if (value === undefined || value.trim() === "") {
    problems.push("Set RELAY_BROKER_URL to the broker address Oxagen gave you, such as wss://relay.oxagen.sh.");
    return "";
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    problems.push("RELAY_BROKER_URL is not a URL. Use the wss:// address Oxagen gave you.");
    return "";
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    problems.push("RELAY_BROKER_URL must start with wss://. Plain ws:// works only for a broker on this machine.");
    return "";
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    problems.push("RELAY_BROKER_URL must not hold a user name, a password, a query, or a fragment.");
    return "";
  }
  if (url.pathname === "" || url.pathname === "/") url.pathname = RELAY_CONNECT_PATH;
  if (url.pathname !== RELAY_CONNECT_PATH) {
    problems.push(`RELAY_BROKER_URL must end in ${RELAY_CONNECT_PATH}, or have no path at all.`);
    return "";
  }
  return url.toString();
}

function token(value: string | undefined, problems: string[]): string {
  if (value === undefined || value === "") {
    problems.push("Set RELAY_TOKEN to the relay token Oxagen showed you when you created the relay.");
    return "";
  }
  if (/\s/.test(value)) {
    problems.push("RELAY_TOKEN holds a space or a line break. Copy the token again without them.");
    return "";
  }
  return value;
}

function relayName(value: string | undefined, problems: string[]): string {
  if (value === undefined || !RELAY_NAME_PATTERN.test(value)) {
    problems.push(
      "Set RELAY_NAME to the relay's name in Oxagen: up to 63 lowercase letters, digits, and hyphens, starting with a letter or digit.",
    );
    return "";
  }
  return value;
}

function workspace(value: string | undefined, problems: string[]): string {
  if (value === undefined || !workspacePublicIdSchema.safeParse(value).success) {
    problems.push("Set RELAY_WORKSPACE to the workspace id Oxagen shows for the relay, such as wrk_ and 22 characters.");
    return "";
  }
  return value;
}

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;

function trustedKeys(value: string | undefined, problems: string[]): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  if (value === undefined || value.trim() === "") {
    problems.push("Set RELAY_TRUSTED_KEYS to the PEM public key Oxagen signs relay requests with.");
    return keys;
  }
  // A Secret or a .env file often holds the PEM on one line with \n escapes.
  const text = value.replace(/\\n/g, "\n");
  if (text.includes("PRIVATE KEY")) {
    problems.push("RELAY_TRUSTED_KEYS holds a private key. Give the relay only the public key.");
    return keys;
  }
  for (const block of text.match(PEM_BLOCK) ?? []) {
    try {
      const pem = normalizePublicKeyPem(block);
      keys.set(relayKeyId(pem), createPublicKey(pem));
    } catch (error) {
      problems.push(`RELAY_TRUSTED_KEYS holds a key the relay cannot use: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (keys.size === 0 && problems.every((problem) => !problem.startsWith("RELAY_TRUSTED_KEYS"))) {
    problems.push("RELAY_TRUSTED_KEYS holds no PEM public key. Paste the whole key, BEGIN and END lines included.");
  }
  return keys;
}

function allowedHosts(value: string | undefined, problems: string[]): HostAllowlist {
  const exact = new Set<string>();
  const defaultPort = new Set<string>();
  const entries = (value ?? "").split(/[\s,]+/).filter((entry) => entry !== "");
  if (entries.length === 0) {
    problems.push(
      "Set RELAY_ALLOWED_HOSTS to the hosts the relay may reach, separated by commas, such as billing.internal,ledger.internal:50051.",
    );
  }
  for (const raw of entries) {
    const entry = raw.toLowerCase();
    const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(entry);
    const host = match?.[1];
    const port = match?.[2] === undefined ? undefined : Number(match[2]);
    if (host === undefined || !hostSchema.safeParse(host).success || (port !== undefined && (port < 1 || port > 65_535))) {
      problems.push(
        `RELAY_ALLOWED_HOSTS entry ${raw} is not a host or host:port. Write a host name or IPv4 address, with no scheme, path, or wildcard.`,
      );
      continue;
    }
    if (port === undefined) defaultPort.add(host);
    else exact.add(`${host}:${port}`);
  }
  return { exact, defaultPort };
}

function boundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    problems.push(`${name} must be a whole number from ${min} to ${max}.`);
    return fallback;
  }
  return parsed;
}

function credentials(env: Env): Map<string, string> {
  const found = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(CREDENTIAL_ENV_PREFIX) && value !== undefined) found.set(name, value);
  }
  return found;
}

/** The relay's settings. Throws RelayConfigError listing every problem. */
export function loadRelayConfig(env: Env): RelayConfig {
  const problems: string[] = [];
  const config: RelayConfig = {
    brokerUrl: brokerUrl(env.RELAY_BROKER_URL, problems),
    token: token(env.RELAY_TOKEN, problems),
    relay: relayName(env.RELAY_NAME, problems),
    workspace: workspace(env.RELAY_WORKSPACE, problems),
    trustedKeys: trustedKeys(env.RELAY_TRUSTED_KEYS, problems),
    allowedHosts: allowedHosts(env.RELAY_ALLOWED_HOSTS, problems),
    clockSkewMs: boundedInteger(
      "RELAY_CLOCK_SKEW_MS",
      env.RELAY_CLOCK_SKEW_MS,
      DEFAULT_CLOCK_SKEW_MS,
      0,
      MAX_CLOCK_SKEW_MS,
      problems,
    ),
    maxResponseBytes: boundedInteger(
      "RELAY_MAX_RESPONSE_BYTES",
      env.RELAY_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
      MIN_MAX_RESPONSE_BYTES,
      MAX_MAX_RESPONSE_BYTES,
      problems,
    ),
    credentials: credentials(env),
  };
  if (problems.length > 0) throw new RelayConfigError(problems);
  return config;
}
