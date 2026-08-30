import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { slack } from "../slack/index";

describe("slack connector – normalizeRecord", () => {
  describe("message", () => {
    it("maps a realistic message payload", () => {
      const raw = {
        ts: "1706800000.000001",
        channel: "C12345678",
        user: "U98765432",
        text: "Hello, team! Let's discuss the roadmap.",
        thread_ts: "1706800000.000001",
        reply_count: 3,
        reactions: [{ name: "thumbsup" }, { name: "heart" }],
        files: [],
        permalink:
          "https://workspace.slack.com/archives/C12345678/p1706800000000001",
      };
      const result = slack.normalizeRecord("message", raw);
      expect(result.externalId).toBe("C12345678:1706800000.000001");
      expect(result.properties["userId"]).toBe("U98765432");
      expect(result.properties["channelId"]).toBe("C12345678");
      expect(result.properties["reactions"]).toEqual(["thumbsup", "heart"]);
      expect(result.properties["hasFiles"]).toBe(false);
    });

    it("handles empty message gracefully", () => {
      const result = slack.normalizeRecord("message", {});
      expect(result.externalId).toBe("undefined:undefined");
      expect(result.properties["reactions"]).toEqual([]);
    });
  });

  describe("channel", () => {
    it("maps a channel payload", () => {
      const raw = {
        id: "C12345678",
        name: "engineering",
        purpose: { value: "Engineering discussions" },
        topic: { value: "Current sprint focus" },
        is_private: false,
        is_archived: false,
        num_members: 42,
        created: 1609459200,
      };
      const result = slack.normalizeRecord("channel", raw);
      expect(result.externalId).toBe("C12345678");
      expect(result.displayName).toBe("engineering");
      expect(result.properties["purpose"]).toBe("Engineering discussions");
      expect(result.properties["isPrivate"]).toBe(false);
      expect(result.properties["memberCount"]).toBe(42);
    });

    it("handles empty channel gracefully", () => {
      const result = slack.normalizeRecord("channel", {});
      expect(result.externalId).toBe("");
    });
  });

  describe("user", () => {
    it("maps a user payload", () => {
      const raw = {
        id: "U98765432",
        tz: "America/New_York",
        is_admin: false,
        is_bot: false,
        profile: {
          real_name: "Alice Smith",
          display_name: "alice",
          email: "alice@example.com",
          title: "Software Engineer",
        },
      };
      const result = slack.normalizeRecord("user", raw);
      expect(result.externalId).toBe("U98765432");
      expect(result.displayName).toBe("Alice Smith");
      expect(result.properties["email"]).toBe("alice@example.com");
      expect(result.properties["isBot"]).toBe(false);
      expect(result.properties["title"]).toBe("Software Engineer");
    });

    it("handles empty user gracefully", () => {
      const result = slack.normalizeRecord("user", {});
      expect(result.externalId).toBe("");
    });
  });

  it("throws on unknown sourceRecordType", () => {
    expect(() => slack.normalizeRecord("unknown", {})).toThrow(
      'slack.normalizeRecord: unknown sourceRecordType "unknown"',
    );
  });
});

describe("slack connector – verifyWebhook", () => {
  const secret = "slack-signing-secret";

  function buildSlackSig(body: string, ts: number, secret: string) {
    const baseString = `v0:${ts}:${body}`;
    return (
      "v0=" + createHmac("sha256", secret).update(baseString).digest("hex")
    );
  }

  it("accepts a valid slack signature", () => {
    const body = "payload=test-slack-payload";
    const ts = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(body);
    const sig = buildSlackSig(body, ts, secret);
    const headers = {
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": sig,
    };
    expect(slack.verifyWebhook!(payload, headers, secret)).toBe(true);
  });

  it("rejects wrong secret", () => {
    const body = "payload=test";
    const ts = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(body);
    const sig = buildSlackSig(body, ts, "wrong-secret");
    const headers = {
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": sig,
    };
    expect(slack.verifyWebhook!(payload, headers, secret)).toBe(false);
  });

  it("rejects replay attacks (timestamp older than 5 minutes)", () => {
    const body = "payload=test";
    const oldTs = Math.floor(Date.now() / 1000) - 400; // 400s ago > 300s limit
    const payload = Buffer.from(body);
    const sig = buildSlackSig(body, oldTs, secret);
    const headers = {
      "x-slack-request-timestamp": String(oldTs),
      "x-slack-signature": sig,
    };
    expect(slack.verifyWebhook!(payload, headers, secret)).toBe(false);
  });

  it("rejects missing headers", () => {
    expect(slack.verifyWebhook!(Buffer.from("body"), {}, secret)).toBe(false);
  });

  it("rejects null secret", () => {
    const ts = Math.floor(Date.now() / 1000);
    const headers = {
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": "v0=anything",
    };
    expect(slack.verifyWebhook!(Buffer.from("body"), headers, null)).toBe(
      false,
    );
  });
});
