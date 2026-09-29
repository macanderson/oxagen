// slack-api.ts: the five Slack Web API methods Oxagen's Slack notices call.
//
// Every call is one HTTPS request with a 20 second budget and no redirects.
// Slack answers most failures with HTTP 200 and `{ ok: false, error }`, so a
// call reads the body before it decides. A refusal becomes a SlackApiError
// carrying Slack's error code. A network failure, a timeout, a 429, and a 5xx
// become a SlackApiError too, with a code of Oxagen's own, so a caller can
// tell a refusal that will repeat from one that may pass.

const SLACK_API = "https://slack.com/api/";
const TIMEOUT_MS = 20_000;

/** The bot scopes the Oxagen Slack app asks for (infra/slack/manifest.json). */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
] as const;

/**
 * Slack error codes that repeat on every retry until a person acts: the
 * workspace removed the app, revoked the token, or archived, deleted, or
 * closed the channel to the bot. Posting again cannot succeed, so a notice
 * skips and records the code instead of retrying.
 */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "no_permission",
  "missing_scope",
  "team_access_not_granted",
  "ekm_access_denied",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "restricted_action",
  "restricted_action_read_only_channel",
]);

/** A Slack call that failed. `code` is Slack's error, or one of Oxagen's. */
export class SlackApiError extends Error {
  override readonly name = "SlackApiError";
  /** Slack's `error` field, or `http_<status>`, `network`, `bad_response`. */
  readonly code: string;
  /** The Web API method, such as `chat.postMessage`. */
  readonly method: string;
  /** The HTTP status, or null when no response arrived. */
  readonly status: number | null;

  constructor(method: string, code: string, status: number | null) {
    super(`Slack ${method} failed: ${code}`);
    this.code = code;
    this.method = method;
    this.status = status;
  }
}

/** Whether a Slack failure repeats until a person reconnects or re-picks a channel. */
export function isPermanentSlackError(err: unknown): err is SlackApiError {
  return err instanceof SlackApiError && PERMANENT_CODES.has(err.code);
}

type SlackBody = { ok?: unknown; error?: unknown } & Record<string, unknown>;

/** One Web API call. Returns the body when Slack answers `ok: true`. */
async function call(
  method: string,
  init: { token?: string; form?: Record<string, string>; json?: unknown },
): Promise<SlackBody> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (init.token) headers["authorization"] = `Bearer ${init.token}`;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json; charset=utf-8";
    body = JSON.stringify(init.json);
  } else if (init.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(init.form).toString();
  }
  let res: Response;
  try {
    res = await fetch(SLACK_API + method, {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SlackApiError(method, "network", null);
  }
  if (res.status === 429) throw new SlackApiError(method, "ratelimited", 429);
  if (!res.ok) throw new SlackApiError(method, `http_${res.status}`, res.status);
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new SlackApiError(method, "bad_response", res.status);
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new SlackApiError(method, "bad_response", res.status);
  const out = parsed as SlackBody;
  if (out.ok !== true)
    throw new SlackApiError(
      method,
      typeof out.error === "string" && out.error !== "" ? out.error : "unknown",
      res.status,
    );
  return out;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** What oauth.v2.access returns for a bot install, trimmed to what Oxagen keeps. */
export interface SlackBotInstall {
  accessToken: string;
  appId: string | null;
  botUserId: string | null;
  scopes: string[];
  team: { id: string; name: string };
}

/**
 * Exchange an OAuth code for the workspace's bot token. An Enterprise Grid
 * org-wide install carries no team, and a user-token-only answer carries no
 * bot token. Both throw `bad_response`: the app turns org-wide install off.
 */
export async function slackOauthAccess(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<SlackBotInstall> {
  const out = await call("oauth.v2.access", {
    form: {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    },
  });
  const team = out["team"] as { id?: unknown; name?: unknown } | null | undefined;
  const accessToken = str(out["access_token"]);
  const teamId = str(team?.id);
  if (accessToken === null || str(out["token_type"]) !== "bot" || teamId === null)
    throw new SlackApiError("oauth.v2.access", "bad_response", 200);
  return {
    accessToken,
    appId: str(out["app_id"]),
    botUserId: str(out["bot_user_id"]),
    scopes: (str(out["scope"]) ?? "").split(",").filter(Boolean),
    team: { id: teamId, name: str(team?.name) ?? teamId },
  };
}

/** A channel as the picker shows it. */
export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

function channelOf(raw: unknown): (SlackChannel & { isArchived: boolean }) | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const id = str(c["id"]);
  const name = str(c["name"]);
  if (id === null || name === null) return null;
  return {
    id,
    name,
    isPrivate: c["is_private"] === true,
    isArchived: c["is_archived"] === true,
  };
}

/**
 * The workspace's unarchived public channels and the private channels the
 * bot has joined, sorted by name. Stops after `maxPages` pages of 200 and
 * says so, so a very large workspace still gets a picker.
 */
export async function slackListChannels(
  token: string,
  maxPages = 10,
): Promise<{ channels: SlackChannel[]; truncated: boolean }> {
  const channels: SlackChannel[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page += 1) {
    const out = await call("conversations.list", {
      token,
      form: {
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: "200",
        ...(cursor === "" ? {} : { cursor }),
      },
    });
    for (const raw of Array.isArray(out["channels"]) ? out["channels"] : []) {
      const channel = channelOf(raw);
      if (channel !== null && !channel.isArchived)
        channels.push({ id: channel.id, name: channel.name, isPrivate: channel.isPrivate });
    }
    const meta = out["response_metadata"] as { next_cursor?: unknown } | undefined;
    cursor = str(meta?.next_cursor) ?? "";
    if (cursor === "") {
      channels.sort((a, b) => a.name.localeCompare(b.name));
      return { channels, truncated: false };
    }
  }
  channels.sort((a, b) => a.name.localeCompare(b.name));
  return { channels, truncated: true };
}

/** One channel, or `channel_not_found` when the bot cannot see it. */
export async function slackChannelInfo(
  token: string,
  channelId: string,
): Promise<SlackChannel & { isArchived: boolean }> {
  const out = await call("conversations.info", { token, form: { channel: channelId } });
  const channel = channelOf(out["channel"]);
  if (channel === null) throw new SlackApiError("conversations.info", "bad_response", 200);
  return channel;
}

/** Post one message. Returns the message's timestamp. */
export async function slackPostMessage(
  token: string,
  message: { channel: string; text: string; blocks: unknown[] },
): Promise<{ ts: string | null }> {
  const out = await call("chat.postMessage", {
    token,
    json: {
      channel: message.channel,
      text: message.text,
      blocks: message.blocks,
      unfurl_links: false,
      unfurl_media: false,
    },
  });
  return { ts: str(out["ts"]) };
}

/** Revoke a bot token, so a copy of it stops working. */
export async function slackRevokeToken(token: string): Promise<void> {
  await call("auth.revoke", { token });
}
