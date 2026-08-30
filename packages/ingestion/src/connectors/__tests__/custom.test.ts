import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { customSql } from "../custom-sql/index";
import { customWebhook } from "../custom-webhook/index";

// ── Custom SQL ────────────────────────────────────────────────────────────────

describe("custom-sql connector – normalizeRecord", () => {
  it("maps a row with id and name columns", () => {
    const raw = {
      id: "row-42",
      name: "Product Launch Campaign",
      status: "active",
      budget: 50000,
      owner: "alice@example.com",
    };
    const result = customSql.normalizeRecord("campaign", raw);
    expect(result.externalId).toBe("row-42");
    expect(result.displayName).toBe("Product Launch Campaign");
    expect(result.properties["status"]).toBe("active");
    expect(result.properties["sourceRecordType"]).toBe("campaign");
  });

  it("uses title as displayName when name is absent", () => {
    const raw = { id: "r1", title: "My Title" };
    const result = customSql.normalizeRecord("item", raw);
    expect(result.displayName).toBe("My Title");
  });

  it("uses display_name as displayName fallback", () => {
    const raw = { id: "r2", display_name: "Display Value" };
    const result = customSql.normalizeRecord("item", raw);
    expect(result.displayName).toBe("Display Value");
  });

  it("uses subject as displayName fallback", () => {
    const raw = { id: "r3", subject: "Email Subject" };
    const result = customSql.normalizeRecord("email", raw);
    expect(result.displayName).toBe("Email Subject");
  });

  it("uses _id as fallback externalId", () => {
    const raw = { _id: "mongo-abc", title: "Doc" };
    const result = customSql.normalizeRecord("document", raw);
    expect(result.externalId).toBe("mongo-abc");
  });

  it("uses pk as last fallback externalId", () => {
    const raw = { pk: 99, title: "Item" };
    const result = customSql.normalizeRecord("item", raw);
    expect(result.externalId).toBe("99");
  });

  it("returns empty externalId when no id column exists", () => {
    const result = customSql.normalizeRecord("row", {});
    expect(result.externalId).toBe("");
  });

  it("passes through all row columns as properties", () => {
    const raw = { id: "x", field_a: "a", field_b: 123, flag: true };
    const result = customSql.normalizeRecord("row", raw);
    expect(result.properties["field_a"]).toBe("a");
    expect(result.properties["field_b"]).toBe(123);
    expect(result.properties["flag"]).toBe(true);
  });
});

// ── Custom Webhook ────────────────────────────────────────────────────────────

describe("custom-webhook connector – normalizeRecord", () => {
  it("maps an event with id and name", () => {
    const raw = {
      id: "evt-123",
      name: "user.created",
      userId: "u-456",
      email: "new-user@example.com",
    };
    const result = customWebhook.normalizeRecord("user_event", raw);
    expect(result.externalId).toBe("evt-123");
    expect(result.displayName).toBe("user.created");
    expect(result.properties["userId"]).toBe("u-456");
    expect(result.properties["sourceRecordType"]).toBe("user_event");
  });

  it("uses title as displayName fallback", () => {
    const raw = { id: "e1", title: "Event Title" };
    const result = customWebhook.normalizeRecord("event", raw);
    expect(result.displayName).toBe("Event Title");
  });

  it("falls back to sourceRecordType:unknown when no id", () => {
    const result = customWebhook.normalizeRecord("my_event", {});
    expect(result.externalId).toBe("my_event:unknown");
  });

  it("uses _id as fallback externalId", () => {
    const raw = { _id: "oid-abc", title: "Doc" };
    const result = customWebhook.normalizeRecord("doc", raw);
    expect(result.externalId).toBe("oid-abc");
  });

  it("uses externalId field as fallback", () => {
    const raw = { externalId: "ext-99", summary: "Important event" };
    const result = customWebhook.normalizeRecord("alert", raw);
    expect(result.externalId).toBe("ext-99");
    expect(result.displayName).toBe("Important event");
  });
});

describe("custom-webhook connector – verifyWebhook", () => {
  const secret = "webhook-secret-abc";
  const payload = Buffer.from("event-body");

  it("rejects requests when no secret is configured (fail closed)", () => {
    expect(customWebhook.verifyWebhook!(payload, {}, null)).toBe(false);
  });

  it("accepts valid HMAC on x-signature header", () => {
    const sig =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    expect(
      customWebhook.verifyWebhook!(payload, { "x-signature": sig }, secret),
    ).toBe(true);
  });

  it("accepts valid HMAC on x-webhook-signature header", () => {
    const sig =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    expect(
      customWebhook.verifyWebhook!(
        payload,
        { "x-webhook-signature": sig },
        secret,
      ),
    ).toBe(true);
  });

  it("accepts valid HMAC on x-hub-signature-256 header", () => {
    const sig =
      "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
    expect(
      customWebhook.verifyWebhook!(
        payload,
        { "x-hub-signature-256": sig },
        secret,
      ),
    ).toBe(true);
  });

  it("rejects wrong HMAC", () => {
    const sig =
      "sha256=" +
      createHmac("sha256", "wrong-secret").update(payload).digest("hex");
    expect(
      customWebhook.verifyWebhook!(payload, { "x-signature": sig }, secret),
    ).toBe(false);
  });

  it("rejects missing signature header when secret is set", () => {
    expect(customWebhook.verifyWebhook!(payload, {}, secret)).toBe(false);
  });
});
