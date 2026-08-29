import { describe, it, expect } from "vitest";
import { microsoft } from "../microsoft/index";

describe("microsoft connector – normalizeRecord", () => {
  describe("outlook_message", () => {
    it("maps a realistic Outlook email payload", () => {
      const raw = {
        id: "msg-id-abc123",
        subject: "Project update",
        from: { emailAddress: { name: "Alice", address: "alice@example.com" } },
        toRecipients: [
          { emailAddress: { address: "bob@example.com" } },
          { emailAddress: { address: "charlie@example.com" } },
        ],
        bodyPreview: "Here is the weekly update...",
        importance: "normal",
        isRead: true,
        hasAttachments: false,
        sentDateTime: "2024-02-01T10:00:00Z",
        receivedDateTime: "2024-02-01T10:00:05Z",
        webLink: "https://outlook.office.com/mail/inbox/AAA",
      };
      const result = microsoft.normalizeRecord("outlook_message", raw);
      expect(result.externalId).toBe("msg-id-abc123");
      expect(result.displayName).toBe("Project update");
      expect(result.properties["subject"]).toBe("Project update");
      expect(result.properties["fromName"]).toBe("Alice");
      expect(result.properties["fromEmail"]).toBe("alice@example.com");
      expect(result.properties["toRecipients"]).toEqual([
        "bob@example.com",
        "charlie@example.com",
      ]);
      expect(result.properties["isRead"]).toBe(true);
    });

    it("handles empty email gracefully", () => {
      const result = microsoft.normalizeRecord("outlook_message", {});
      expect(result.externalId).toBe("");
      expect(result.properties["toRecipients"]).toEqual([]);
    });

    it("also handles sourceRecordType 'email'", () => {
      const raw = { id: "msg-2", subject: "Hello", from: {} };
      const result = microsoft.normalizeRecord("email", raw);
      expect(result.externalId).toBe("msg-2");
    });
  });

  describe("teams_message", () => {
    it("maps a Teams message payload", () => {
      const raw = {
        id: "teams-msg-1",
        summary: "Stand-up update",
        body: { content: "Let's catch up tomorrow" },
        from: { user: { id: "user-1", displayName: "Bob" } },
        channelIdentity: "channel-abc",
        messageType: "message",
        importance: "normal",
        replyToId: null,
        createdDateTime: "2024-02-01T09:00:00Z",
        lastModifiedDateTime: "2024-02-01T09:00:00Z",
        webUrl: "https://teams.microsoft.com/link/to/message",
      };
      const result = microsoft.normalizeRecord("teams_message", raw);
      expect(result.externalId).toBe("teams-msg-1");
      expect(result.displayName).toBe("Stand-up update");
      expect(result.properties["fromUserName"]).toBe("Bob");
      expect(result.properties["body"]).toBe("Let's catch up tomorrow");
    });

    it("falls back to body content when no summary", () => {
      const raw = {
        id: "msg-3",
        body: { content: "This is a long message with no summary field" },
        from: {},
      };
      const result = microsoft.normalizeRecord("teams_message", raw);
      // displayName = body content sliced at 100; the test body is < 100 chars so we get the full string
      expect(result.displayName).toBe(
        "This is a long message with no summary field",
      );
    });
  });

  describe("sharepoint_file / onedrive_file", () => {
    it("maps a SharePoint file payload", () => {
      const raw = {
        id: "sp-file-1",
        name: "Quarterly Report.xlsx",
        webUrl: "https://company.sharepoint.com/sites/docs/Quarterly.xlsx",
        size: 20480,
        file: { mimeType: "application/vnd.ms-excel" },
        createdBy: { user: { displayName: "Alice" } },
        lastModifiedBy: { user: { displayName: "Bob" } },
        createdDateTime: "2024-01-01T00:00:00Z",
        lastModifiedDateTime: "2024-02-01T00:00:00Z",
      };
      const result = microsoft.normalizeRecord("sharepoint_file", raw);
      expect(result.externalId).toBe("sp-file-1");
      expect(result.displayName).toBe("Quarterly Report.xlsx");
      expect(result.properties["mimeType"]).toBe("application/vnd.ms-excel");
      expect(result.properties["createdBy"]).toBe("Alice");
      expect(result.properties["lastModifiedBy"]).toBe("Bob");
    });

    it("handles onedrive_file sourceRecordType", () => {
      const raw = { id: "od-1", name: "doc.pdf" };
      const result = microsoft.normalizeRecord("onedrive_file", raw);
      expect(result.externalId).toBe("od-1");
      expect(result.displayName).toBe("doc.pdf");
    });
  });

  describe("calendar_event", () => {
    it("maps a calendar event payload", () => {
      const raw = {
        id: "cal-event-1",
        webLink: "https://outlook.office.com/calendar/event/cal-event-1",
        subject: "Board meeting",
        organizer: { emailAddress: { address: "ceo@company.com" } },
        attendees: [
          { emailAddress: { address: "coo@company.com" } },
          { emailAddress: { address: "cto@company.com" } },
        ],
        start: { dateTime: "2024-03-15T14:00:00Z" },
        end: { dateTime: "2024-03-15T15:00:00Z" },
        location: { displayName: "Boardroom A" },
        isOnlineMeeting: false,
        bodyPreview: "Quarterly review",
      };
      const result = microsoft.normalizeRecord("calendar_event", raw);
      expect(result.externalId).toBe("cal-event-1");
      expect(result.displayName).toBe("Board meeting");
      expect(result.properties["organizer"]).toBe("ceo@company.com");
      expect(result.properties["attendees"]).toEqual([
        "coo@company.com",
        "cto@company.com",
      ]);
      expect(result.properties["start"]).toBe("2024-03-15T14:00:00Z");
      expect(result.properties["location"]).toBe("Boardroom A");
    });

    it("handles empty calendar event gracefully", () => {
      const result = microsoft.normalizeRecord("calendar_event", {});
      expect(result.externalId).toBe("");
      expect(result.properties["attendees"]).toEqual([]);
    });
  });

  it("throws on unknown sourceRecordType", () => {
    expect(() => microsoft.normalizeRecord("unknown_type", {})).toThrow(
      'microsoft.normalizeRecord: unknown sourceRecordType "unknown_type"',
    );
  });
});

