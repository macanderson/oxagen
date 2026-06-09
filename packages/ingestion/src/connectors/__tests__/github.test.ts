import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { github } from "../github/index";

const payload = Buffer.from("test-body");

describe("github connector – normalizeRecord", () => {
  describe("pull_request", () => {
    it("maps a realistic PR payload", () => {
      const raw = {
        number: 42,
        id: 999,
        html_url: "https://github.com/org/repo/pull/42",
        title: "Add OAuth login",
        body: "Implements RFC-123",
        state: "open",
        user: { login: "macanderson" },
        labels: [{ name: "auth" }, { name: "security" }],
        merged_at: null,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-02T00:00:00Z",
      };
      const result = github.normalizeRecord("pull_request", raw);
      expect(result.externalId).toBe("42");
      expect(result.displayName).toBe("Add OAuth login");
      expect(result.properties["state"]).toBe("open");
      expect(result.properties["author"]).toBe("macanderson");
      expect(result.properties["labels"]).toEqual(["auth", "security"]);
    });

    it("handles empty object gracefully", () => {
      const result = github.normalizeRecord("pull_request", {});
      expect(result.externalId).toBe("");
      expect(result.properties["state"]).toBeUndefined();
    });
  });

  describe("issue", () => {
    it("maps a realistic issue payload", () => {
      const raw = {
        number: 7,
        html_url: "https://github.com/org/repo/issues/7",
        title: "Bug: crash on load",
        body: "Steps to reproduce...",
        state: "closed",
        user: { login: "alice" },
        labels: [{ name: "bug" }],
        closed_at: "2024-02-01T12:00:00Z",
        created_at: "2024-01-28T00:00:00Z",
        updated_at: "2024-02-01T12:00:00Z",
      };
      const result = github.normalizeRecord("issue", raw);
      expect(result.externalId).toBe("7");
      expect(result.displayName).toBe("Bug: crash on load");
      expect(result.properties["state"]).toBe("closed");
      expect(result.properties["author"]).toBe("alice");
      expect(result.properties["labels"]).toEqual(["bug"]);
    });

    it("handles empty object gracefully", () => {
      const result = github.normalizeRecord("issue", {});
      expect(result.externalId).toBe("");
    });
  });

  describe("commit", () => {
    it("maps a commit payload", () => {
      const raw = {
        sha: "abc123",
        html_url: "https://github.com/org/repo/commit/abc123",
        commit: {
          message: "fix: resolve null crash\n\nExtended description",
          author: { name: "Bob", email: "bob@example.com", date: "2024-01-10T09:00:00Z" },
        },
      };
      const result = github.normalizeRecord("commit", raw);
      expect(result.externalId).toBe("abc123");
      expect(result.displayName).toBe("fix: resolve null crash");
      expect(result.properties["sha"]).toBe("abc123");
      expect(result.properties["author"]).toBe("Bob");
      expect(result.properties["authorEmail"]).toBe("bob@example.com");
    });

    it("handles empty object gracefully", () => {
      const result = github.normalizeRecord("commit", {});
      expect(result.externalId).toBe("");
    });
  });

  describe("repository", () => {
    it("maps a repository payload", () => {
      const raw = {
        id: 12345,
        name: "my-repo",
        full_name: "org/my-repo",
        description: "Main repo",
        owner: { login: "org" },
        private: false,
        language: "TypeScript",
        stargazers_count: 100,
        html_url: "https://github.com/org/my-repo",
        created_at: "2020-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
      };
      const result = github.normalizeRecord("repository", raw);
      expect(result.externalId).toBe("12345");
      expect(result.displayName).toBe("org/my-repo");
      expect(result.properties["language"]).toBe("TypeScript");
      expect(result.properties["owner"]).toBe("org");
      expect(result.properties["private"]).toBe(false);
    });
  });

  describe("release", () => {
    it("maps a release payload", () => {
      const raw = {
        id: 55,
        html_url: "https://github.com/org/repo/releases/tag/v1.0.0",
        name: "v1.0.0",
        tag_name: "v1.0.0",
        body: "Initial release",
        author: { login: "macanderson" },
        draft: false,
        prerelease: false,
        published_at: "2024-01-15T10:00:00Z",
      };
      const result = github.normalizeRecord("release", raw);
      expect(result.externalId).toBe("55");
      expect(result.displayName).toBe("v1.0.0");
      expect(result.properties["tagName"]).toBe("v1.0.0");
      expect(result.properties["draft"]).toBe(false);
    });
  });

  describe("comment", () => {
    it("maps a comment payload", () => {
      const raw = {
        id: 88,
        body: "LGTM, great work!",
        html_url: "https://github.com/org/repo/issues/7#comment-88",
        created_at: "2024-01-29T08:00:00Z",
      };
      const result = github.normalizeRecord("comment", raw);
      expect(result.externalId).toBe("88");
      expect(result.properties["body"]).toBe("LGTM, great work!");
    });
  });

  it("throws on unknown sourceRecordType", () => {
    expect(() => github.normalizeRecord("unknown_type", {})).toThrow(
      'github.normalizeRecord: unknown sourceRecordType "unknown_type"',
    );
  });
});

describe("github connector – verifyWebhook", () => {
  const secret = "my-webhook-secret";

  it("accepts a valid HMAC-SHA256 signature", () => {
    const sig = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    const headers = { "x-hub-signature-256": sig };
    expect(github.verifyWebhook!(payload, headers, secret)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const sig = "sha256=" + createHmac("sha256", "wrong-secret").update(payload).digest("hex");
    expect(github.verifyWebhook!(payload, { "x-hub-signature-256": sig }, secret)).toBe(false);
  });

  it("rejects missing signature header", () => {
    expect(github.verifyWebhook!(payload, {}, secret)).toBe(false);
  });

  it("rejects null secret", () => {
    const sig = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    expect(github.verifyWebhook!(payload, { "x-hub-signature-256": sig }, null)).toBe(false);
  });
});
