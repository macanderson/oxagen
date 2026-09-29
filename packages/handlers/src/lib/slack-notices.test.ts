import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  inserted: [] as unknown[],
  selected: [] as unknown[],
  deleted: vi.fn(),
  lockedFor: vi.fn(),
  open: vi.fn(),
  revoke: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** A transaction double for the verifications row the state lives in. */
function makeTx() {
  return {
    insert: () => ({
      values: async (row: unknown) => {
        mocks.inserted.push(row);
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          for: async (mode: string) => {
            mocks.lockedFor(mode);
            return mocks.selected;
          },
        }),
      }),
    }),
    delete: () => ({
      where: async (clause: unknown) => {
        mocks.deleted(clause);
      },
    }),
  };
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()) };
});

vi.mock("@oxagen/notifications/slack", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/notifications/slack")>();
  return { ...real, openSlackToken: mocks.open, slackRevokeToken: mocks.revoke };
});

vi.mock("../logger", () => ({ logger: mocks.log }));

import { SlackApiError, type SlackConnection } from "@oxagen/notifications/slack";
import { slackOAuthStateSchema } from "@oxagen/oxagen/contracts/org.slack_connection.shared";
import {
  SLACK_CALLBACK_PATH,
  beginSlackAuthorization,
  consumeSlackState,
  isSlackConfigured,
  openSlackTokenForHandler,
  requireSlackAppConfig,
  revokeSlackTokens,
  slackAppConfig,
  slackHandlerError,
  toSlackConnectionView,
  type SlackAppConfig,
} from "./slack-notices";

const ENV = {
  SLACK_APP_CLIENT_ID: "cid",
  SLACK_APP_CLIENT_SECRET: "csecret",
  SLACK_APP_ID: "A1",
  APP_URL: "https://app.oxagen.sh",
};

const CONFIG: SlackAppConfig = {
  clientId: "cid",
  clientSecret: "csecret",
  appId: "A1",
  redirectUri: "https://app.oxagen.sh/api/slack/oauth/callback",
};

function stateRow(value: unknown) {
  return {
    id: `slack_notices_oauth:${"s".repeat(43)}`,
    identifier: "x",
    value: typeof value === "string" ? value : JSON.stringify(value),
    expiresAt: new Date(Date.now() + 60_000),
  };
}

beforeEach(() => {
  mocks.inserted.length = 0;
  mocks.selected.length = 0;
  mocks.deleted.mockReset();
  mocks.lockedFor.mockReset();
  mocks.open.mockReset().mockResolvedValue("xoxb-1");
  mocks.revoke.mockReset().mockResolvedValue(undefined);
  mocks.log.warn.mockReset();
});

describe("slackAppConfig", () => {
  it("builds the redirect URL from APP_URL", () => {
    expect(slackAppConfig(ENV)).toEqual(CONFIG);
    expect(SLACK_CALLBACK_PATH).toBe("/api/slack/oauth/callback");
  });

  it("reads an empty SLACK_APP_ID as no app check", () => {
    expect(slackAppConfig({ ...ENV, SLACK_APP_ID: "" })?.appId).toBeNull();
    expect(slackAppConfig({ ...ENV, SLACK_APP_ID: undefined })?.appId).toBeNull();
  });

  it.each(["SLACK_APP_CLIENT_ID", "SLACK_APP_CLIENT_SECRET", "APP_URL"] as const)(
    "is null without %s",
    (name) => {
      expect(slackAppConfig({ ...ENV, [name]: "" })).toBeNull();
      expect(isSlackConfigured({ ...ENV, [name]: undefined })).toBe(false);
    },
  );

  it("is null when APP_URL is not a URL", () => {
    expect(slackAppConfig({ ...ENV, APP_URL: "not a url" })).toBeNull();
  });

  it("reads process.env when no env is passed", () => {
    expect(typeof isSlackConfigured()).toBe("boolean");
  });
});

