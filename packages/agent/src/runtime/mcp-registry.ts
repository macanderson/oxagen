// Reads the official MCP Registry for the Add a provider wizard (#4132).
//
// Why this registry. `registry.modelcontextprotocol.io` is the ecosystem's
// canonical metadata registry, run under the Model Context Protocol project
// with Anthropic, GitHub, Microsoft and PulseMCP as maintainers. Three
// properties make it the one to search, over aggregators that scrape GitHub:
//
//   - **Names are proven.** A reverse-DNS name (`app.linear/linear`) is
//     published only after its owner proves the domain by DNS or HTTP, and an
//     `io.github.<user>/…` name only by that GitHub account. The publisher a
//     result shows is therefore one the registry verified, not one a listing
//     claimed.
//   - **It is open.** The read API needs no key and no account, so a workspace
//     search depends on nothing Oxagen has to provision.
//   - **It is stable.** API v0.1 is frozen with no breaking changes.
//
// The registry's server.json cannot say "this server uses OAuth", so a remote
// that declares no secret header is probed live (RFC 9728 metadata or a 401 on
// `initialize`), and the answer is cached for half an hour.
import {
  assertPublicHttpUrl,
  UnsafeOutboundUrlError,
} from "@oxagen/config/public-url";
import type {
  AgentMcpRegistrySearchOutput,
  McpRegistryServer,
} from "@oxagen/oxagen/contracts/agent.mcp.registry.search";
import { probeMcpAuth } from "./mcp-auth-probe";
import { createMcpOAuthFetch } from "./mcp-oauth-fetch";
import {
  searchVerifiedServers,
  verifiedEndpointHosts,
} from "./verified-mcp-servers";

export const OFFICIAL_MCP_REGISTRY_URL =
  "https://registry.modelcontextprotocol.io";

/** Bound on the registry read; the verified entries answer if it lapses. */
const REGISTRY_TIMEOUT_MS = 6_000;
/** Bound on one auth probe. A slow server is listed as `unknown`, not waited on. */
const PROBE_TIMEOUT_MS = 2_500;
const PROBE_TTL_MS = 30 * 60 * 1000;
const PROBE_CACHE_MAX = 500;

type RegistryHeader = {
  name?: unknown;
  isSecret?: unknown;
  isRequired?: unknown;
};
type RegistryRemote = { type?: unknown; url?: unknown; headers?: unknown };
type RegistryPackage = { transport?: { type?: unknown } };
type RegistryEntry = {
  server?: {
    name?: unknown;
    title?: unknown;
    description?: unknown;
    version?: unknown;
    websiteUrl?: unknown;
    repository?: { url?: unknown };
    icons?: unknown;
    remotes?: unknown;
    packages?: unknown;
  };
  _meta?: Record<string, { status?: unknown } | undefined>;
};

const OFFICIAL_META = "io.modelcontextprotocol.registry/official";

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** An https URL a browser may load or link to, or null. */
export function httpsUrl(value: unknown): string | null {
  const raw = str(value);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.username === ""
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * The publisher a registry name proves. `app.linear/linear` is the domain
 * `linear.app`, verified by DNS or HTTP; `io.github.acme/x` is the GitHub
 * account `acme`, which proves an account and not a company.
 */
export function publisherOf(name: string): {
  publisher: string;
  verified: boolean;
} {
  const namespace = name.split("/")[0] ?? name;
  if (namespace.startsWith("io.github.")) {
    return {
      publisher: `github.com/${namespace.slice("io.github.".length)}`,
      verified: false,
    };
  }
  return {
    publisher: namespace.split(".").reverse().join("."),
    verified: true,
  };
}

function remotesOf(value: unknown): RegistryRemote[] {
  return Array.isArray(value) ? (value as RegistryRemote[]) : [];
}

function isPublicEndpoint(url: string): boolean {
  try {
    assertPublicHttpUrl(url, {
      refusing: "registry endpoint",
      requireTls: true,
    });
    return true;
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) return false;
    throw err;
  }
}

/** The auth a remote's declared headers imply, before any probe. */
export function declaredAuth(headers: unknown): {
  auth: "bearer" | "header" | null;
  header: string | null;
} {
  if (!Array.isArray(headers)) return { auth: null, header: null };
  const secret = (headers as RegistryHeader[]).find(
    (h) => h.isSecret === true || h.isRequired === true,
  );
  const name = str(secret?.name);
  if (name === null) return { auth: null, header: null };
  return name.toLowerCase() === "authorization"
    ? { auth: "bearer", header: name }
    : { auth: "header", header: name };
}

