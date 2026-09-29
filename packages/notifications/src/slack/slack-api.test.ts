import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SlackApiError,
  isPermanentSlackError,
  slackChannelInfo,
  slackListChannels,
  slackOauthAccess,
  slackPostMessage,
  slackRevokeToken,
} from "./slack-api";

const fetchMock = vi.fn();

function answer(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The URL, headers, and body of the nth fetch call. */
function sent(n = 0): { url: string; headers: Record<string, string>; body: string } {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return {
    url,
    headers: init.headers as Record<string, string>,
    body: String(init.body ?? ""),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slackPostMessage", () => {
  it("posts JSON with the bot token and returns the message timestamp", async () => {
    fetchMock.mockResolvedValue(answer({ ok: true, ts: "1700000000.000100" }));
    const out = await slackPostMessage("xoxb-token", {
      channel: "C123",
      text: "Title",
      blocks: [{ type: "section" }],
    });
    expect(out).toEqual({ ts: "1700000000.000100" });
    const req = sent();
    expect(req.url).toBe("https://slack.com/api/chat.postMessage");
    expect(req.headers["authorization"]).toBe("Bearer xoxb-token");
    expect(req.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(req.body)).toEqual({
      channel: "C123",
      text: "Title",
      blocks: [{ type: "section" }],
      unfurl_links: false,
      unfurl_media: false,
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns a null timestamp when Slack sends none", async () => {
    fetchMock.mockResolvedValue(answer({ ok: true }));
    await expect(
      slackPostMessage("t", { channel: "C", text: "x", blocks: [] }),
    ).resolves.toEqual({ ts: null });
  });

  it("throws Slack's error code when Slack answers ok: false", async () => {
    fetchMock.mockResolvedValue(answer({ ok: false, error: "channel_not_found" }));
    const err = await slackPostMessage("t", { channel: "C", text: "x", blocks: [] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err).toMatchObject({
      name: "SlackApiError",
      code: "channel_not_found",
      method: "chat.postMessage",
      status: 200,
      message: "Slack chat.postMessage failed: channel_not_found",
    });
  });

  it("uses `unknown` when ok: false carries no error code", async () => {
    fetchMock.mockResolvedValue(answer({ ok: false, error: "" }));
    await expect(
      slackPostMessage("t", { channel: "C", text: "x", blocks: [] }),
    ).rejects.toMatchObject({ code: "unknown" });
  });

  it("turns a fetch failure into a `network` error with no status", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      slackPostMessage("t", { channel: "C", text: "x", blocks: [] }),
    ).rejects.toMatchObject({ code: "network", status: null });
  });

  it("turns a 429 into `ratelimited`", async () => {
    fetchMock.mockResolvedValue(answer({ ok: false, error: "ratelimited" }, 429));
    await expect(
      slackPostMessage("t", { channel: "C", text: "x", blocks: [] }),
    ).rejects.toMatchObject({ code: "ratelimited", status: 429 });
  });

  it("turns another non-2xx into `http_<status>`", async () => {
    fetchMock.mockResolvedValue(answer("upstream down", 503));
    await expect(
      slackPostMessage("t", { channel: "C", text: "x", blocks: [] }),
    ).rejects.toMatchObject({ code: "http_503", status: 503 });
  });

  it("turns a body that is not JSON into `bad_response`", async () => {
    fetchMock.mockResolvedValue(answer("<html>", 200));
    await expect(
      slackPostMessage("t", { channel: "C", text: "x", blocks: [] }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });

  it("turns a JSON body that is not an object into `bad_response`", async () => {
    fetchMock.mockResolvedValue(answer("null", 200));
    await expect(
      slackPostMessage("t", { channel: "C", text: "x", blocks: [] }),
    ).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("isPermanentSlackError", () => {
  it("is true for refusals that repeat until a person acts", () => {
    for (const code of ["token_revoked", "channel_not_found", "not_in_channel", "is_archived"])
      expect(isPermanentSlackError(new SlackApiError("chat.postMessage", code, 200))).toBe(true);
  });

  it("is false for failures a retry may pass, and for other errors", () => {
    for (const code of ["ratelimited", "network", "http_503", "internal_error", "unknown"])
      expect(isPermanentSlackError(new SlackApiError("chat.postMessage", code, 200))).toBe(false);
    expect(isPermanentSlackError(new Error("channel_not_found"))).toBe(false);
  });
});

describe("slackOauthAccess", () => {
  const input = {
    clientId: "cid",
    clientSecret: "secret",
    code: "code-1",
    redirectUri: "https://app.example/api/slack/oauth/callback",
  };

  it("posts a form and returns the bot install", async () => {
    fetchMock.mockResolvedValue(
      answer({
        ok: true,
        access_token: "xoxb-1",
        token_type: "bot",
        scope: "chat:write,channels:read",
        bot_user_id: "U1",
        app_id: "A1",
        team: { id: "T1", name: "Acme" },
      }),
    );
    await expect(slackOauthAccess(input)).resolves.toEqual({
      accessToken: "xoxb-1",
      appId: "A1",
      botUserId: "U1",
      scopes: ["chat:write", "channels:read"],
      team: { id: "T1", name: "Acme" },
    });
    const req = sent();
    expect(req.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(req.headers["authorization"]).toBeUndefined();
    expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({
      client_id: "cid",
      client_secret: "secret",
      code: "code-1",
      redirect_uri: "https://app.example/api/slack/oauth/callback",
    });
  });

  it("falls back to the team id for a team with no name and to empty scopes", async () => {
    fetchMock.mockResolvedValue(
      answer({ ok: true, access_token: "xoxb-1", token_type: "bot", team: { id: "T1" } }),
    );
    await expect(slackOauthAccess(input)).resolves.toMatchObject({
      appId: null,
      botUserId: null,
      scopes: [],
      team: { id: "T1", name: "T1" },
    });
  });

  it("refuses an org-wide install that carries no team", async () => {
    fetchMock.mockResolvedValue(
      answer({ ok: true, access_token: "xoxb-1", token_type: "bot", team: null }),
    );
    await expect(slackOauthAccess(input)).rejects.toMatchObject({ code: "bad_response" });
  });

  it("refuses an answer with no bot token", async () => {
    fetchMock.mockResolvedValue(
      answer({ ok: true, access_token: "xoxp-1", token_type: "user", team: { id: "T1" } }),
    );
    await expect(slackOauthAccess(input)).rejects.toMatchObject({ code: "bad_response" });
  });

  it("passes Slack's refusal through", async () => {
    fetchMock.mockResolvedValue(answer({ ok: false, error: "invalid_code" }));
    await expect(slackOauthAccess(input)).rejects.toMatchObject({ code: "invalid_code" });
  });
});

describe("slackListChannels", () => {
  it("follows the cursor, drops archived and malformed rows, and sorts by name", async () => {
    fetchMock
      .mockResolvedValueOnce(
        answer({
          ok: true,
          channels: [
            { id: "C2", name: "ops", is_private: false },
            { id: "C3", name: "old", is_archived: true },
            { id: "", name: "no-id" },
            "junk",
          ],
          response_metadata: { next_cursor: "page2" },
        }),
      )
      .mockResolvedValueOnce(
        answer({
          ok: true,
          channels: [{ id: "C1", name: "alerts", is_private: true }],
          response_metadata: { next_cursor: "" },
        }),
      );
    await expect(slackListChannels("xoxb")).resolves.toEqual({
      channels: [
        { id: "C1", name: "alerts", isPrivate: true },
        { id: "C2", name: "ops", isPrivate: false },
      ],
      truncated: false,
    });
    const first = new URLSearchParams(sent(0).body);
    expect(first.get("types")).toBe("public_channel,private_channel");
    expect(first.get("exclude_archived")).toBe("true");
    expect(first.get("limit")).toBe("200");
    expect(first.get("cursor")).toBeNull();
    expect(new URLSearchParams(sent(1).body).get("cursor")).toBe("page2");
  });

  it("stops after the page limit and says the list is truncated", async () => {
    fetchMock.mockImplementation(async () =>
      answer({
        ok: true,
        channels: [{ id: "C1", name: "general" }],
        response_metadata: { next_cursor: "more" },
      }),
    );
    const out = await slackListChannels("xoxb", 2);
    expect(out.truncated).toBe(true);
    expect(out.channels).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads a page with no channels array as empty", async () => {
    fetchMock.mockResolvedValue(answer({ ok: true }));
    await expect(slackListChannels("xoxb")).resolves.toEqual({ channels: [], truncated: false });
  });
});

describe("slackChannelInfo", () => {
  it("returns the channel with its archived flag", async () => {
    fetchMock.mockResolvedValue(
      answer({ ok: true, channel: { id: "C1", name: "alerts", is_private: true, is_archived: true } }),
    );
    await expect(slackChannelInfo("xoxb", "C1")).resolves.toEqual({
      id: "C1",
      name: "alerts",
      isPrivate: true,
      isArchived: true,
    });
    expect(new URLSearchParams(sent().body).get("channel")).toBe("C1");
  });

  it("throws `bad_response` when the channel is missing from the answer", async () => {
    fetchMock.mockResolvedValue(answer({ ok: true, channel: null }));
    await expect(slackChannelInfo("xoxb", "C1")).rejects.toMatchObject({ code: "bad_response" });
  });
});

describe("slackRevokeToken", () => {
  it("calls auth.revoke with the token and no body", async () => {
    fetchMock.mockResolvedValue(answer({ ok: true, revoked: true }));
    await slackRevokeToken("xoxb-1");
    const req = sent();
    expect(req.url).toBe("https://slack.com/api/auth.revoke");
    expect(req.headers["authorization"]).toBe("Bearer xoxb-1");
    expect(req.body).toBe("");
  });
});
