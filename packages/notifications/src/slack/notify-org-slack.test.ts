import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { loadMock, openMock, recordMock, postMock, logMock } = vi.hoisted(() => ({
  loadMock: vi.fn(),
  openMock: vi.fn(),
  recordMock: vi.fn(),
  postMock: vi.fn(),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("./slack-connection", () => ({
  loadSlackConnection: loadMock,
  openSlackToken: openMock,
  recordSlackFailure: recordMock,
}));

// Keep the real SlackApiError and isPermanentSlackError, so the test checks
// which codes the notice treats as lasting.
vi.mock("./slack-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("./slack-api")>();
  return { ...real, slackPostMessage: postMock };
});

vi.mock("../logger", () => ({ logger: logMock }));

import { SlackApiError } from "./slack-api";
import type { SlackConnection } from "./slack-connection";
import {
  escapeSlackText,
  notifyOrgSlack,
  slackDeepLink,
  slackNoticeMessage,
  type NotifyOrgSlackInput,
} from "./notify-org-slack";

const ENV = { APP_URL: "https://app.oxagen.sh" };

const INPUT: NotifyOrgSlackInput = {
  orgId: "org-1",
  workspaceId: "ws-1",
  kind: "security",
  title: "The steering repo stopped syncing",
  body: "GitHub refused the token.",
  deepLink: "/acme/main/steering",
};

function connection(over: Partial<SlackConnection> = {}): SlackConnection {
  return {
    orgId: "org-1",
    teamId: "T1",
    teamName: "Acme",
    scopes: ["chat:write"],
    channel: { id: "C1", name: "alerts", isPrivate: false },
    lastFailure: null,
    connectedAt: new Date("2026-09-01T00:00:00Z"),
    tokenEnvelope: { keyId: "k", ciphertext: "c" },
    ...over,
  };
}

beforeEach(() => {
  loadMock.mockReset();
  openMock.mockReset().mockResolvedValue("xoxb-token");
  recordMock.mockReset().mockResolvedValue(undefined);
  postMock.mockReset().mockResolvedValue({ ts: "1700000000.000100" });
  logMock.info.mockReset();
  logMock.warn.mockReset();
  logMock.error.mockReset();
});

describe("notifyOrgSlack post", () => {
  it("posts one message to the picked channel with the decrypted token", async () => {
    loadMock.mockResolvedValue(connection());
    await expect(notifyOrgSlack(INPUT, ENV)).resolves.toEqual({
      outcome: "posted",
      channelId: "C1",
      ts: "1700000000.000100",
    });
    expect(loadMock).toHaveBeenCalledWith("org-1");
    expect(openMock).toHaveBeenCalledWith({ keyId: "k", ciphertext: "c" });
    expect(postMock).toHaveBeenCalledTimes(1);
    const [token, message] = postMock.mock.calls[0]!;
    expect(token).toBe("xoxb-token");
    expect(message).toEqual({ channel: "C1", ...slackNoticeMessage(INPUT, ENV) });
    // Nothing was on record, so a healthy post writes nothing.
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("clears a failure on record once a post goes through", async () => {
    loadMock.mockResolvedValue(
      connection({ lastFailure: { code: "not_in_channel", at: "2026-09-27T00:00:00Z" } }),
    );
    await expect(notifyOrgSlack(INPUT, ENV)).resolves.toMatchObject({ outcome: "posted" });
    expect(recordMock).toHaveBeenCalledWith({ orgId: "org-1", teamId: "T1", failure: null });
  });

  it("reads process.env when no env is passed", async () => {
    loadMock.mockResolvedValue(connection());
    await expect(notifyOrgSlack({ ...INPUT, deepLink: undefined })).resolves.toMatchObject({
      outcome: "posted",
    });
  });
});

describe("notifyOrgSlack skip", () => {
  it("skips an organization with no Slack connection", async () => {
    loadMock.mockResolvedValue(null);
    await expect(notifyOrgSlack(INPUT, ENV)).resolves.toEqual({
      outcome: "skipped",
      reason: "not_connected",
    });
    expect(openMock).not.toHaveBeenCalled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("skips a connection with no channel picked yet", async () => {
    loadMock.mockResolvedValue(connection({ channel: null }));
    await expect(notifyOrgSlack(INPUT, ENV)).resolves.toEqual({
      outcome: "skipped",
      reason: "no_channel",
    });
    expect(postMock).not.toHaveBeenCalled();
    expect(logMock.info).toHaveBeenCalled();
  });

  it("skips and records a refusal that repeats until a person acts", async () => {
    loadMock.mockResolvedValue(connection());
    postMock.mockRejectedValue(new SlackApiError("chat.postMessage", "not_in_channel", 200));
    await expect(notifyOrgSlack(INPUT, ENV)).resolves.toEqual({
      outcome: "skipped",
      reason: "slack_refused",
      code: "not_in_channel",
    });
    expect(recordMock).toHaveBeenCalledWith({
      orgId: "org-1",
      teamId: "T1",
      failure: { code: "not_in_channel", at: expect.any(String) },
    });
    const at = recordMock.mock.calls[0]![0].failure.at as string;
    expect(Number.isNaN(Date.parse(at))).toBe(false);
    expect(logMock.warn).toHaveBeenCalled();
  });

  it("skips a token envelope that does not parse, and records it", async () => {
    loadMock.mockResolvedValue(connection());
    openMock.mockRejectedValue(new z.ZodError([]));
    await expect(notifyOrgSlack(INPUT, ENV)).resolves.toEqual({
      outcome: "skipped",
      reason: "token_unreadable",
      code: "token_unreadable",
    });
    expect(postMock).not.toHaveBeenCalled();
    expect(recordMock).toHaveBeenCalledWith(
      expect.objectContaining({ failure: expect.objectContaining({ code: "token_unreadable" }) }),
    );
    expect(logMock.error).toHaveBeenCalled();
  });

  it("skips a token that no retry will decrypt", async () => {
    loadMock.mockResolvedValue(connection());
    openMock.mockRejectedValue(new Error("Unsupported state or unable to authenticate data"));
    await expect(notifyOrgSlack(INPUT, ENV)).resolves.toMatchObject({
      outcome: "skipped",
      reason: "token_unreadable",
    });
  });

  it("still skips when recording the failure fails, and logs it", async () => {
    loadMock.mockResolvedValue(connection());
    postMock.mockRejectedValue(new SlackApiError("chat.postMessage", "channel_not_found", 200));
    recordMock.mockRejectedValue(new Error("db down"));
    await expect(notifyOrgSlack(INPUT, ENV)).resolves.toMatchObject({
      outcome: "skipped",
      reason: "slack_refused",
    });
    expect(logMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", code: "channel_not_found" }),
      expect.stringContaining("could not record"),
    );
  });
});

describe("notifyOrgSlack retry", () => {
  it.each(["network", "ratelimited", "http_503", "internal_error", "bad_response"])(
    "throws on `%s`, so the next health read sends the notice again",
    async (code) => {
      loadMock.mockResolvedValue(connection());
      const failure = new SlackApiError("chat.postMessage", code, null);
      postMock.mockRejectedValue(failure);
      await expect(notifyOrgSlack(INPUT, ENV)).rejects.toBe(failure);
      expect(recordMock).not.toHaveBeenCalled();
      expect(logMock.warn).toHaveBeenCalled();
    },
  );

  it("throws a decrypt failure a retry may pass, such as a KMS timeout", async () => {
    loadMock.mockResolvedValue(connection());
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    openMock.mockRejectedValue(timeout);
    await expect(notifyOrgSlack(INPUT, ENV)).rejects.toBe(timeout);
    expect(postMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("throws when the connection cannot be read", async () => {
    loadMock.mockRejectedValue(new Error("db down"));
    await expect(notifyOrgSlack(INPUT, ENV)).rejects.toThrow("db down");
  });
});

describe("slackNoticeMessage", () => {
  it("puts the title in bold, the body under it, and a link to Oxagen last", () => {
    expect(slackNoticeMessage(INPUT, ENV)).toEqual({
      text: INPUT.title,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${INPUT.title}*` } },
        { type: "section", text: { type: "mrkdwn", text: INPUT.body } },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "<https://app.oxagen.sh/acme/main/steering|Open in Oxagen>",
            },
          ],
        },
      ],
    });
  });

  it("leaves out an empty body and a link it cannot build", () => {
    const { blocks } = slackNoticeMessage({ title: "T", body: "  ", deepLink: "/x" }, {});
    expect(blocks).toHaveLength(1);
  });

  it("escapes Slack's control characters in the title and body", () => {
    const { blocks } = slackNoticeMessage(
      { title: "a <b> & c", body: "<!channel> ping" },
      ENV,
    );
    expect(blocks[0]).toMatchObject({ text: { text: "*a &lt;b&gt; &amp; c*" } });
    expect(blocks[1]).toMatchObject({ text: { text: "&lt;!channel&gt; ping" } });
  });

  it("percent-encodes a pipe in the link, so it cannot end the URL early", () => {
    const { blocks } = slackNoticeMessage(
      { title: "T", deepLink: "https://app.oxagen.sh/a?q=x|y" },
      ENV,
    );
    expect(blocks[1]).toMatchObject({
      elements: [{ text: "<https://app.oxagen.sh/a?q=x%7Cy|Open in Oxagen>" }],
    });
  });

  it("clips a section longer than Slack allows", () => {
    const { blocks } = slackNoticeMessage({ title: "T", body: "x".repeat(5_000) }, ENV);
    const text = (blocks[1] as { text: { text: string } }).text.text;
    expect(text).toHaveLength(2_900);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("escapeSlackText", () => {
  it("escapes &, <, and >", () => {
    expect(escapeSlackText("&<>")).toBe("&amp;&lt;&gt;");
  });
});

describe("slackDeepLink", () => {
  it("resolves a path against APP_URL", () => {
    expect(slackDeepLink("/acme/main/steering", ENV)).toBe(
      "https://app.oxagen.sh/acme/main/steering",
    );
  });

  it("falls back to NEXT_PUBLIC_APP_URL", () => {
    expect(slackDeepLink("/a", { NEXT_PUBLIC_APP_URL: "https://x.test" })).toBe(
      "https://x.test/a",
    );
  });

  it("returns null for a path when no app URL is set, or the app URL is not a URL", () => {
    expect(slackDeepLink("/a", {})).toBeNull();
    expect(slackDeepLink("/a", { APP_URL: "not a url" })).toBeNull();
  });

  it("passes an absolute http or https URL through", () => {
    expect(slackDeepLink("https://x.test/a", ENV)).toBe("https://x.test/a");
    expect(slackDeepLink("http://x.test/a", ENV)).toBe("http://x.test/a");
  });

  it("drops a missing link, a protocol-relative path, another scheme, and junk", () => {
    expect(slackDeepLink(undefined, ENV)).toBeNull();
    expect(slackDeepLink("", ENV)).toBeNull();
    expect(slackDeepLink("//evil.test/a", ENV)).toBeNull();
    expect(slackDeepLink("javascript:alert(1)", ENV)).toBeNull();
    expect(slackDeepLink("not a url", ENV)).toBeNull();
  });
});
