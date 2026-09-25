// The Audit page's URL filters: what a request may ask for, and what it may
// not. A value the record cannot hold is dropped rather than sent to the
// contract, so a hand-edited URL opens the newest page instead of an error,
// and the link builder carries exactly the filters that are set.
import { EMITTED_SECURITY_EVENT_TYPES } from "@oxagen/compliance";
import { describe, expect, it, vi } from "vitest";
import type { AuditFilters, AuditQuery } from "@/data/contracts/audit";
import type { DataSource } from "@/data/ports";
import {
  AUDIT_EVENT_TYPES,
  AUDIT_OUTCOMES,
  auditQueryParams,
  auditWindow,
  hasAuditFilters,
  parseAuditExportFormat,
  parseAuditQuery,
} from "./filters";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");

const NONE: AuditQuery = {
  eventType: null,
  outcome: null,
  actor: null,
  capability: null,
  range: "30d",
  from: null,
  to: null,
  rows: 10,
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
        range: "7d",
        rows: "25",
        offset: "100",
      }),
    ).toEqual({
      eventType: anEventType,
      outcome: "deny",
      actor: "usr_7k2m9q4x8r1t5v3w",
      capability: "query_audit_log",
      range: "7d",
      from: "2026-09-01",
      to: "2026-09-15",
      rows: 25,
      offset: 100,
    });
  });

  it("opens on thirty days and ten rows, and drops a Range or Rows the selects do not offer (negative)", () => {
    expect(parseAuditQuery({ range: "1y", rows: "1000" })).toEqual(NONE);
    expect(parseAuditQuery({ range: "48h", rows: "50" })).toMatchObject({
      range: "48h",
      rows: 50,
    });
  });

  it("asks for the newest page when the request names no filter", () => {
    expect(parseAuditQuery({})).toEqual(NONE);
  });

  it("drops an event type nothing writes (negative)", () => {
    expect(
      parseAuditQuery({ eventType: "billing.nothing_writes_this" }),
    ).toEqual(NONE);
  });

  it("drops an outcome the column cannot hold (negative)", () => {
    expect(parseAuditQuery({ outcome: "maybe" })).toEqual(NONE);
  });

  it("drops an actor that is not a user public id (negative)", () => {
    for (const actor of ["7c9e6679-7425-40de-944b-e07fc1f90ae7", "usr_", "x"])
      expect(parseAuditQuery({ actor }).actor).toBeNull();
  });

  it("drops a capability name no registry could hold (negative)", () => {
    for (const capability of [
      "Query Audit Log",
      "'; drop table",
      "a".repeat(80),
    ])
      expect(parseAuditQuery({ capability }).capability).toBeNull();
  });

  it("drops a day-shaped value no calendar holds (negative)", () => {
    // Both match the shape: 99 is no month and no day, and 31 February would
    // normalize into March and silently query a period nobody asked for.
    for (const day of ["2026-99-99", "2026-02-31", "2026-13-01", "2026-00-10"])
      expect(parseAuditQuery({ from: day, to: day })).toEqual(NONE);
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
    expect(parseAuditQuery({ offset: "17" }).offset).toBe(10);
    expect(parseAuditQuery({ offset: "70", rows: "50" }).offset).toBe(50);
    expect(parseAuditQuery({ offset: "100.7", rows: "25" }).offset).toBe(100);
  });

  it("bounds an offset past the end of the record (negative)", () => {
    // Finite and positive, so the old check passed it through to PostgreSQL's
    // bigint OFFSET, which failed the conversion and answered a 500.
    for (const offset of ["100000000000000000000", "1e21", "9007199254740993"])
      expect(parseAuditQuery({ offset }).offset).toBe(1_000_000);
  });

  it("reads the first value when a parameter arrives repeated", () => {
    expect(parseAuditQuery({ outcome: ["deny", "allow"] }).outcome).toBe(
      "deny",
    );
  });
});

