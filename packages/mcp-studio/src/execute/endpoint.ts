// endpoint.ts: how the executor reads an environment's url.
//
// A pure rule with no I/O, so OpenAPI import can apply the same rule to the
// servers it suggests as environments.
import { hostSchema } from "../contract/primitives";
import { BuildError } from "./util";

/** The scheme, host, port, and path an environment's url gives. */
export interface Endpoint {
  scheme: "https" | "http";
  host: string;
  /** Undefined for the scheme's default port, as a relay envelope writes it. */
  port: number | undefined;
  /** For a base url, the path with no trailing slash, or "" for none. For an endpoint, the path and query. */
  path: string;
}

function invalidEnvironment(detail: string): BuildError {
  return new BuildError("Invalid environment", detail);
}

/**
 * Read an environment's url.
 *
 * - base: an OpenAPI server url. Operation paths go after its path, so a
 *   trailing slash is dropped, and it may not carry a query.
 * - endpoint: an MCP or GraphQL endpoint, sent to exactly as written.
 */
export function parseEndpoint(url: string | undefined, use: "base" | "endpoint"): Endpoint {
  if (url === undefined) throw invalidEnvironment("The environment has no url, so the call has no host.");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidEnvironment(`The environment url ${url} does not parse.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw invalidEnvironment(`An environment url is https or http, not ${parsed.protocol.slice(0, -1)}.`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw invalidEnvironment("An environment url cannot carry a user name or password. Store the secret as a credential.");
  }
  if (parsed.hash !== "") throw invalidEnvironment(`An environment url has no fragment: ${url}.`);
  if (parsed.hostname.startsWith("[")) {
    throw invalidEnvironment("An IPv6 host is not supported. Name the host, or use an IPv4 address.");
  }
  const host = parsed.hostname.toLowerCase();
  if (!hostSchema.safeParse(host).success) throw invalidEnvironment(`${host} is not a host name or an IPv4 address.`);
  if (use === "base" && parsed.search !== "") {
    throw invalidEnvironment(`An API's base url has no query: ${url}.`);
  }
  return {
    scheme: parsed.protocol === "https:" ? "https" : "http",
    host,
    // URL drops the scheme's default port, which is how the envelope writes it.
    port: parsed.port === "" ? undefined : Number(parsed.port),
    path: use === "base" ? parsed.pathname.replace(/\/+$/, "") : parsed.pathname + parsed.search,
  };
}
