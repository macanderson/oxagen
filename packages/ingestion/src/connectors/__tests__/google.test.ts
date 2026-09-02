import { describe, it, expect } from "vitest";
import { googleDrive } from "../google/drive";
import { googleCalendar } from "../google/calendar";
import { googleGmail } from "../google/gmail";
import { googleContacts } from "../google/contacts";
import { googleMeet } from "../google/meet";
import { googleTasks } from "../google/tasks";
import { googleBigQuery } from "../google/bigquery";

// ── Google Drive ──────────────────────────────────────────────────────────────

describe("google-drive – normalizeRecord", () => {
  it("maps a file payload", () => {
    const raw = {
      id: "file-id-123",
      name: "Report Q1.pdf",
      mimeType: "application/pdf",
      webViewLink: "https://drive.google.com/file/file-id-123",
      size: "102400",
      owners: [{ emailAddress: "alice@example.com" }],
      createdTime: "2024-01-01T00:00:00Z",
      modifiedTime: "2024-03-01T00:00:00Z",
      trashed: false,
      driveId: "drive-xyz",
    };
    const result = googleDrive.normalizeRecord("file", raw);
    expect(result.externalId).toBe("file-id-123");
    expect(result.displayName).toBe("Report Q1.pdf");
    expect(result.properties["mimeType"]).toBe("application/pdf");
    expect(result.properties["owners"]).toEqual(["alice@example.com"]);
    expect(result.properties["trashed"]).toBe(false);
  });

  it("handles empty file gracefully", () => {
    const result = googleDrive.normalizeRecord("file", {});
    expect(result.externalId).toBe("");
    expect(result.properties["owners"]).toEqual([]);
  });

  it("maps a folder payload", () => {
    const raw = {
      id: "folder-id-1",
      name: "Shared Docs",
      webViewLink: "https://drive.google.com/drive/folder-id-1",
      owners: [{ emailAddress: "bob@example.com" }],
      createdTime: "2023-06-01T00:00:00Z",
      modifiedTime: "2024-01-01T00:00:00Z",
    };
    const result = googleDrive.normalizeRecord("folder", raw);
    expect(result.externalId).toBe("folder-id-1");
    expect(result.displayName).toBe("Shared Docs");
    expect(result.properties["owners"]).toEqual(["bob@example.com"]);
  });

  it("throws on unknown sourceRecordType", () => {
    expect(() => googleDrive.normalizeRecord("unknown", {})).toThrow(
      'google-drive.normalizeRecord: unknown sourceRecordType "unknown"',
    );
  });
});

// ── Google Calendar ───────────────────────────────────────────────────────────

describe("google-calendar – normalizeRecord", () => {
  it("maps an event payload", () => {
    const raw = {
      id: "event-abc",
      htmlLink: "https://calendar.google.com/calendar/event?eid=event-abc",
      summary: "Team sync",
      description: "Weekly standup",
      start: { dateTime: "2024-02-01T10:00:00Z" },
      end: { dateTime: "2024-02-01T10:30:00Z" },
      attendees: [{ email: "alice@example.com" }, { email: "bob@example.com" }],
      location: "Zoom",
      status: "confirmed",
      organizer: { email: "alice@example.com" },
      created: "2024-01-15T09:00:00Z",
      updated: "2024-01-16T09:00:00Z",
    };
    const result = googleCalendar.normalizeRecord("event", raw);
    expect(result.externalId).toBe("event-abc");
    expect(result.displayName).toBe("Team sync");
    expect(result.properties["start"]).toBe("2024-02-01T10:00:00Z");
    expect(result.properties["attendees"]).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    expect(result.properties["organizer"]).toBe("alice@example.com");
  });

  it("falls back to date when dateTime is absent", () => {
    const raw = {
      id: "event-allday",
      start: { date: "2024-02-01" },
      end: { date: "2024-02-02" },
    };
    const result = googleCalendar.normalizeRecord("event", raw);
    expect(result.properties["start"]).toBe("2024-02-01");
    expect(result.properties["end"]).toBe("2024-02-02");
  });

  it("handles empty event gracefully", () => {
    const result = googleCalendar.normalizeRecord("event", {});
    expect(result.externalId).toBe("");
    expect(result.properties["attendees"]).toEqual([]);
  });

  it("throws on unknown sourceRecordType", () => {
    expect(() => googleCalendar.normalizeRecord("unknown", {})).toThrow();
  });
});

// ── Gmail ─────────────────────────────────────────────────────────────────────

