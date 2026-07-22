import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { github } from "../github/index";
import type { RecordTypeSample } from "../types";

const payload = Buffer.from("test-body");

describe("github connector – previewRecordTypes", () => {
  it("returns an array of RecordTypeSample with the correct shape", async () => {
    const samples = await github.previewRecordTypes(
      { scheme: "oauth2", _marker: "oauth2" },
      { organizations: ["oxagen"], syncDepthDays: 90 },
    );

    expect(Array.isArray(samples)).toBe(true);
    expect(samples.length).toBeGreaterThan(0);

    for (const sample of samples) {
      // Each entry must match RecordTypeSample shape
      const s = sample as RecordTypeSample;
      expect(typeof s.sourceRecordType).toBe("string");
      expect(s.sourceRecordType.length).toBeGreaterThan(0);
      expect(typeof s.displayName).toBe("string");
      expect(s.displayName.length).toBeGreaterThan(0);
      expect(Array.isArray(s.sampleRecords)).toBe(true);
      expect(typeof s.fieldSchema).toBe("object");
      expect(s.fieldSchema).not.toBeNull();
      // Must NOT have old wrong-shape keys
      expect(
        (s as unknown as Record<string, unknown>)["recordType"],
      ).toBeUndefined();
      expect(
        (s as unknown as Record<string, unknown>)["sample"],
      ).toBeUndefined();
    }
  });

  it("includes provider metadata record types and excludes source content", async () => {
    const samples = await github.previewRecordTypes(
      { scheme: "oauth2", _marker: "oauth2" },
      { organizations: ["oxagen"], syncDepthDays: 90 },
    );
    const types = samples.map((s) => s.sourceRecordType);
    expect(types).toContain("pull_request");
    expect(types).toContain("issue");
    expect(types).toContain("commit");
    expect(types).toContain("repository");
    expect(types).toContain("release");
    expect(types).not.toContain("source");
  });

  it("pull_request has correct fieldSchema keys", async () => {
    const samples = await github.previewRecordTypes(
      { scheme: "oauth2", _marker: "oauth2" },
      { organizations: ["oxagen"], syncDepthDays: 90 },
    );
    const pr = samples.find((s) => s.sourceRecordType === "pull_request");
    expect(pr).toBeDefined();
    expect(pr!.fieldSchema["title"]).toBe("string");
    expect(pr!.fieldSchema["state"]).toBe("string");
    expect(pr!.fieldSchema["author"]).toBe("string");
  });
});

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
          author: {
            name: "Bob",
            email: "bob@example.com",
            date: "2024-01-10T09:00:00Z",
          },
        },
      };
      const result = github.normalizeRecord("commit", raw);
      expect(result.externalId).toBe("abc123");
      expect(result.displayName).toBe("fix: resolve null crash");
      expect(result.properties["sha"]).toBe("abc123");
      expect(result.properties["author"]).toBe("Bob");
      expect(result.properties["authorEmail"]).toBe("bob@example.com");
    });

    it("attaches git_branch when the field is present in the raw payload", () => {
      const raw = {
        sha: "def456",
        html_url: "https://github.com/org/repo/commit/def456",
        git_branch: "main",
        commit: {
          message: "feat: add telemetry",
          author: {
            name: "Alice",
            email: "alice@example.com",
            date: "2024-02-01T10:00:00Z",
          },
        },
      };
      const result = github.normalizeRecord("commit", raw);
      expect(result.properties["git_branch"]).toBe("main");
    });

    it("omits git_branch when the field is absent from the raw payload", () => {
      const raw = {
        sha: "def456",
        html_url: "https://github.com/org/repo/commit/def456",
        commit: {
          message: "feat: add telemetry",
          author: {
            name: "Alice",
            email: "alice@example.com",
            date: "2024-02-01T10:00:00Z",
          },
        },
      };
      const result = github.normalizeRecord("commit", raw);
      expect(result.properties).not.toHaveProperty("git_branch");
    });

    it("includes git_branch in fieldSchema", async () => {
      const samples = await github.previewRecordTypes(
        { scheme: "oauth2", _marker: "oauth2" },
        { organizations: ["oxagen"], syncDepthDays: 90 },
      );
      const commit = samples.find((s) => s.sourceRecordType === "commit");
      expect(commit!.fieldSchema["git_branch"]).toBe("string");
    });

    it("handles empty object gracefully", () => {
      const result = github.normalizeRecord("commit", {});
      expect(result.externalId).toBe("");
    });

    it("does not include git_branch in properties when raw payload has non-string git_branch", () => {
      const raw = {
        sha: "xyz",
        git_branch: 42, // non-string — should be ignored
        commit: {
          message: "chore: misc",
          author: {
            name: "Dev",
            email: "dev@example.com",
            date: "2024-03-01T00:00:00Z",
          },
        },
      };
      const result = github.normalizeRecord("commit", raw);
      // asString(42) returns undefined, so git_branch must not appear
      expect(result.properties).not.toHaveProperty("git_branch");
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
    const sig =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    const headers = { "x-hub-signature-256": sig };
    expect(github.verifyWebhook!(payload, headers, secret)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const sig =
      "sha256=" +
      createHmac("sha256", "wrong-secret").update(payload).digest("hex");
    expect(
      github.verifyWebhook!(payload, { "x-hub-signature-256": sig }, secret),
    ).toBe(false);
  });

  it("rejects missing signature header", () => {
    expect(github.verifyWebhook!(payload, {}, secret)).toBe(false);
  });

  it("rejects null secret", () => {
    const sig =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    expect(
      github.verifyWebhook!(payload, { "x-hub-signature-256": sig }, null),
    ).toBe(false);
  });
});

