import { describe, expect, it } from "vitest";
import { contextRecordList } from "./context.record.list";
import { getCapability } from "../registry";

describe("context.record.list capability", () => {
  it("registers under its verb-first name", () => {
    expect(getCapability("list_context_records")).toBe(contextRecordList);
  });

  it("is exposed on the api, agent, and mcp surfaces", () => {
    expect(contextRecordList.surfaces).toEqual(["api", "agent", "mcp"]);
  });

  // ── input ─────────────────────────────────────────────────────────────────

  it("applies default limit 50 and offset 0", () => {
    const parsed = contextRecordList.input.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
  });

  it("accepts a status filter", () => {
    const parsed = contextRecordList.input.parse({ status: "retired" });
    expect(parsed.status).toBe("retired");
  });

  it("rejects an unknown status filter", () => {
    expect(() => contextRecordList.input.parse({ status: "draft" })).toThrow();
  });

  // ── output ────────────────────────────────────────────────────────────────

  it("parses a valid output with one record", () => {
    const parsed = contextRecordList.output.parse({
      records: [
        {
          id: "ctr_abc",
          recordId: "no-bare-unwrap",
          title: "No bare unwrap on runtime data",
          status: "active",
          version: 3,
          checksum: "a".repeat(64),
          updatedAt: new Date(0).toISOString(),
        },
      ],
      total: 1,
    });
    expect(parsed.records[0]?.status).toBe("active");
  });

  it("allows null version facts when no version is pinned", () => {
    const parsed = contextRecordList.output.parse({
      records: [
        {
          id: "ctr_abc",
          recordId: "no-bare-unwrap",
          title: "No bare unwrap on runtime data",
          status: "retired",
          version: null,
          checksum: null,
          updatedAt: new Date(0).toISOString(),
        },
      ],
      total: 1,
    });
    expect(parsed.records[0]?.version).toBeNull();
  });
});