describe("google-gmail – normalizeRecord", () => {
  it("maps a message payload with headers", () => {
    const raw = {
      id: "msg-xyz",
      threadId: "thread-abc",
      snippet: "Hello from the email",
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        headers: [
          { name: "Subject", value: "Hello World" },
          { name: "From", value: "sender@example.com" },
          { name: "To", value: "recipient@example.com" },
          { name: "Date", value: "Mon, 1 Jan 2024 12:00:00 +0000" },
        ],
      },
    };
    const result = googleGmail.normalizeRecord("message", raw);
    expect(result.externalId).toBe("msg-xyz");
    expect(result.displayName).toBe("Hello World");
    expect(result.properties["subject"]).toBe("Hello World");
    expect(result.properties["from"]).toBe("sender@example.com");
    expect(result.properties["threadId"]).toBe("thread-abc");
    expect(result.properties["snippet"]).toBe("Hello from the email");
  });

  it("handles empty message gracefully", () => {
    const result = googleGmail.normalizeRecord("message", {});
    expect(result.externalId).toBe("");
  });

  it("maps a thread payload", () => {
    const raw = {
      id: "thread-abc",
      snippet: "Email thread preview text",
      historyId: "hist-1",
      messages: [{}, {}],
    };
    const result = googleGmail.normalizeRecord("thread", raw);
    expect(result.externalId).toBe("thread-abc");
    expect(result.properties["snippet"]).toBe("Email thread preview text");
    expect(result.properties["messageCount"]).toBe(2);
  });

  it("throws on unknown sourceRecordType", () => {
    expect(() => googleGmail.normalizeRecord("unknown", {})).toThrow();
  });
});

// ── Google Contacts ───────────────────────────────────────────────────────────

describe("google-contacts – normalizeRecord", () => {
  it("maps a person payload", () => {
    const raw = {
      resourceName: "people/c123456",
      etag: "etag-abc",
      names: [
        { displayName: "Alice Smith", givenName: "Alice", familyName: "Smith" },
      ],
      emailAddresses: [
        { value: "alice@example.com" },
        { value: "alice.work@example.com" },
      ],
      phoneNumbers: [{ value: "+1-555-1234" }],
      organizations: [{ name: "ACME Corp", title: "Engineer" }],
    };
    const result = googleContacts.normalizeRecord("person", raw);
    expect(result.externalId).toBe("people/c123456");
    expect(result.displayName).toBe("Alice Smith");
    expect(result.properties["email"]).toBe("alice@example.com");
    expect(result.properties["givenName"]).toBe("Alice");
    expect(result.properties["organization"]).toBe("ACME Corp");
    expect(result.properties["jobTitle"]).toBe("Engineer");
  });

  it("handles empty person gracefully (sparse arrays)", () => {
    const result = googleContacts.normalizeRecord("person", {});
    expect(result.externalId).toBe("");
    expect(result.properties["email"]).toBeUndefined();
  });

  it("throws on unknown sourceRecordType", () => {
    expect(() => googleContacts.normalizeRecord("unknown", {})).toThrow();
  });
});

// ── Google Meet ───────────────────────────────────────────────────────────────

describe("google-meet – normalizeRecord", () => {
  it("maps a conference_record payload", () => {
    const raw = {
      name: "conferenceRecords/abc123",
      space: "spaces/xyz",
      startTime: "2024-02-01T14:00:00Z",
      endTime: "2024-02-01T15:00:00Z",
      participants: [{}, {}, {}],
      expireTime: "2024-05-01T14:00:00Z",
    };
    const result = googleMeet.normalizeRecord("conference_record", raw);
    expect(result.externalId).toBe("conferenceRecords/abc123");
    expect(result.properties["startTime"]).toBe("2024-02-01T14:00:00Z");
    expect(result.properties["participantCount"]).toBe(3);
  });

  it("maps a participant payload", () => {
    const raw = {
      name: "conferenceRecords/abc123/participants/p1",
      signinUser: {
        displayName: "Bob Jones",
        user: "bob@example.com",
      },
      earliestStartTime: "2024-02-01T14:01:00Z",
      latestEndTime: "2024-02-01T14:55:00Z",
    };
    const result = googleMeet.normalizeRecord("participant", raw);
    expect(result.externalId).toBe("conferenceRecords/abc123/participants/p1");
    expect(result.displayName).toBe("Bob Jones");
    expect(result.properties["email"]).toBe("bob@example.com");
  });

  it("handles empty conference_record gracefully", () => {
    const result = googleMeet.normalizeRecord("conference_record", {});
    expect(result.externalId).toBe("");
    expect(result.properties["participantCount"]).toBe(0);
  });

  it("throws on unknown sourceRecordType", () => {
    expect(() => googleMeet.normalizeRecord("unknown", {})).toThrow();
  });
});

// ── Google Tasks ──────────────────────────────────────────────────────────────

