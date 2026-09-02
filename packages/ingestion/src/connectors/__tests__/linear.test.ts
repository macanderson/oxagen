import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { linear } from "../linear/index";

const payload = Buffer.from("test-linear-body");

describe("linear connector – normalizeRecord", () => {
  describe("issue", () => {
    it("maps a realistic issue payload", () => {
      const raw = {
        id: "issue-uuid-abc",
        url: "https://linear.app/team/issue/ABC-42",
        title: "Fix authentication bug",
        description: "Users can't login with SSO",
        state: { name: "In Progress" },
        priority: 1,
        assignee: { name: "Alice", email: "alice@example.com" },
        labels: [{ name: "bug" }, { name: "auth" }],
        identifier: "ABC-42",
        estimate: 3,
        dueDate: "2024-03-01",
        createdAt: "2024-01-15T09:00:00Z",
        updatedAt: "2024-02-01T11:00:00Z",
      };
      const result = linear.normalizeRecord("issue", raw);
      expect(result.externalId).toBe("issue-uuid-abc");
      expect(result.displayName).toBe("Fix authentication bug");
      expect(result.properties["state"]).toBe("In Progress");
      expect(result.properties["assignee"]).toBe("Alice");
      expect(result.properties["labels"]).toEqual(["bug", "auth"]);
      expect(result.properties["identifier"]).toBe("ABC-42");
    });

    it("handles empty issue gracefully", () => {
      const result = linear.normalizeRecord("issue", {});
      expect(result.externalId).toBe("");
      expect(result.properties["labels"]).toEqual([]);
    });
  });

  describe("project", () => {
    it("maps a project payload", () => {
      const raw = {
        id: "proj-uuid-1",
        url: "https://linear.app/team/project/my-project",
        name: "Q1 Roadmap",
        description: "All Q1 features",
        state: "started",
        lead: { name: "Bob" },
        progress: 0.45,
        startDate: "2024-01-01",
        targetDate: "2024-03-31",
        createdAt: "2023-12-01T00:00:00Z",
        updatedAt: "2024-01-15T00:00:00Z",
      };
      const result = linear.normalizeRecord("project", raw);
      expect(result.externalId).toBe("proj-uuid-1");
      expect(result.displayName).toBe("Q1 Roadmap");
      expect(result.properties["state"]).toBe("started");
      expect(result.properties["lead"]).toBe("Bob");
      expect(result.properties["progress"]).toBe(0.45);
    });

    it("handles empty project gracefully", () => {
      const result = linear.normalizeRecord("project", {});
      expect(result.externalId).toBe("");
    });
  });

  describe("cycle", () => {
    it("maps a cycle payload", () => {
      const raw = {
        id: "cycle-uuid-5",
        url: "https://linear.app/team/cycle/5",
        name: "Sprint 5",
        number: 5,
        startsAt: "2024-02-01T00:00:00Z",
        endsAt: "2024-02-14T00:00:00Z",
        progress: 0.8,
      };
      const result = linear.normalizeRecord("cycle", raw);
      expect(result.externalId).toBe("cycle-uuid-5");
      expect(result.displayName).toBe("Sprint 5");
      expect(result.properties["number"]).toBe(5);
      expect(result.properties["startsAt"]).toBe("2024-02-01T00:00:00Z");
    });

    it("falls back to Cycle {number} when no name", () => {
      const raw = { id: "cycle-2", number: 2 };
      const result = linear.normalizeRecord("cycle", raw);
      expect(result.displayName).toBe("Cycle 2");
    });
  });

  it("throws on unknown sourceRecordType", () => {
    expect(() => linear.normalizeRecord("unknown", {})).toThrow(
      'linear.normalizeRecord: unknown sourceRecordType "unknown"',
    );
  });
});

describe("linear connector – verifyWebhook", () => {
  const secret = "linear-webhook-secret";

  it("accepts a valid linear-signature (raw hex, no sha256= prefix)", () => {
    const sig = createHmac("sha256", secret).update(payload).digest("hex");
    const headers = { "linear-signature": sig };
    expect(linear.verifyWebhook!(payload, headers, secret)).toBe(true);
  });

  it("rejects wrong secret", () => {
    const sig = createHmac("sha256", "wrong").update(payload).digest("hex");
    expect(
      linear.verifyWebhook!(payload, { "linear-signature": sig }, secret),
    ).toBe(false);
  });

  it("rejects missing header", () => {
    expect(linear.verifyWebhook!(payload, {}, secret)).toBe(false);
  });

  it("rejects null secret", () => {
    const sig = createHmac("sha256", secret).update(payload).digest("hex");
    expect(
      linear.verifyWebhook!(payload, { "linear-signature": sig }, null),
    ).toBe(false);
  });
});
