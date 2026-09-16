// The Audit page's URL filters: what a request may ask for, and what it may
// not. A value the record cannot hold is dropped rather than sent to the
// contract, so a hand-edited URL opens the newest page instead of an error,
// and the link builder carries exactly the filters that are set.
import { EMITTED_SECURITY_EVENT_TYPES } from "@oxagen/compliance";
import { describe, expect, it } from "vitest";
import { AUDIT_PAGE_SIZE, type AuditQuery } from "@/data/contracts/audit";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_OUTCOMES,
  auditQueryParams,
  hasAuditFilters,
  parseAuditExportFormat,
  parseAuditQuery,
} from "./filters";

const NONE: AuditQuery = {
  eventType: null,
  outcome: null,
  actor: null,
  capability: null,
  from: null,
  to: null,
  offset: 0,
};

const anEventType = AUDIT_EVENT_TYPES[0] ?? "";

describe("the filter options", () => {
  it("offers the event types something writes, and the outcomes the column admits", () => {
    expect(AUDIT_EVENT_TYPES).toEqual(EMITTED_SECURITY_EVENT_TYPES);
    expect(AUDIT_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(AUDIT_OUTCOMES).toEqual(["allow", "deny", "error", "success"]);
  });
});

describe("parseAuditQuery", () => {
  it("reads every filter a request sets", () => {
    expect(
      parseAuditQuery({
        eventType: anEventType,
        outcome: "deny",
        actor: "usr_7k2m9q4x8r1t5v3w",
        capability: "query_audit_log",
        from: "2026-09-01",
        to: "2026-09-15",
        offset: "100",
      }),
    ).toEqual({
      eventType: anEventType,
      outcome: "deny",
      actor: "usr_7k2m9q4x8r1t5v3w",
      capability: "query_audit_log",
      from: "2026-09-01",
      to: "2026-09-15",
      offset: 100,
    });
  });

  it("asks for the newest page when the request names no filter", () => {
    expect(parseAuditQuery({})).toEqual(NONE);
  });

  it("drops an event type nothing writes (negative)", () => {
    expect(parseAuditQuery({ eventType: "billing.nothing_writes_this" })).toEqual(
      NONE,
    );
  });

  it("drops an outcome the column cannot hold (negative)", () => {
    expect(parseAuditQuery({ outcome: "maybe" })).toEqual(NONE);
  });

  it("drops an actor that is not a user public id (negative)", () => {
    for (const actor of ["7c9e6679-7425-40de-944b-e07fc1f90ae7", "usr_", "x"])
      expect(parseAuditQuery({ actor }).actor).toBeNull();
  });

  it("drops a capability name no registry could hold (negative)", () => {
    for (const capability of ["Query Audit Log", "'; drop table", "a".repeat(80)])
      expect(parseAuditQuery({ capability }).capability).toBeNull();
  });

  it("drops a day that is not a day, and a range that runs backwards (negative)", () => {
    expect(parseAuditQuery({ from: "yesterday" }).from).toBeNull();
    expect(parseAuditQuery({ from: "2026-09-15", to: "2026-09-01" })).toEqual(
      NONE,
    );
    expect(parseAuditQuery({ from: "2026-09-15", to: "2026-09-15" })).toEqual({
      ...NONE,
      from: "2026-09-15",
      to: "2026-09-15",
    });
  });

  it("clamps an offset that is negative, fractional or not a number, and lands it on a page boundary (negative)", () => {
    for (const offset of ["-50", "not-a-number", "", "0"])
      expect(parseAuditQuery({ offset }).offset).toBe(0);
    expect(parseAuditQuery({ offset: "70" }).offset).toBe(AUDIT_PAGE_SIZE);
    expect(parseAuditQuery({ offset: "100.7" }).offset).toBe(
      2 * AUDIT_PAGE_SIZE,
    );
  });

  it("reads the first value when a parameter arrives repeated", () => {
    expect(parseAuditQuery({ outcome: ["deny", "allow"] }).outcome).toBe("deny");
  });
});

describe("hasAuditFilters", () => {
  it("is false for the newest page and true for any filter, the offset aside", () => {
    expect(hasAuditFilters(NONE)).toBe(false);
    expect(hasAuditFilters({ ...NONE, offset: 100 })).toBe(false);
    expect(hasAuditFilters({ ...NONE, outcome: "deny" })).toBe(true);
  });
});

describe("auditQueryParams", () => {
  it("carries the filters that are set and leaves the first page's offset off", () => {
    expect(
      auditQueryParams({ ...NONE, outcome: "deny", capability: "get_run" }),
    ).toEqual({
      eventType: undefined,
      outcome: "deny",
      actor: undefined,
      capability: "get_run",
      from: undefined,
      to: undefined,
      offset: undefined,
      format: undefined,
    });
  });

  it("takes the offset and the format a link asks for", () => {
    expect(
      auditQueryParams({ ...NONE, offset: 50 }, { offset: 100, format: "csv" }),
    ).toMatchObject({ offset: "100", format: "csv" });
  });
});

describe("parseAuditExportFormat", () => {
  it("reads the two formats the contract answers, and nothing else (negative)", () => {
    expect(parseAuditExportFormat({ format: "csv" })).toBe("csv");
    expect(parseAuditExportFormat({ format: "ndjson" })).toBe("ndjson");
    expect(parseAuditExportFormat({ format: "pdf" })).toBeNull();
    expect(parseAuditExportFormat({})).toBeNull();
  });
});
