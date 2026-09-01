import { describe, it, expect } from "vitest";
import { zendesk } from "../zendesk/index";
import {
  loadBuiltInSchema,
  validateConfigAgainstSchema,
} from "../../connector-schema-loader";

describe("zendesk connector – normalizeRecord", () => {
  describe("ticket", () => {
    it("maps a realistic ticket payload", () => {
      const raw = {
        id: 42,
        url: "https://acme.zendesk.com/api/v2/tickets/42.json",
        subject: "Refund for duplicate charge",
        description: "I was billed twice for March.",
        status: "open",
        priority: "high",
        type: "problem",
        tags: ["billing", "refund"],
        via: { channel: "email" },
        requester_id: 100,
        assignee_id: 200,
        organization_id: 300,
        group_id: 400,
        satisfaction_rating: { score: "good" },
        due_at: "2026-03-10T00:00:00Z",
        created_at: "2026-03-01T09:00:00Z",
        updated_at: "2026-03-02T12:00:00Z",
      };
      const result = zendesk.normalizeRecord("ticket", raw);
      expect(result.externalId).toBe("42");
      expect(result.displayName).toBe("Refund for duplicate charge");
      // The agent-facing page shares the host of the API url Zendesk returns.
      expect(result.externalUrl).toBe(
        "https://acme.zendesk.com/agent/tickets/42",
      );
      expect(result.properties["status"]).toBe("open");
      expect(result.properties["priority"]).toBe("high");
      expect(result.properties["tags"]).toEqual(["billing", "refund"]);
      expect(result.properties["channel"]).toBe("email");
      expect(result.properties["satisfactionScore"]).toBe("good");
      expect(result.properties["organizationId"]).toBe(300);
      expect(result.properties["updatedAt"]).toBe("2026-03-02T12:00:00Z");
    });

    it("stringifies Zendesk's numeric id", () => {
      expect(zendesk.normalizeRecord("ticket", { id: 7 }).externalId).toBe("7");
    });

    it("omits the url when the payload carries no api url", () => {
      expect(
        zendesk.normalizeRecord("ticket", { id: 7 }).externalUrl,
      ).toBeUndefined();
    });

    it("omits the url when the api url is unparseable", () => {
      expect(
        zendesk.normalizeRecord("ticket", { id: 7, url: "not a url" })
          .externalUrl,
      ).toBeUndefined();
    });

    it("handles an empty ticket gracefully", () => {
      const result = zendesk.normalizeRecord("ticket", {});
      expect(result.externalId).toBe("");
      expect(result.displayName).toBeUndefined();
      expect(result.properties["tags"]).toEqual([]);
    });

    it("drops non-string tags rather than passing them through", () => {
      const result = zendesk.normalizeRecord("ticket", {
        id: 1,
        tags: ["ok", 5, null],
      });
      expect(result.properties["tags"]).toEqual(["ok"]);
    });
  });

  describe("ticket_comment", () => {
    it("maps a comment lifted out of a ticket event", () => {
      const raw = {
        id: 9001,
        event_type: "Comment",
        body: "We have issued the refund.",
        html_body: "<p>We have issued the refund.</p>",
        public: true,
        author_id: 200,
        ticket_id: 42,
        created_at: "2026-03-02T12:00:00Z",
      };
      const result = zendesk.normalizeRecord("ticket_comment", raw);
      expect(result.externalId).toBe("9001");
      expect(result.displayName).toBe("We have issued the refund.");
      expect(result.properties["body"]).toBe("We have issued the refund.");
      expect(result.properties["public"]).toBe(true);
      expect(result.properties["ticketId"]).toBe(42);
      expect(result.properties["createdAt"]).toBe("2026-03-02T12:00:00Z");
    });

    it("truncates a long body for the display name", () => {
      const body = "x".repeat(250);
      const result = zendesk.normalizeRecord("ticket_comment", { id: 1, body });
      expect(result.displayName).toHaveLength(100);
    });
  });

  describe("user", () => {
    it("maps a user payload", () => {
      const raw = {
        id: 200,
        url: "https://acme.zendesk.com/api/v2/users/200.json",
        name: "Alice Smith",
        email: "alice@acme.com",
        role: "agent",
        phone: "+1-555-1234",
        active: true,
        verified: true,
        suspended: false,
        organization_id: 300,
        time_zone: "Pacific Time (US & Canada)",
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2026-02-01T00:00:00Z",
      };
      const result = zendesk.normalizeRecord("user", raw);
      expect(result.externalId).toBe("200");
      expect(result.displayName).toBe("Alice Smith");
      expect(result.externalUrl).toBe(
        "https://acme.zendesk.com/agent/users/200",
      );
      expect(result.properties["email"]).toBe("alice@acme.com");
      expect(result.properties["role"]).toBe("agent");
      expect(result.properties["organizationId"]).toBe(300);
    });

    it("falls back to the email for the display name", () => {
      expect(
        zendesk.normalizeRecord("user", { id: 1, email: "a@b.com" })
          .displayName,
      ).toBe("a@b.com");
    });
  });

  describe("organization", () => {
    it("maps an organization payload", () => {
      const raw = {
        id: 300,
        url: "https://acme.zendesk.com/api/v2/organizations/300.json",
        name: "ACME Corp",
        details: "Enterprise customer",
        notes: "Renews in Q3",
        domain_names: ["acme.com", "acme.io"],
        tags: ["enterprise"],
        group_id: 400,
        shared_tickets: false,
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      };
      const result = zendesk.normalizeRecord("organization", raw);
      expect(result.externalId).toBe("300");
      expect(result.displayName).toBe("ACME Corp");
      expect(result.externalUrl).toBe(
        "https://acme.zendesk.com/agent/organizations/300",
      );
      expect(result.properties["domainNames"]).toEqual(["acme.com", "acme.io"]);
      expect(result.properties["tags"]).toEqual(["enterprise"]);
    });
  });

  describe("unknown record type", () => {
    it("throws rather than silently producing an empty record", () => {
      expect(() => zendesk.normalizeRecord("macro", { id: 1 })).toThrow(
        /unknown sourceRecordType "macro"/,
      );
    });
  });
});