describe("github connector – parseWebhookEvent", () => {
  it("maps pull_request → pull_request and unwraps the payload", () => {
    const out = github.parseWebhookEvent!("pull_request", {
      action: "opened",
      pull_request: {
        number: 7,
        title: "Add feature",
        html_url: "https://gh/pr/7",
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.sourceRecordType).toBe("pull_request");
    // The unwrapped record is what normalizeRecord("pull_request") consumes.
    const norm = github.normalizeRecord("pull_request", out[0]!.record);
    expect(norm.externalId).toBe("7");
    expect(norm.displayName).toBe("Add feature");
  });

  it("maps issues → issue (singular record type)", () => {
    const out = github.parseWebhookEvent!("issues", {
      action: "opened",
      issue: { number: 12, title: "Bug" },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.sourceRecordType).toBe("issue");
  });

  it("maps issue_comment and pull_request_review_comment → comment", () => {
    expect(
      github.parseWebhookEvent!("issue_comment", {
        comment: { id: 1, body: "hi" },
      })[0]?.sourceRecordType,
    ).toBe("comment");
    expect(
      github.parseWebhookEvent!("pull_request_review_comment", {
        comment: { id: 2, body: "nit" },
      })[0]?.sourceRecordType,
    ).toBe("comment");
  });

  it("maps pull_request_review → code_review (record from `review`)", () => {
    const out = github.parseWebhookEvent!("pull_request_review", {
      review: { id: 99, body: "LGTM", html_url: "https://gh/r/99" },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.sourceRecordType).toBe("code_review");
    expect(
      github.normalizeRecord("code_review", out[0]!.record).externalId,
    ).toBe("99");
  });

  it("expands a push into one commit record per commit, reshaped for normalizeRecord", () => {
    const out = github.parseWebhookEvent!("push", {
      ref: "refs/heads/main",
      commits: [
        {
          id: "abc123",
          message: "first\nbody",
          url: "https://gh/c/abc123",
          timestamp: "2026-06-14T00:00:00Z",
          author: { name: "Dev", email: "dev@example.com" },
        },
        {
          id: "def456",
          message: "second",
          url: "https://gh/c/def456",
          timestamp: "2026-06-14T01:00:00Z",
          author: { name: "Dev", email: "dev@example.com" },
        },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.sourceRecordType === "commit")).toBe(true);
    // Reshaped record must satisfy normalizeRecord("commit").
    const norm = github.normalizeRecord("commit", out[0]!.record);
    expect(norm.externalId).toBe("abc123");
    expect(norm.displayName).toBe("first"); // first line of the message
    expect(norm.properties.git_branch).toBe("main");
    expect(norm.properties.author).toBe("Dev");
    expect(norm.properties.committedAt).toBe("2026-06-14T00:00:00Z");
  });

  it("skips push commits with no id", () => {
    const out = github.parseWebhookEvent!("push", {
      ref: "refs/heads/main",
      commits: [{ message: "no id" }],
    });
    expect(out).toHaveLength(0);
  });

  it("maps release and repository events", () => {
    expect(
      github.parseWebhookEvent!("release", {
        release: { id: 5, tag_name: "v1" },
      })[0]?.sourceRecordType,
    ).toBe("release");
    expect(
      github.parseWebhookEvent!("repository", {
        repository: { id: 8, name: "repo" },
      })[0]?.sourceRecordType,
    ).toBe("repository");
  });

  it("returns [] for events with no ingestable record (ping/installation/etc.)", () => {
    expect(github.parseWebhookEvent!("ping", { zen: "..." })).toEqual([]);
    expect(
      github.parseWebhookEvent!("installation", { action: "created" }),
    ).toEqual([]);
    expect(github.parseWebhookEvent!("star", { action: "created" })).toEqual(
      [],
    );
  });

  it("returns [] when the expected sub-object is missing", () => {
    expect(
      github.parseWebhookEvent!("pull_request", { action: "opened" }),
    ).toEqual([]);
  });
});
