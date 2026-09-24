// The audit port: one kernel read of query_audit_log for a page of the record,
// one of export_audit_events for the signed file over the same window, one of
// get_evidence_retention and one of get_export_status; an unset filter left
// out, a refusal passed through, and an unmappable answer reported once. The day bounds arrive resolved — which instants a civil day
// spans is the viewer's zone's business, and this layer has no viewer — so the
// zone lives in features/audit/filters.ts (auditWindow) and is tested there.
import { auditEventsExport } from "@oxagen/oxagen/contracts/audit.events.export";
import { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import { privacyDataExportStatus } from "@oxagen/oxagen/contracts/privacy.data.export.status";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Only the part of a kernelRead call this test reads back off the mock. */
type KernelCall = { input: Record<string, unknown> };

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn<(ctx: unknown, call: KernelCall) => Promise<unknown>>(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { audit } = await import("./audit");

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

const NO_FILTERS = {
  eventType: null,
  outcome: null,
  actor: null,
  capability: null,
  since: null,
  until: null,
};

const event = {
  id: "0b6f0a2e-4a3b-4a8c-9f1d-2c3b4a5d6e7f",
  source: "security",
  eventType: "capability.invoke_denied",
  occurredAt: "2026-09-15T10:04:31.221Z",
  actorUserId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  actorPublicId: "usr_7k2m9q4x8r1t5v3w6y0z2a",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  workspaceSlug: "core-platform",
  capability: "purchase_gau_bucket",
  outcome: "deny",
  ip: "203.0.113.7",
  userAgent: "oxagen-cli/1.4.0",
  requestId: "req_01K5ABCDE",
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("audit.events", () => {
  it("reads one page of the whole organization's security events at the size the page asks for", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        events: [event],
        total: 1,
        hasMore: false,
        limit: 50,
        offset: 0,
      }),
    );
    const read = await audit.events(ctx, {
      ...NO_FILTERS,
      offset: 0,
      limit: 50,
    });
    expect(read.ok && read.value.events).toHaveLength(1);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: auditLogQuery,
      input: { source: "security", limit: 50, offset: 0 },
      page: "audit",
    });
  });

  it("sends each filter the reader set, and the window as the contract's from and to", async () => {
    kernelRead.mockResolvedValue(
      readOk({ events: [], total: 0, hasMore: false, limit: 50, offset: 50 }),
    );
    await audit.events(ctx, {
      eventType: "capability.invoke_denied",
      outcome: "deny",
      actor: "usr_7k2m9q4x8r1t5v3w6y0z2a",
      capability: "purchase_gau_bucket",
      since: "2026-09-01T00:00:00.000Z",
      until: "2026-09-16T00:00:00.000Z",
      offset: 50,
      limit: 50,
    });
    expect(kernelRead.mock.calls[0]?.[1]?.input).toEqual({
      source: "security",
      eventType: "capability.invoke_denied",
      outcome: "deny",
      actorPublicId: "usr_7k2m9q4x8r1t5v3w6y0z2a",
      capability: "purchase_gau_bucket",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-16T00:00:00.000Z",
      limit: 50,
      offset: 50,
    });
  });

  it("carries one bound on its own, leaving the other out (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({ events: [], total: 0, hasMore: false, limit: 50, offset: 0 }),
    );
    await audit.events(ctx, {
      ...NO_FILTERS,
      until: "2027-01-01T00:00:00.000Z",
      offset: 0,
      limit: 50,
    });
    expect(kernelRead.mock.calls[0]?.[1]?.input).toEqual({
      source: "security",
      to: "2027-01-01T00:00:00.000Z",
      limit: 50,
      offset: 0,
    });
  });

  it("passes a refusal through as the kernel classified it (negative)", async () => {
    const denied = {
      ok: false,
      reason: "denied",
      permission: "org.admin",
    } as const;
    kernelRead.mockResolvedValue(denied);
    expect(
      await audit.events(ctx, { ...NO_FILTERS, offset: 0, limit: 50 }),
    ).toEqual(denied);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("reports an answer the view model refuses once, and returns record_unmappable (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        events: [{ ...event, occurredAt: "the other day" }],
        total: 1,
        hasMore: false,
        limit: 50,
        offset: 0,
      }),
    );
    expect(
      await audit.events(ctx, { ...NO_FILTERS, offset: 0, limit: 50 }),
    ).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledOnce();
    expect(captureError.mock.calls[0]?.[0]).toMatchObject({
      source: "app",
      orgId: ctx.orgId,
      context: "audit.events record_unmappable",
    });
  });
});