describe("hasAuditFilters", () => {
  it("is false for the newest page and true for a filter that narrows past the window", () => {
    expect(hasAuditFilters(NONE)).toBe(false);
    expect(hasAuditFilters({ ...NONE, offset: 100, rows: 50 })).toBe(false);
    expect(hasAuditFilters({ ...NONE, range: "48h" })).toBe(false);
    expect(hasAuditFilters({ ...NONE, outcome: "deny" })).toBe(true);
    expect(hasAuditFilters({ ...NONE, actor: "usr_7k2m" })).toBe(true);
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
      range: undefined,
      from: undefined,
      to: undefined,
      rows: undefined,
      offset: undefined,
      format: undefined,
    });
  });

  it("carries a Range and Rows other than the defaults", () => {
    expect(auditQueryParams({ ...NONE, range: "48h", rows: 25 })).toMatchObject(
      { range: "48h", rows: "25" },
    );
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

describe("auditWindow", () => {
  /** The filters alone: the window is built from these, never from the offset. */
  const NO_DAYS: AuditFilters = {
    eventType: null,
    outcome: null,
    actor: null,
    capability: null,
    range: "30d",
    from: null,
    to: null,
  };
  /** The instant the page read at; a Range window ends here. */
  const NOW = Date.parse("2026-09-16T12:00:00.000Z");

  const ctx = unsafeMint(OrgCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole: "owner",
  });

  const sourceWith = (
    preferences: DataSource["shell"]["preferences"],
  ): Pick<DataSource, "shell"> => ({
    shell: {
      context: () => Promise.reject(new Error("not a window read")),
      preferences,
      counts: () => Promise.reject(new Error("not a window read")),
      notifications: () => Promise.reject(new Error("not a window read")),
      assistantEngine: () => Promise.reject(new Error("not a window read")),
    },
  });

  const zoned = (timeZone: string) =>
    vi.fn<DataSource["shell"]["preferences"]>(() =>
      Promise.resolve(readOk({ timeZone, enterToSubmit: false })),
    );

  it("resolves the days in the viewer's zone, the last day inclusive", async () => {
    const preferences = zoned("Asia/Tokyo");
    expect(
      await auditWindow(
        ctx,
        sourceWith(preferences),
        {
          ...NO_DAYS,
          from: "2026-09-18",
          to: "2026-09-18",
        },
        NOW,
      ),
    ).toMatchObject({
      // JST is UTC+9, so a Tokyo day starts at 15:00 UTC the day before.
      since: "2026-09-17T15:00:00.000Z",
      until: "2026-09-18T15:00:00.000Z",
    });
  });

  it("carries the filters the days are not, and one bound on its own", async () => {
    expect(
      await auditWindow(
        ctx,
        sourceWith(zoned("UTC")),
        {
          ...NO_DAYS,
          outcome: "deny",
          capability: "query_audit_log",
          from: "2026-09-18",
        },
        NOW,
      ),
    ).toEqual({
      eventType: null,
      outcome: "deny",
      actor: null,
      capability: "query_audit_log",
      since: "2026-09-18T00:00:00.000Z",
      until: null,
    });
  });

  it("reads the Range back from now, open at the top, and no zone, when neither day is set", async () => {
    const preferences = zoned("Asia/Tokyo");
    expect(
      await auditWindow(ctx, sourceWith(preferences), NO_DAYS, NOW),
    ).toMatchObject({ since: "2026-08-17T12:00:00.000Z", until: null });
    expect(
      await auditWindow(
        ctx,
        sourceWith(preferences),
        { ...NO_DAYS, range: "48h" },
        NOW,
      ),
    ).toMatchObject({ since: "2026-09-14T12:00:00.000Z", until: null });
    expect(
      await auditWindow(
        ctx,
        sourceWith(preferences),
        { ...NO_DAYS, range: "7d" },
        NOW,
      ),
    ).toMatchObject({ since: "2026-09-09T12:00:00.000Z" });
    expect(preferences).not.toHaveBeenCalled();
  });

  it("falls back to the default zone when the preference cannot be read (negative)", async () => {
    const preferences = vi.fn<DataSource["shell"]["preferences"]>(() =>
      Promise.resolve(readError("control_plane_unavailable", 503)),
    );
    expect(
      await auditWindow(
        ctx,
        sourceWith(preferences),
        {
          ...NO_DAYS,
          from: "2026-09-18",
        },
        NOW,
      ),
      // Pacific is the default the pages print in: PDT, UTC-7 in September.
    ).toMatchObject({ since: "2026-09-18T07:00:00.000Z" });
  });

  it("falls back to the default zone for one this runtime cannot format in (negative)", async () => {
    expect(
      await auditWindow(
        ctx,
        sourceWith(zoned("Mars/Olympus_Mons")),
        {
          ...NO_DAYS,
          from: "2026-09-18",
        },
        NOW,
      ),
    ).toMatchObject({ since: "2026-09-18T07:00:00.000Z" });
  });
});
