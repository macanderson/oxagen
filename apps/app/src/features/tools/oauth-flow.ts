// What the OAuth popup and the wizard agree on (#4132): the callback path, the
// cookie that binds a started sign-in to its workspace, and the message the
// callback page posts back.
//
// The message travels on a BroadcastChannel as well as `window.opener`. A
// provider page that sets `Cross-Origin-Opener-Policy: same-origin` (many do)
// severs the popup from its opener for good, even after it returns to this
// origin, so `opener.postMessage` alone would leave the wizard waiting.
// A BroadcastChannel reaches every same-origin page in the browser, so the
// wizard matches the flow by its `state` and ignores the rest.
import { z } from "zod";

export const MCP_OAUTH_CALLBACK_PATH = "/api/v1/mcp/oauth/callback";
export const MCP_OAUTH_COOKIE = "oxagen_mcp_oauth";
export const MCP_OAUTH_CHANNEL = "oxagen-mcp-oauth";
export const MCP_OAUTH_MESSAGE = "oxagen:mcp-oauth";

const PendingFlow = z.object({
  org: z.string().min(1).max(200),
  ws: z.string().min(1).max(200),
  state: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),
});
export type PendingFlow = z.infer<typeof PendingFlow>;

/** The flows a cookie holds; anything unreadable holds none. */
export function pendingFlowsOf(raw: string | undefined): PendingFlow[] {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed = z.array(PendingFlow).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export const OAuthOutcome = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal(MCP_OAUTH_MESSAGE),
    ok: z.literal(true),
    state: z.string(),
    serverId: z.string(),
    name: z.string(),
    healthStatus: z.enum(["healthy", "degraded", "unreachable"]),
    discoveredTools: z.array(z.string()),
  }),
  z.object({
    type: z.literal(MCP_OAUTH_MESSAGE),
    ok: z.literal(false),
    state: z.string(),
    /** A failure code the wizard names: `access_denied`, `authorization_failed`… */
    code: z.string(),
  }),
]);
export type OAuthOutcome = z.infer<typeof OAuthOutcome>;
