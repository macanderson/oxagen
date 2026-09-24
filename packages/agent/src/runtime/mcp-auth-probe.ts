// Whether a remote MCP server asks for OAuth, with three answers, not two
// (#4132). `detectOAuthProtected` in @oxagen/plugins folds a timeout, a 5xx and
// a network error into "not protected", which is right for its install-time
// caller and wrong here: a cold-starting OAuth server would be listed as open,
// cached that way, and added with no sign-in. This probe says `unknown` when
// the server gave no answer, and the wizard then tries sign-in first and falls
// back to an open connect only when the server itself says it needs none.
//
//   oauth    RFC 9728 metadata names an authorization server, or an
//            unauthenticated `initialize` is answered 401.
//   none     `initialize` succeeds (2xx) without credentials.
//   unknown  anything else: a timeout, a 404/5xx, an unreadable answer.
import { wellKnownCandidates } from "@oxagen/plugins";

export type ProbedAuth = "oauth" | "none" | "unknown";

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "oxagen-auth-probe", version: "1.0.0" },
  },
});

async function namesAuthorizationServer(response: Response): Promise<boolean> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return false;
  }
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null) return false;
  const servers = (body as { authorization_servers?: unknown })
    .authorization_servers;
  return Array.isArray(servers) && servers.length > 0;
}

/**
 * Probes `endpointUrl` with `fetchFn`, which must carry the SSRF guard and a
 * timeout (`createMcpOAuthFetch`). Never throws.
 */
export async function probeMcpAuth(
  endpointUrl: string,
  fetchFn: typeof fetch,
): Promise<ProbedAuth> {
  let candidates: string[];
  try {
    candidates = wellKnownCandidates(endpointUrl);
  } catch {
    return "unknown";
  }
  for (const url of candidates) {
    try {
      const response = await fetchFn(url, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (await namesAuthorizationServer(response)) return "oauth";
    } catch {
      // A metadata miss says nothing either way; the initialize decides.
    }
  }
  try {
    const response = await fetchFn(endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: INITIALIZE,
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) return "oauth";
    if (response.ok) return "none";
    return "unknown";
  } catch {
    return "unknown";
  }
}