describe("zendesk connector – definition", () => {
  it("declares its three credential shapes and polling delivery", () => {
    expect(zendesk.connectorId).toBe("zendesk");
    expect(zendesk.displayName).toBe("Zendesk");
    expect(zendesk.supportedAuthSchemes).toEqual([
      "oauth2_authorization_code",
      "api_key",
      "basic_auth",
    ]);
    expect(zendesk.deliveryMethod).toBe("rest_polling");
    expect(typeof zendesk.poll).toBe("function");
    expect(typeof zendesk.cursorOf).toBe("function");
  });

  it("requires a subdomain and applies config defaults", () => {
    const parsed = zendesk.connectionConfigSchema.parse({ subdomain: "acme" });
    expect(parsed).toEqual({
      subdomain: "acme",
      syncDepthDays: 90,
      pageSize: 1000,
    });
    expect(() => zendesk.connectionConfigSchema.parse({})).toThrow();
  });

  it("rejects a subdomain that is really a host, which would move the API origin", () => {
    for (const bad of [
      "acme.zendesk.com",
      "acme/../evil",
      "evil.com",
      "AcMe",
      "-acme",
    ]) {
      expect(() =>
        zendesk.connectionConfigSchema.parse({ subdomain: bad }),
      ).toThrow();
    }
  });

  it("rejects a page size above Zendesk's incremental export maximum", () => {
    expect(() =>
      zendesk.connectionConfigSchema.parse({
        subdomain: "acme",
        pageSize: 5000,
      }),
    ).toThrow();
  });
});

describe("zendesk connector – schema.yaml", () => {
  const schema = loadBuiltInSchema("zendesk");

  it("parses as a ConnectorPlugin with matching metadata", () => {
    expect(schema).not.toBeNull();
    expect(schema?.apiVersion).toBe("oxagen.ai/v1alpha1");
    expect(schema?.kind).toBe("ConnectorPlugin");
    expect(schema?.metadata.id).toBe("zendesk");
    expect(schema?.metadata.displayName).toBe("Zendesk");
    expect(schema?.metadata.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(schema?.config?.fields.length).toBeGreaterThan(0);
  });

  it("offers both an OAuth and an API-token scheme", () => {
    const kinds = schema?.auth?.schemes.map((s) => s.kind);
    expect(kinds).toEqual(["oauth2_authorization_code", "api_key"]);
  });

  it("declares only record types normalizeRecord understands", () => {
    const recordTypes = schema?.["recordTypes"] as {
      items: Array<{ id: string }>;
    };
    const ids = recordTypes.items.map((i) => i.id);
    expect(ids).toEqual(["ticket", "ticket_comment", "user", "organization"]);
    for (const id of ids) {
      expect(() => zendesk.normalizeRecord(id, { id: 1 })).not.toThrow();
    }
  });

  it("accepts a valid API-token config", () => {
    const errors = validateConfigAgainstSchema(
      {
        subdomain: "acme",
        email: "agent@acme.com",
        apiKey: "abcdefghijklmnopqrstuvwxyz01",
        syncDepthDays: 90,
        pageSize: 1000,
      },
      schema!,
      "api_token",
    );
    expect(errors).toEqual([]);
  });

  it("requires the subdomain and rejects a full host in that field", () => {
    expect(validateConfigAgainstSchema({}, schema!)).toContainEqual(
      expect.objectContaining({ field: "config.subdomain", code: "required" }),
    );
    expect(
      validateConfigAgainstSchema({ subdomain: "acme.zendesk.com" }, schema!),
    ).toContainEqual(
      expect.objectContaining({ field: "config.subdomain", code: "pattern" }),
    );
  });

  it("rejects a malformed agent email", () => {
    expect(
      validateConfigAgainstSchema(
        { subdomain: "acme", email: "not-an-email" },
        schema!,
      ),
    ).toContainEqual(
      expect.objectContaining({ field: "config.email", code: "pattern" }),
    );
  });

  it("bounds the numeric config fields", () => {
    expect(
      validateConfigAgainstSchema(
        { subdomain: "acme", pageSize: 5000 },
        schema!,
      ),
    ).toContainEqual(
      expect.objectContaining({ field: "config.pageSize", code: "max" }),
    );
    expect(
      validateConfigAgainstSchema(
        { subdomain: "acme", syncDepthDays: 9999 },
        schema!,
      ),
    ).toContainEqual(
      expect.objectContaining({ field: "config.syncDepthDays", code: "max" }),
    );
  });

  it("requires the api token under the api_token scheme", () => {
    expect(
      validateConfigAgainstSchema({ subdomain: "acme" }, schema!, "api_token"),
    ).toContainEqual(
      expect.objectContaining({ field: "auth.apiKey", code: "required" }),
    );
  });
});