/** Normalizes one registry record, or null for a deleted or unreadable one. */
export function toRegistryServer(
  entry: RegistryEntry,
): McpRegistryServer | null {
  const server = entry.server;
  const name = str(server?.name);
  if (server === undefined || name === null) return null;
  const status = entry._meta?.[OFFICIAL_META]?.status;
  if (status === "deleted" || status === "deprecated") return null;

  const remotes = remotesOf(server.remotes);
  const packages = Array.isArray(server.packages)
    ? (server.packages as RegistryPackage[])
    : [];
  const transports = new Set<McpRegistryServer["transports"][number]>();
  for (const remote of remotes) {
    if (remote.type === "streamable-http" || remote.type === "sse") {
      transports.add(remote.type);
    }
  }
  for (const pkg of packages) {
    const type = pkg.transport?.type;
    if (type === "stdio" || type === "streamable-http" || type === "sse") {
      transports.add(type);
    }
  }

  // The endpoint Oxagen can reach: a streamable-http remote with a literal
  // public https URL. A templated URL (`https://{tenant}.example.com/mcp`)
  // needs values the registry cannot supply, so it is not connectable here.
  const remote = remotes.find(
    (r) =>
      r.type === "streamable-http" &&
      typeof r.url === "string" &&
      !r.url.includes("{") &&
      isPublicEndpoint(r.url),
  );
  const endpointUrl = remote === undefined ? null : String(remote.url);
  const declared = declaredAuth(remote?.headers);
  const icons = Array.isArray(server.icons)
    ? (server.icons as { src?: unknown }[])
    : [];
  const { publisher, verified } = publisherOf(name);

  return {
    id: name,
    name: str(server.title) ?? name.split("/").pop() ?? name,
    description: str(server.description) ?? "",
    publisher,
    publisherVerified: verified,
    source: "registry",
    version: str(server.version),
    iconUrl:
      icons.map((icon) => httpsUrl(icon.src)).find((u) => u !== null) ?? null,
    websiteUrl: httpsUrl(server.websiteUrl),
    // The registry names no docs page; the website or the repository is it.
    docsUrl: httpsUrl(server.websiteUrl) ?? httpsUrl(server.repository?.url),
    repositoryUrl: httpsUrl(server.repository?.url),
    endpointUrl,
    transports: [...transports],
    auth:
      endpointUrl === null
        ? packages.length > 0
          ? "none"
          : "unknown"
        : (declared.auth ?? "unknown"),
    authHeader: declared.header,
    oauthRegistration: null,
    connectable: endpointUrl !== null,
  };
}

const probeCache = new Map<string, { auth: "oauth" | "none"; at: number }>();

/** Test seam: forget every cached probe. */
export function clearRegistryProbeCacheForTests(): void {
  probeCache.clear();
}

/**
 * A server's auth, from the cache or a probe. Only a definite answer is
 * cached: a server that did not answer this time (a cold start, a 5xx) is
 * `unknown` now and probed again on the next search.
 */
async function probeAuth(
  endpointUrl: string,
  fetchFn: typeof fetch,
  now: number,
): Promise<"oauth" | "none" | "unknown"> {
  const cached = probeCache.get(endpointUrl);
  if (cached !== undefined && now - cached.at < PROBE_TTL_MS)
    return cached.auth;
  const auth = await probeMcpAuth(endpointUrl, fetchFn);
  if (auth !== "unknown") {
    if (probeCache.size >= PROBE_CACHE_MAX) probeCache.clear();
    probeCache.set(endpointUrl, { auth, at: now });
  }
  return auth;
}

export type RegistrySearchDeps = {
  fetchFn?: typeof fetch;
  now?: () => number;
  baseUrl?: string;
};

/**
 * One page of search results: the verified entries the query matches (first
 * page only), then the registry's, with any registry copy of a verified
 * endpoint dropped. A registry that cannot be read leaves the verified entries
 * and says so, rather than failing the whole search.
 */
export async function searchMcpRegistry(
  input: { query: string; cursor?: string; limit: number },
  deps: RegistrySearchDeps = {},
): Promise<AgentMcpRegistrySearchOutput> {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const base = deps.baseUrl ?? OFFICIAL_MCP_REGISTRY_URL;
  const query = input.query.trim();
  const verified =
    input.cursor === undefined ? searchVerifiedServers(query) : [];
  const verifiedHosts = verifiedEndpointHosts();

  const url = new URL("/v0.1/servers", base);
  url.searchParams.set("version", "latest");
  url.searchParams.set("limit", String(input.limit));
  if (query !== "") url.searchParams.set("search", query);
  if (input.cursor !== undefined) url.searchParams.set("cursor", input.cursor);

  let entries: RegistryEntry[] = [];
  let nextCursor: string | null = null;
  let registryReachable = true;
  try {
    const guarded = createMcpOAuthFetch(fetchFn, REGISTRY_TIMEOUT_MS);
    const response = await guarded(url.toString(), {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`registry answered ${response.status}`);
    const body = (await response.json()) as {
      servers?: unknown;
      metadata?: { nextCursor?: unknown };
    };
    entries = Array.isArray(body.servers)
      ? (body.servers as RegistryEntry[])
      : [];
    nextCursor = str(body.metadata?.nextCursor);
  } catch {
    registryReachable = false;
  }

  const listed = entries
    .map(toRegistryServer)
    .filter((s): s is McpRegistryServer => s !== null)
    .filter(
      (s) =>
        s.endpointUrl === null ||
        !verifiedHosts.has(new URL(s.endpointUrl).host),
    );

  const probeFetch = createMcpOAuthFetch(fetchFn, PROBE_TIMEOUT_MS);
  const at = now();
  const probed = await Promise.all(
    listed.map(async (server) => {
      if (server.auth !== "unknown" || server.endpointUrl === null)
        return server;
      const auth = await probeAuth(server.endpointUrl, probeFetch, at);
      return {
        ...server,
        auth,
        oauthRegistration: auth === "oauth" ? ("unknown" as const) : null,
      };
    }),
  );

  return {
    servers: [...verified, ...probed],
    nextCursor: registryReachable ? nextCursor : null,
    registryReachable,
  };
}