describe("audit.exportEvents", () => {
  it("asks for the signed file over the filters the page is showing", async () => {
    const file = {
      format: "csv",
      body: "id\r\n",
      signature: "c".repeat(64),
      algorithm: "HMAC-SHA256",
      rowCount: 0,
    };
    kernelRead.mockResolvedValue(readOk(file));
    expect(
      await audit.exportEvents(ctx, {
        ...NO_FILTERS,
        outcome: "deny",
        format: "csv",
      }),
    ).toEqual(readOk(file));
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: auditEventsExport,
      input: { format: "csv", outcome: "deny" },
      page: "audit",
    });
  });

  it("reports a file the view model refuses and signs nothing (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        format: "csv",
        body: "id\r\n",
        signature: "not-a-signature",
        algorithm: "HMAC-SHA256",
        rowCount: 0,
      }),
    );
    expect(
      await audit.exportEvents(ctx, { ...NO_FILTERS, format: "csv" }),
    ).toEqual(readError("record_unmappable", 502));
    expect(captureError).toHaveBeenCalledOnce();
    expect(captureError.mock.calls[0]?.[0]).toMatchObject({
      context: "audit.exportEvents record_unmappable",
    });
  });
});

describe("audit.retention", () => {
  const posture = {
    includedMonths: 12,
    effectiveRetentionDays: 2555,
    extendedRetentionEnabled: true,
    usdPerGbMonth: 0.023,
    storedGbBeyondIncluded: 41,
    storedGbMeasured: true,
    creditsChargedThisPeriod: 0,
  };

  it("reads the pinned body retention and the measured volume at its rate as money", async () => {
    kernelRead.mockResolvedValue(readOk(posture));
    expect(await audit.retention(ctx)).toEqual(
      readOk({
        includedMonths: 12,
        bodyRetentionDays: 2555,
        rate: { micros: "23000", currency: "USD" },
        storedGbBeyondIncluded: 41,
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: billingEvidenceRetention,
      input: {},
      page: "audit",
    });
  });

  it("leaves a volume the accounting job has not measured, and a rate it cannot parse, as null (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        ...posture,
        effectiveRetentionDays: null,
        usdPerGbMonth: 1e-7,
        storedGbBeyondIncluded: 0,
        storedGbMeasured: false,
      }),
    );
    expect(await audit.retention(ctx)).toEqual(
      readOk({
        includedMonths: 12,
        bodyRetentionDays: null,
        rate: null,
        storedGbBeyondIncluded: null,
      }),
    );
  });
});

describe("audit.bundle", () => {
  const id = "3f1c2b7a-9d4e-4c1b-8a2f-5e6d7c8b9a01";

  it("reads one queued export back by its id", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        exportId: id,
        status: "ready",
        ready: true,
        storageKey: "exports/org/archive.zip",
        completedAt: "2026-09-16T11:58:00.000Z",
      }),
    );
    expect(await audit.bundle(ctx, id)).toEqual(
      readOk({
        exportRef: id,
        status: "ready",
        ready: true,
        completedAt: "2026-09-16T11:58:00.000Z",
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: privacyDataExportStatus,
      input: { exportId: id },
      page: "audit",
    });
  });

  it("reports an export id that is not a uuid as record_unmappable (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        exportId: "exp_1",
        status: "queued",
        ready: false,
        storageKey: null,
        completedAt: null,
      }),
    );
    expect(await audit.bundle(ctx, id)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError.mock.calls[0]?.[0]).toMatchObject({
      context: "audit.bundle record_unmappable",
    });
  });
});
