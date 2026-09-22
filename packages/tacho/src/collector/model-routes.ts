/**
 * Routing for the loopback model proxy: which vendor a request is for, where
 * it goes upstream, which headers cross, and what a refusal looks like in that
 * vendor's own error shape.
 *
 * The proxy is addressed through a path prefix, because both vendors serve
 * `/v1/models` and a bare path cannot say which one is meant:
 *
 *   - `/anthropic/…`           Claude Code, `ANTHROPIC_BASE_URL`.
 *   - `/stella/anthropic/…`    Stella, `providers.anthropic.base_url`. Stella
 *                              sends no session header and no request
 *                              metadata, so the prefix is the only thing that
 *                              says which harness made the call. Without it a
 *                              Stella call would be filed under the one live
 *                              Claude Code session.
 *   - `/backend-api/codex/…`   Codex, `openai_base_url`. The suffix is the one
 *                              Codex requires before it keeps its backend-only
 *                              routes, so the same URL serves both logins.
 *   - `/openai/v1/…`           any other OpenAI-compatible client.
 *   - a bare `/v1/…`           told apart by the vendor's own headers.
 *
 * Codex sends both login kinds to the one base URL and picks no host itself
 * once the URL is overridden, so the proxy picks it: a request carrying
 * `ChatGPT-Account-ID` is a ChatGPT login and goes to the Codex backend, and
 * anything else goes to the public API.
 */
import type { IncomingHttpHeaders } from "node:http";
import { TACHO_MODEL_SESSION_HEADER, type TachoHarness } from "../wire";
import type { ModelApi, ModelProvider } from "./model-usage";

export type ModelUpstreamName = "anthropic" | "openai" | "chatgpt";

/** Base URLs the proxy forwards to. Each may carry a path of its own. */
export type ModelUpstreams = Record<ModelUpstreamName, string>;

export const DEFAULT_MODEL_UPSTREAMS: ModelUpstreams = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  chatgpt: "https://chatgpt.com/backend-api/codex",
};

/** The path prefixes the proxy answers, as the daemon's status lists them. */
export const MODEL_PROXY_ROUTES = [
  "/anthropic",
  "/stella/anthropic",
  "/backend-api/codex",
  "/openai/v1",
  "/v1",
] as const;

export interface ModelRoute {
  provider: ModelProvider;
  api: ModelApi;
  upstream: ModelUpstreamName;
  /**
   * The path and query to append to the upstream base. For Anthropic it keeps
   * its `/v1`. For OpenAI the base already ends in the version segment.
   */
  path: string;
  /**
   * The harness the prefix names, when it names one. Absent, the harness is
   * read from the provider the way it always was.
   */
  harness?: TachoHarness;
}

function anthropicApi(pathname: string): ModelApi {
  return pathname === "/v1/messages" ? "anthropic.messages" : "other";
}

function openAiApi(pathname: string): ModelApi {
  if (pathname === "/responses") return "openai.responses";
  if (pathname === "/chat/completions") return "openai.chat";
  return "other";
}

function openAiRoute(
  rest: string,
  search: string,
  headers: IncomingHttpHeaders,
): ModelRoute {
  return {
    provider: "openai",
    api: openAiApi(rest),
    upstream:
      headers["chatgpt-account-id"] !== undefined ? "chatgpt" : "openai",
    path: `${rest}${search}`,
  };
}

function looksAnthropic(headers: IncomingHttpHeaders): boolean {
  return (
    headers["anthropic-version"] !== undefined ||
    headers["x-api-key"] !== undefined ||
    headers["anthropic-beta"] !== undefined
  );
}

/** The route for a request line, or undefined when the path is not ours. */
export function resolveModelRoute(
  rawUrl: string,
  headers: IncomingHttpHeaders,
): ModelRoute | undefined {
  const mark = rawUrl.indexOf("?");
  const pathname = mark === -1 ? rawUrl : rawUrl.slice(0, mark);
  const search = mark === -1 ? "" : rawUrl.slice(mark);
  const under = (prefix: string): string | undefined =>
    pathname === prefix || pathname.startsWith(`${prefix}/`)
      ? pathname.slice(prefix.length) || "/"
      : undefined;

  const stella = under("/stella/anthropic");
  if (stella !== undefined) {
    return {
      provider: "anthropic",
      api: anthropicApi(stella),
      upstream: "anthropic",
      path: `${stella}${search}`,
      harness: "stella",
    };
  }
  const anthropic = under("/anthropic");
  if (anthropic !== undefined) {
    return {
      provider: "anthropic",
      api: anthropicApi(anthropic),
      upstream: "anthropic",
      path: `${anthropic}${search}`,
    };
  }
  const codex = under("/backend-api/codex");
  if (codex !== undefined) return openAiRoute(codex, search, headers);
  const openai = under("/openai/v1");
  if (openai !== undefined) return openAiRoute(openai, search, headers);
  const bare = under("/v1");
  if (bare !== undefined) {
    const isAnthropic =
      bare === "/messages" ||
      bare.startsWith("/messages/") ||
      (bare !== "/responses" &&
        bare !== "/chat/completions" &&
        looksAnthropic(headers));
    if (isAnthropic) {
      return {
        provider: "anthropic",
        api: anthropicApi(pathname),
        upstream: "anthropic",
        path: `${pathname}${search}`,
      };
    }
    return openAiRoute(bare, search, headers);
  }
  return undefined;
}

