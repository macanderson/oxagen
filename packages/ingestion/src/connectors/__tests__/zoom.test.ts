import { describe, it, expect } from "vitest";
import { zoom } from "../zoom/index";

const payload = Buffer.from("test-body");

describe("zoom connector – normalizeRecord", () => {
  describe("meeting", () => {
    it("maps a realistic meeting payload", () => {
      const raw = {
        id: 123456789,
        uuid: "abc+uuid==",
        topic: "Engineering standup",
        start_time: "2024-02-01T14:00:00Z",
        duration: 30,
        host_email: "host@example.com",
        join_url: "https://zoom.us/j/123456789",
        status: "started",
        type: 2,
        timezone: "UTC",
        agenda: "Daily standup agenda",
      };
      const result = zoom.normalizeRecord("meeting", raw);
      expect(result.externalId).toBe("123456789");
      expect(result.displayName).toBe("Engineering standup");
      expect(result.properties["hostEmail"]).toBe("host@example.com");
      expect(result.properties["duration"]).toBe(30);
      expect(result.properties["joinUrl"]).toBe("https://zoom.us/j/123456789");
    });

    it("handles empty meeting gracefully", () => {
      const result = zoom.normalizeRecord("meeting", {});
      expect(result.externalId).toBe("");
    });
  });

  describe("recording", () => {
    it("maps a recording payload", () => {
      const raw = {
        uuid: "rec-uuid-123",
        topic: "Q1 Planning recording",
        start_time: "2024-01-10T15:00:00Z",
        duration: 60,
        host_email: "host@example.com",
        recording_files: [{}, {}, {}],
        total_size: 512000,
        share_url: "https://zoom.us/rec/share/abc123",
      };
      const result = zoom.normalizeRecord("recording", raw);
      expect(result.externalId).toBe("rec-uuid-123");
      expect(result.displayName).toBe("Q1 Planning recording");
      expect(result.properties["fileCount"]).toBe(3);
      expect(result.properties["totalSize"]).toBe(512000);
    });

    it("handles empty recording gracefully", () => {
      const result = zoom.normalizeRecord("recording", {});
      expect(result.externalId).toBe("");
      expect(result.properties["fileCount"]).toBe(0);
    });
  });

  describe("participant", () => {
    it("maps a participant payload", () => {
      const raw = {
        id: "participant-1",
        name: "Alice Smith",
        user_email: "alice@example.com",
        join_time: "2024-02-01T14:01:00Z",
        leave_time: "2024-02-01T14:30:00Z",
        duration: 1740,
        attentiveness_score: 95,
      };
      const result = zoom.normalizeRecord("participant", raw);
      expect(result.externalId).toBe("participant-1");
      expect(result.displayName).toBe("Alice Smith");
      expect(result.properties["email"]).toBe("alice@example.com");
      expect(result.properties["duration"]).toBe(1740);
    });

    it("handles empty participant gracefully", () => {
      const result = zoom.normalizeRecord("participant", {});
      expect(result.externalId).toBe("");
    });
  });

  it("throws on unknown sourceRecordType", () => {
    expect(() => zoom.normalizeRecord("unknown_type", {})).toThrow(
      'zoom.normalizeRecord: unknown sourceRecordType "unknown_type"',
    );
  });
});

describe("zoom connector – verifyWebhook", () => {
  it("accepts matching bearer token", () => {
    const secret = "zoom-webhook-secret-token";
    const headers = { authorization: secret };
    expect(zoom.verifyWebhook!(payload, headers, secret)).toBe(true);
  });

  it("rejects wrong token", () => {
    expect(
      zoom.verifyWebhook!(
        payload,
        { authorization: "wrong-token" },
        "correct-token",
      ),
    ).toBe(false);
  });

  it("rejects missing authorization header", () => {
    expect(zoom.verifyWebhook!(payload, {}, "secret")).toBe(false);
  });

  it("rejects null secret", () => {
    expect(zoom.verifyWebhook!(payload, { authorization: "any" }, null)).toBe(
      false,
    );
  });

  // verifyWebhook must never throw on a length mismatch, and must fail
  // closed, since a plain `===` comparison here would leak timing
  // information about the secret.
  it("rejects a mismatched-length token without throwing", () => {
    expect(() =>
      zoom.verifyWebhook!(
        payload,
        { authorization: "short" },
        "a-much-longer-webhook-secret-token",
      ),
    ).not.toThrow();
    expect(
      zoom.verifyWebhook!(
        payload,
        { authorization: "short" },
        "a-much-longer-webhook-secret-token",
      ),
    ).toBe(false);
  });
});
