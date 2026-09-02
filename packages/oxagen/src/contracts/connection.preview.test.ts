import { describe, expect, it } from "vitest";
import { connectionPreview } from "./connection.preview";
import { getCapability } from "../registry";

describe("connection.preview capability", () => {
  // ── input: connectionId required, min 1 ───────────────────────────────────

  it("parses a valid connectionId", () => {
    const parsed = connectionPreview.input.parse({
      connectionId: "conn_abc123",
    });
    expect(parsed.connectionId).toBe("conn_abc123");
  });

  it("accepts a UUID-style connectionId", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const parsed = connectionPreview.input.parse({ connectionId: uuid });
    expect(parsed.connectionId).toBe(uuid);
  });

  it("rejects empty connectionId (below min 1)", () => {
    expect(() => connectionPreview.input.parse({ connectionId: "" })).toThrow();
  });

  it("rejects missing connectionId", () => {
    expect(() => connectionPreview.input.parse({})).toThrow();
  });

  it("rejects non-string connectionId", () => {
    expect(() =>
      connectionPreview.input.parse({ connectionId: 123 }),
    ).toThrow();
  });

  // ── output shape: valid full parse ────────────────────────────────────────

  it("parses a valid output with one recordType", () => {
    const parsed = connectionPreview.output.parse({
      recordTypes: [
        {
          sourceRecordType: "Contact",
          displayName: "Contacts",
          description: "CRM contacts",
          sampleCount: 42,
          sampleFields: ["id", "name", "email"],
          sampleRecords: [
            { id: "c1", name: "Alice", email: "alice@example.com" },
          ],
        },
      ],
    });
    expect(parsed.recordTypes).toHaveLength(1);
    expect(parsed.recordTypes[0]?.sourceRecordType).toBe("Contact");
    expect(parsed.recordTypes[0]?.sampleCount).toBe(42);
    expect(parsed.recordTypes[0]?.sampleFields).toEqual([
      "id",
      "name",
      "email",
    ]);
  });

  it("parses output with optional description omitted", () => {
    const parsed = connectionPreview.output.parse({
      recordTypes: [
        {
          sourceRecordType: "Deal",
          displayName: "Deals",
          sampleCount: 0,
          sampleFields: [],
          sampleRecords: [],
        },
      ],
    });
    expect(parsed.recordTypes[0]?.description).toBeUndefined();
  });

  it("parses output with an empty recordTypes array", () => {
    const parsed = connectionPreview.output.parse({ recordTypes: [] });
    expect(parsed.recordTypes).toHaveLength(0);
  });

  it("accepts up to 3 sampleRecords (max boundary)", () => {
    const parsed = connectionPreview.output.parse({
      recordTypes: [
        {
          sourceRecordType: "Event",
          displayName: "Events",
          sampleCount: 3,
          sampleFields: ["id"],
          sampleRecords: [{ id: "e1" }, { id: "e2" }, { id: "e3" }],
        },
      ],
    });
    expect(parsed.recordTypes[0]?.sampleRecords).toHaveLength(3);
  });

  it("rejects more than 3 sampleRecords (above max)", () => {
    expect(() =>
      connectionPreview.output.parse({
        recordTypes: [
          {
            sourceRecordType: "Event",
            displayName: "Events",
            sampleCount: 4,
            sampleFields: ["id"],
            sampleRecords: [
              { id: "e1" },
              { id: "e2" },
              { id: "e3" },
              { id: "e4" },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts sampleRecords with heterogeneous keys", () => {
    const parsed = connectionPreview.output.parse({
      recordTypes: [
        {
          sourceRecordType: "Product",
          displayName: "Products",
          sampleCount: 1,
          sampleFields: ["sku", "price"],
          sampleRecords: [{ sku: "P001", price: 9.99, inStock: true }],
        },
      ],
    });
    expect(parsed.recordTypes[0]?.sampleRecords[0]?.["sku"]).toBe("P001");
  });

  it("rejects output missing recordTypes", () => {
    expect(() => connectionPreview.output.parse({})).toThrow();
  });

  it("rejects a recordType missing sourceRecordType", () => {
    expect(() =>
      connectionPreview.output.parse({
        recordTypes: [
          {
            displayName: "Contacts",
            sampleCount: 0,
            sampleFields: [],
            sampleRecords: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a recordType missing displayName", () => {
    expect(() =>
      connectionPreview.output.parse({
        recordTypes: [
          {
            sourceRecordType: "Contact",
            sampleCount: 0,
            sampleFields: [],
            sampleRecords: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a recordType missing sampleCount", () => {
    expect(() =>
      connectionPreview.output.parse({
        recordTypes: [
          {
            sourceRecordType: "Contact",
            displayName: "Contacts",
            sampleFields: [],
            sampleRecords: [],
          },
        ],
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("preview_connection")).toBe(connectionPreview);
  });
});