describe("microsoft connector – verifyWebhook", () => {
  const secret = "my-client-state-secret";

  function makeNotificationPayload(
    clientState: string | undefined,
    count = 1,
  ): Uint8Array {
    const notifications = Array.from({ length: count }, () => ({
      clientState,
      changeType: "created",
      resource: "users/user-id/messages/msg-id",
    }));
    return Buffer.from(JSON.stringify({ value: notifications }));
  }

  it("returns true when all notifications have a clientState matching the secret", () => {
    const payload = makeNotificationPayload(secret);
    expect(microsoft.verifyWebhook!(payload, {}, secret)).toBe(true);
  });

  it("returns true for multiple notifications all with matching clientState", () => {
    const payload = makeNotificationPayload(secret, 3);
    expect(microsoft.verifyWebhook!(payload, {}, secret)).toBe(true);
  });

  it("returns false when clientState does not match the secret", () => {
    const payload = makeNotificationPayload("wrong-secret");
    expect(microsoft.verifyWebhook!(payload, {}, secret)).toBe(false);
  });

  it("returns false when any notification has a mismatched clientState", () => {
    const body = {
      value: [
        { clientState: secret, changeType: "created", resource: "a" },
        { clientState: "wrong", changeType: "created", resource: "b" },
      ],
    };
    const payload = Buffer.from(JSON.stringify(body));
    expect(microsoft.verifyWebhook!(payload, {}, secret)).toBe(false);
  });

  it("returns false when clientState field is absent from a notification", () => {
    const body = { value: [{ changeType: "created", resource: "a" }] };
    const payload = Buffer.from(JSON.stringify(body));
    expect(microsoft.verifyWebhook!(payload, {}, secret)).toBe(false);
  });

  it("returns false when secret is null", () => {
    const payload = makeNotificationPayload(secret);
    expect(microsoft.verifyWebhook!(payload, {}, null)).toBe(false);
  });

  it("returns false when secret is null even if payload would otherwise match", () => {
    const payload = makeNotificationPayload(undefined);
    expect(microsoft.verifyWebhook!(payload, {}, null)).toBe(false);
  });

  it("returns false when the notification body is not valid JSON", () => {
    const payload = Buffer.from("not-json");
    expect(microsoft.verifyWebhook!(payload, {}, secret)).toBe(false);
  });

  it("returns false when the body has no 'value' array", () => {
    const payload = Buffer.from(JSON.stringify({ notifications: [] }));
    expect(microsoft.verifyWebhook!(payload, {}, secret)).toBe(false);
  });

  it("returns false when the 'value' array is empty", () => {
    const payload = Buffer.from(JSON.stringify({ value: [] }));
    expect(microsoft.verifyWebhook!(payload, {}, secret)).toBe(false);
  });

  // The clientState check must never throw on a length mismatch, and must
  // fail closed, since a plain `===` comparison here would leak timing
  // information about the secret.
  it("rejects a mismatched-length clientState without throwing", () => {
    const payload = makeNotificationPayload("short");
    const longSecret = "a-much-longer-client-state-secret-value";
    expect(() =>
      microsoft.verifyWebhook!(payload, {}, longSecret),
    ).not.toThrow();
    expect(microsoft.verifyWebhook!(payload, {}, longSecret)).toBe(false);
  });
});