/** The upstream URL for a route: the base's own path, then the route's. */
export function upstreamUrlFor(
  route: ModelRoute,
  upstreams: ModelUpstreams,
): URL {
  const base = new URL(upstreams[route.upstream]);
  const prefix = base.pathname.replace(/\/+$/, "");
  return new URL(`${base.origin}${prefix}${route.path}`);
}

/** Headers that describe one connection and never cross a proxy (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function connectionTokens(raw: readonly string[]): Set<string> {
  const named = new Set<string>();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if ((raw[i] as string).toLowerCase() !== "connection") continue;
    for (const token of (raw[i + 1] as string).split(","))
      named.add(token.trim().toLowerCase());
  }
  return named;
}

/** The headers a credential rides in, whichever vendor and whichever kind. */
export const CREDENTIAL_HEADERS = ["authorization", "x-api-key"] as const;

/**
 * A credential the proxy attaches in place of what the caller sent (ADR-138):
 * the caller presented a run token, and this is the vendor credential from
 * custody. `api_key` goes out as `X-Api-Key`, `bearer` as
 * `Authorization: Bearer`.
 */
export interface AttachedCredential {
  kind: "api_key" | "bearer";
  secret: string;
}

/**
 * The request headers to send upstream, in the caller's order and spelling.
 * Without `attach`, credentials cross untouched. With it, every credential
 * header the caller sent is dropped (it held a run token, which the vendor
 * must never see) and the custody credential is appended. What never
 * crosses: hop-by-hop headers, the `Host` and `Content-Length` this hop
 * restates, the session header that was addressed to the proxy, and
 * `Accept-Encoding`, which is restated as `identity` so the meter reads the
 * response without decoding it.
 */
export function upstreamRequestHeaders(
  raw: readonly string[],
  host: string,
  bodyLength: number,
  dropContentEncoding: boolean,
  attach?: AttachedCredential,
): string[] {
  const named = connectionTokens(raw);
  const out: string[] = ["Host", host];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] as string;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    if (lower === "host" || lower === "content-length") continue;
    if (lower === "accept-encoding" || lower === "expect") continue;
    if (lower === TACHO_MODEL_SESSION_HEADER) continue;
    if (dropContentEncoding && lower === "content-encoding") continue;
    if (
      attach !== undefined &&
      (CREDENTIAL_HEADERS as readonly string[]).includes(lower)
    )
      continue;
    out.push(name, raw[i + 1] as string);
  }
  if (attach !== undefined) {
    if (attach.kind === "api_key") out.push("X-Api-Key", attach.secret);
    else out.push("Authorization", `Bearer ${attach.secret}`);
  }
  out.push("Accept-Encoding", "identity");
  if (
    bodyLength > 0 ||
    raw.some((h, i) => i % 2 === 0 && /^content-length$/i.test(h))
  )
    out.push("Content-Length", String(bodyLength));
  return out;
}

/** The response headers to hand back, minus the ones that describe the hop. */
export function downstreamResponseHeaders(raw: readonly string[]): string[] {
  const named = connectionTokens(raw);
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const lower = (raw[i] as string).toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    out.push(raw[i] as string, raw[i + 1] as string);
  }
  return out;
}

export interface ProviderError {
  status: number;
  body: string;
}

/**
 * A refusal in the vendor's own error shape, so the harness shows the message
 * to its operator instead of a parse failure. 4xx and never 429: both SDKs
 * retry a 429 and a 5xx, and a refusal that is retried is a refusal nobody
 * reads. A 401 is the one refusal a harness acts on by itself: Claude Code
 * re-runs its `apiKeyHelper` on a 401, which is how an expired run token is
 * replaced without anyone noticing.
 */
export function providerError(
  provider: ModelProvider,
  status: number,
  code: string,
  message: string,
): ProviderError {
  const body =
    provider === "anthropic"
      ? {
          type: "error",
          error: {
            type:
              status === 401
                ? "authentication_error"
                : status === 403
                  ? "permission_error"
                  : "api_error",
            message: `${message} (${code})`,
          },
        }
      : {
          error: {
            message,
            type:
              status === 401 || status === 403
                ? "invalid_request_error"
                : "server_error",
            param: null,
            code: status === 401 ? "invalid_api_key" : code,
          },
        };
  return { status, body: JSON.stringify(body) };
}