describe("requireSlackAppConfig", () => {
  it("returns the configuration", () => {
    expect(requireSlackAppConfig(ENV)).toEqual(CONFIG);
  });

  it("refuses with slack_not_configured", () => {
    let caught: unknown;
    try {
      requireSlackAppConfig({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "conflict", reason: "slack_not_configured" });
  });
});

describe("beginSlackAuthorization", () => {
  it("stores a ten-minute state bound to the organization and the person", async () => {
    const before = Date.now();
    const { authorizeUrl } = await beginSlackAuthorization(CONFIG, "org-1", "user-1");
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("scope")).toContain("chat:write");
    const state = url.searchParams.get("state") ?? "";
    expect(slackOAuthStateSchema.safeParse(state).success).toBe(true);

    expect(mocks.inserted).toHaveLength(1);
    const row = mocks.inserted[0] as { id: string; identifier: string; value: string; expiresAt: Date };
    expect(row.id).toBe(`slack_notices_oauth:${state}`);
    expect(row.identifier).toBe(row.id);
    expect(JSON.parse(row.value)).toEqual({
      orgId: "org-1",
      userId: "user-1",
      redirectUri: CONFIG.redirectUri,
    });
    const ttl = row.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(600_000);
    expect(ttl).toBeLessThan(605_000);
  });

  it("draws a new state each time", async () => {
    const a = await beginSlackAuthorization(CONFIG, "org-1", "user-1");
    const b = await beginSlackAuthorization(CONFIG, "org-1", "user-1");
    expect(new URL(a.authorizeUrl).searchParams.get("state")).not.toBe(
      new URL(b.authorizeUrl).searchParams.get("state"),
    );
  });
});

