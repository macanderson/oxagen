// GET /api/v1/mcp/oauth/callback (#4132): where an MCP server's authorization
// server returns the popup the Add a provider wizard opened.
//
// It matches `state` against the flows the wizard's session started (the
// cookie `startProviderAuthorization` set), exchanges the code as that viewer,
// and answers with a page that posts the outcome back to the wizard and closes
// itself. The page names the provider and the outcome, never the code: the
// response is `no-store` and sends no referrer, since the URL carries it.
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { completeProviderAuthorization } from "./provider-auth-actions";
import {
  MCP_OAUTH_CALLBACK_PATH,
  MCP_OAUTH_CHANNEL,
  MCP_OAUTH_COOKIE,
  MCP_OAUTH_MESSAGE,
  type OAuthOutcome,
  pendingFlowsOf,
} from "./oauth-flow";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON that is safe inside a `<script>`: no `</script>`, no line separators. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function page(outcome: OAuthOutcome, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fff;color:#111}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}main{max-width:28rem;padding:24px;text-align:center}</style>
</head><body><main><h1 style="font-size:18px">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main>
<script>(function(){var m=${scriptJson(outcome)};try{new BroadcastChannel(${scriptJson(MCP_OAUTH_CHANNEL)}).postMessage(m)}catch(e){}try{if(window.opener)window.opener.postMessage(m,window.location.origin)}catch(e){}setTimeout(function(){window.close()},400)})();</script>
</body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    },
  });
}

export async function handleMcpOAuthCallback(
  request: Request,
): Promise<Response> {
  const t = await getTranslations("tools.oauthCallback");
  const query = new URL(request.url).searchParams;
  const state = query.get("state") ?? "";
  const failed = (code: string): Response =>
    page(
      { type: MCP_OAUTH_MESSAGE, ok: false, state, code },
      t("failedTitle"),
      code === "access_denied" ? t("denied") : t("failed"),
    );

  const jar = await cookies();
  const flows = pendingFlowsOf(jar.get(MCP_OAUTH_COOKIE)?.value);
  const flow = flows.find((f) => f.state === state);
  // The state is single use: whatever happens next, this flow is spent.
  const rest = flows.filter((f) => f.state !== state);
  jar.set(MCP_OAUTH_COOKIE, JSON.stringify(rest), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: rest.length === 0 ? 0 : 600,
    path: MCP_OAUTH_CALLBACK_PATH,
  });

  if (flow === undefined) return failed("authorization_expired");
  const providerError = query.get("error");
  if (providerError !== null) {
    return failed(
      providerError === "access_denied"
        ? "access_denied"
        : "authorization_failed",
    );
  }
  const code = query.get("code");
  if (code === null || code === "") return failed("authorization_failed");

  let result: Awaited<ReturnType<typeof completeProviderAuthorization>>;
  try {
    result = await completeProviderAuthorization(flow.org, flow.ws, {
      state,
      code,
    });
  } catch {
    return failed("authorization_failed");
  }
  if (!result.ok) {
    return failed("code" in result ? result.code : result.reason);
  }
  return page(
    {
      type: MCP_OAUTH_MESSAGE,
      ok: true,
      state,
      serverId: result.value.serverId,
      name: result.value.name,
      healthStatus: result.value.healthStatus,
      discoveredTools: [...result.value.discoveredTools],
    },
    t("doneTitle", { name: result.value.name }),
    t("done"),
  );
}