describe("google-tasks – normalizeRecord", () => {
  it("maps a task payload", () => {
    const raw = {
      id: "task-id-1",
      title: "Write unit tests",
      notes: "Cover all edge cases",
      status: "needsAction",
      due: "2024-02-15T00:00:00.000Z",
      completed: null,
      updated: "2024-01-30T10:00:00Z",
    };
    const result = googleTasks.normalizeRecord("task", raw);
    expect(result.externalId).toBe("task-id-1");
    expect(result.displayName).toBe("Write unit tests");
    expect(result.properties["status"]).toBe("needsAction");
    expect(result.properties["notes"]).toBe("Cover all edge cases");
  });

  it("handles empty task gracefully", () => {
    const result = googleTasks.normalizeRecord("task", {});
    expect(result.externalId).toBe("");
  });

  it("maps a task_list payload", () => {
    const raw = {
      id: "list-id-1",
      title: "My Tasks",
      updated: "2024-01-01T00:00:00Z",
    };
    const result = googleTasks.normalizeRecord("task_list", raw);
    expect(result.externalId).toBe("list-id-1");
    expect(result.displayName).toBe("My Tasks");
  });

  it("throws on unknown sourceRecordType", () => {
    expect(() => googleTasks.normalizeRecord("unknown", {})).toThrow();
  });
});

// ── Google BigQuery ───────────────────────────────────────────────────────────

describe("google-bigquery – normalizeRecord", () => {
  it("passes through all columns as properties", () => {
    const raw = {
      id: "bq-row-1",
      user_id: "u123",
      event_type: "page_view",
      timestamp: "2024-01-01T00:00:00Z",
      page_url: "https://app.example.com/dashboard",
    };
    const result = googleBigQuery.normalizeRecord("analytics_row", raw);
    expect(result.externalId).toBe("bq-row-1");
    expect(result.properties["user_id"]).toBe("u123");
    expect(result.properties["event_type"]).toBe("page_view");
    expect(result.properties["page_url"]).toBe(
      "https://app.example.com/dashboard",
    );
  });

  it("uses _id as fallback externalId", () => {
    const raw = { _id: "mongo-123", value: 42 };
    const result = googleBigQuery.normalizeRecord("row", raw);
    expect(result.externalId).toBe("mongo-123");
  });

  it("uses stringified JSON snippet when no id column exists", () => {
    const raw = { col1: "a", col2: "b" };
    const result = googleBigQuery.normalizeRecord("row", raw);
    expect(result.externalId.length).toBeGreaterThan(0);
  });

  it("handles null values by excluding them from properties", () => {
    const raw = { id: "r1", good: "value", bad: null };
    const result = googleBigQuery.normalizeRecord("row", raw);
    expect(result.properties["good"]).toBe("value");
    expect("bad" in result.properties).toBe(false);
  });
});

// ── Google push-channel webhook verification (X-Goog-Channel-Token) ─────────────
//
// The three Google webhook-delivery connectors (drive, calendar, gmail) verify
// inbound deliveries by comparing the X-Goog-Channel-Token header — echoed back
// from the watch `channel.token` — against the stored per-connection secret.
// This is the security boundary for the unauthenticated /webhooks route; it must
// fail CLOSED (reject) on a missing secret, missing header, or any mismatch.

const PAYLOAD = new Uint8Array(Buffer.from("{}"));

describe.each([
  ["google-drive", googleDrive],
  ["google-calendar", googleCalendar],
  ["google-gmail", googleGmail],
])("%s – verifyWebhook (X-Goog-Channel-Token)", (_name, connector) => {
  it("declares deliveryMethod webhook and implements verifyWebhook", () => {
    expect(connector.deliveryMethod).toBe("webhook");
    expect(typeof connector.verifyWebhook).toBe("function");
  });

  it("accepts a matching channel token", () => {
    const secret = "channel-token-abc123";
    expect(
      connector.verifyWebhook!(
        PAYLOAD,
        { "x-goog-channel-token": secret },
        secret,
      ),
    ).toBe(true);
  });

  it("rejects a mismatched channel token (forged delivery)", () => {
    expect(
      connector.verifyWebhook!(
        PAYLOAD,
        { "x-goog-channel-token": "wrong-token" },
        "correct-token",
      ),
    ).toBe(false);
  });

  it("rejects when the channel-token header is absent (unsigned delivery)", () => {
    expect(connector.verifyWebhook!(PAYLOAD, {}, "correct-token")).toBe(false);
  });

  it("rejects when no secret is configured (fail closed)", () => {
    expect(
      connector.verifyWebhook!(
        PAYLOAD,
        { "x-goog-channel-token": "anything" },
        null,
      ),
    ).toBe(false);
  });

  it("rejects when the token length differs from the secret (no length leak)", () => {
    expect(
      connector.verifyWebhook!(
        PAYLOAD,
        { "x-goog-channel-token": "short" },
        "a-much-longer-secret",
      ),
    ).toBe(false);
  });
});