describe("consumeSlackState", () => {
  const INPUT = { orgId: "org-1", userId: "user-1", state: "s".repeat(43) };
  const GOOD = { orgId: "org-1", userId: "user-1", redirectUri: CONFIG.redirectUri };

  it("returns the stored redirect URL and deletes the row, under a row lock", async () => {
    mocks.selected.push(stateRow(GOOD));
    await expect(consumeSlackState(INPUT)).resolves.toEqual({ redirectUri: CONFIG.redirectUri });
    expect(mocks.lockedFor).toHaveBeenCalledWith("update");
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });

  it("refuses a state that expired or was used", async () => {
    await expect(consumeSlackState(INPUT)).rejects.toMatchObject({
      code: "forbidden",
      reason: "slack_oauth_state_expired",
    });
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it.each([
    ["a value that is not JSON", "{not json"],
    ["a value of the wrong shape", { orgId: "org-1" }],
  ])("refuses %s", async (_label, value) => {
    mocks.selected.push(stateRow(value));
    await expect(consumeSlackState(INPUT)).rejects.toMatchObject({
      reason: "slack_oauth_state_invalid",
    });
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it.each([
    ["another organization", { ...GOOD, orgId: "org-2" }],
    ["another person", { ...GOOD, userId: "user-2" }],
  ])("refuses a state %s started, and leaves it in place", async (_label, value) => {
    mocks.selected.push(stateRow(value));
    await expect(consumeSlackState(INPUT)).rejects.toMatchObject({
      code: "forbidden",
      reason: "slack_oauth_state_mismatch",
    });
    expect(mocks.deleted).not.toHaveBeenCalled();
  });
});

describe("slackHandlerError", () => {
  it("reads channel_not_found as not found", () => {
    expect(slackHandlerError(new SlackApiError("conversations.info", "channel_not_found", 200))).toMatchObject({
      code: "not_found",
      reason: "slack_channel_not_found",
    });
  });

  it("reads is_archived as an archived channel", () => {
    expect(slackHandlerError(new SlackApiError("conversations.info", "is_archived", 200))).toMatchObject({
      code: "conflict",
      reason: "slack_channel_archived",
    });
  });

  it.each(["token_revoked", "invalid_auth", "missing_scope", "not_in_channel"])(
    "reads `%s` as a broken connection",
    (code) => {
      expect(slackHandlerError(new SlackApiError("conversations.list", code, 200))).toMatchObject({
        code: "conflict",
        reason: "slack_connection_broken",
      });
    },
  );

  it("drops Slack's code from a failure a retry may pass", () => {
    const cause = new SlackApiError("conversations.list", "ratelimited", 429);
    const err = slackHandlerError(cause);
    expect(err.constructor).toBe(Error);
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect(err.message).toBe("Slack conversations.list did not answer: ratelimited");
    expect(err.cause).toBe(cause);
  });

  it("passes any other error through, and wraps a thrown value", () => {
    const boom = new Error("db down");
    expect(slackHandlerError(boom)).toBe(boom);
    expect(slackHandlerError("text")).toMatchObject({ message: "text" });
  });
});

describe("openSlackTokenForHandler", () => {
  const CONN = { tokenEnvelope: { keyId: "k" } } as unknown as SlackConnection;

  it("returns the decrypted token", async () => {
    await expect(openSlackTokenForHandler(CONN)).resolves.toBe("xoxb-1");
    expect(mocks.open).toHaveBeenCalledWith({ keyId: "k" });
  });

  it("reads an envelope that does not parse as a broken connection", async () => {
    mocks.open.mockRejectedValue(new z.ZodError([]));
    await expect(openSlackTokenForHandler(CONN)).rejects.toMatchObject({
      reason: "slack_connection_broken",
    });
  });

  it("reads a ciphertext no retry will open as a broken connection", async () => {
    mocks.open.mockRejectedValue(new Error("Unsupported state or unable to authenticate data"));
    await expect(openSlackTokenForHandler(CONN)).rejects.toMatchObject({
      reason: "slack_connection_broken",
    });
  });

  it("throws a failure a retry may pass as it came", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    mocks.open.mockRejectedValue(timeout);
    await expect(openSlackTokenForHandler(CONN)).rejects.toBe(timeout);
  });
});

describe("revokeSlackTokens", () => {
  it("revokes each token and counts the ones Slack accepted", async () => {
    mocks.open.mockResolvedValueOnce("xoxb-a").mockResolvedValueOnce("xoxb-b");
    mocks.revoke
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SlackApiError("auth.revoke", "network", null));
    await expect(revokeSlackTokens("org-1", [{ a: 1 }, { b: 2 }])).resolves.toBe(1);
    expect(mocks.revoke).toHaveBeenNthCalledWith(1, "xoxb-a");
    expect(mocks.revoke).toHaveBeenNthCalledWith(2, "xoxb-b");
    expect(mocks.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", code: "network" }),
      expect.any(String),
    );
  });

  it("skips a token that will not decrypt, and never throws", async () => {
    mocks.open.mockRejectedValue(new Error("bad envelope"));
    await expect(revokeSlackTokens("org-1", [{}])).resolves.toBe(0);
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", code: undefined }),
      expect.any(String),
    );
  });

  it("does nothing for no tokens", async () => {
    await expect(revokeSlackTokens("org-1", [])).resolves.toBe(0);
  });
});

describe("toSlackConnectionView", () => {
  it("shows no connection", () => {
    expect(toSlackConnectionView(null, true)).toEqual({
      configured: true,
      connected: false,
      teamName: null,
      channel: null,
      lastFailure: null,
      connectedAt: null,
    });
  });

  it("shows a connection without its token", () => {
    const view = toSlackConnectionView(
      {
        orgId: "org-1",
        teamId: "T1",
        teamName: "Acme",
        scopes: ["chat:write"],
        channel: { id: "C0000001", name: "alerts", isPrivate: false },
        lastFailure: null,
        connectedAt: new Date("2026-09-01T00:00:00Z"),
        tokenEnvelope: { keyId: "k", ciphertext: "secret" },
      },
      false,
    );
    expect(view).toEqual({
      configured: false,
      connected: true,
      teamName: "Acme",
      channel: { id: "C0000001", name: "alerts", isPrivate: false },
      lastFailure: null,
      connectedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(JSON.stringify(view)).not.toContain("secret");
  });
});
