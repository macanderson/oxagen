// The audit export route handler: who it answers a file to, who it refuses,
// and what the file carries. The export reads through the audit port alone, so
// the test hands it a fake DataSource and asserts the call it makes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "@/data/ports";
import type { AuditExportDeps } from "./export";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { handleAuditExport } = await import("./export");

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

const file = {
  format: "csv" as const,
  body: "id,occurred_at\r\nevt_1,2026-09-15T10:00:00.000Z\r\n",
  signature: "a".repeat(64),
  algorithm: "HMAC-SHA256" as const,
  rowCount: 1,
};

const refuse = () => Promise.reject(new Error("not the audit export read"));
const exportEvents = vi.fn();
const preferences = vi.fn<DataSource["shell"]["preferences"]>();
const resolveViewer = vi.fn();
const source: DataSource = {
  runtimes: { list: refuse, agents: refuse },
  pretenant: { orgs: refuse, workspaces: refuse },
  shell: {
    context: refuse,
    preferences,
    counts: refuse,
    notifications: refuse,
  },
  runs: {
    list: refuse,
    get: refuse,
    frameBody: refuse,
    cost: refuse,
    transcript: refuse,
    chain: refuse,
    outputs: refuse,
    work: refuse,
    outcomesSettings: refuse,
  },
  approvals: { pending: refuse, resolved: refuse, resolvedSince: refuse },
  agents: { list: refuse, get: refuse, toolbelt: refuse, incidents: refuse },
  billing: {
    plan: refuse,
    usageCredits: refuse,
    retention: refuse,
    bucket: refuse,
    contractRate: refuse,
    invoices: refuse,
  },
  spend: {
    byGroup: refuse,
    fleet: refuse,
    drill: refuse,
    waste: refuse,
    gatewayPolicy: refuse,
    budgets: refuse,
    findings: refuse,
    findingEvidence: refuse,
    priceBook: refuse,
    unpricedModels: refuse,
  },
  org: {
    members: refuse,
    roles: refuse,
    workspaces: refuse,
    apiKeys: refuse,
    costCenters: refuse,
    modelCredential: refuse,
    dataPlane: refuse,
    workspaceFacts: refuse,
    sso: refuse,
  },
  audit: { events: refuse, exportEvents, retention: refuse, bundle: refuse },
  onboarding: { state: refuse, firstFrame: refuse },
  skills: { inventory: refuse, configuration: refuse },
  mandates: { list: refuse, get: refuse },
  steering: {
    records: refuse,
    record: refuse,
    proposals: refuse,
    contextPr: refuse,
    freshness: refuse,
    hub: refuse,
    deliveries: refuse,
    memories: refuse,
    tree: refuse,
  },
  tools: {
    versions: refuse,
    grants: refuse,
    killSwitches: refuse,
    approvalRules: refuse,
    connections: refuse,
    mcpServers: refuse,
  },
};
const deps: AuditExportDeps = { resolveViewer, dataSource: () => source };

const request = (search = "") =>
  new Request(`http://mission-control.test/acme/audit/export${search}`);
const context = { params: Promise.resolve({ org: "acme" }) };

beforeEach(() => {
  exportEvents.mockReset();
  preferences.mockReset();
  preferences.mockResolvedValue(readOk({ timeZone: "America/Los_Angeles" }));
  resolveViewer.mockReset();
  resolveViewer.mockResolvedValue({ kind: "ok", ctx });
  exportEvents.mockResolvedValue(readOk(file));
});

describe("handleAuditExport", () => {
  it("answers the signed file with its signature, algorithm and row count in the headers", async () => {
    const res = await handleAuditExport(request("?format=csv"), context, deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(file.body);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="audit-events.csv"',
    );
    expect(res.headers.get("X-Audit-Export-Signature")).toBe(file.signature);
    expect(res.headers.get("X-Audit-Export-Signature-Algorithm")).toBe(
      "HMAC-SHA256",
    );
    expect(res.headers.get("X-Audit-Export-Row-Count")).toBe("1");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("exports the rows the page is showing: the same filters, and no offset", async () => {
    await handleAuditExport(
      request(
        "?format=ndjson&outcome=deny&capability=query_audit_log&from=2026-09-01&to=2026-09-15&offset=100&actor=usr_7k2m9q4x8r1t5v3w",
      ),
      context,
      deps,
    );
    // The same window the page reads: the reader's days as instants in their
    // zone (PDT, UTC-7 in September), inclusive of the last day.
    expect(exportEvents).toHaveBeenCalledWith(ctx, {
      format: "ndjson",
      eventType: null,
      outcome: "deny",
      actor: "usr_7k2m9q4x8r1t5v3w",
      capability: "query_audit_log",
      since: "2026-09-01T07:00:00.000Z",
      until: "2026-09-16T07:00:00.000Z",
    });
  });

  it("exports the page's Range window, ending now, without reading a zone when no day is filtered", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-09-16T12:00:00.000Z"),
    );
    await handleAuditExport(request("?outcome=deny"), context, deps);
    expect(exportEvents).toHaveBeenCalledWith(ctx, {
      format: "csv",
      eventType: null,
      outcome: "deny",
      actor: null,
      capability: null,
      since: "2026-08-17T12:00:00.000Z",
      until: null,
    });
    await handleAuditExport(request("?range=48h"), context, deps);
    expect(exportEvents).toHaveBeenLastCalledWith(
      ctx,
      expect.objectContaining({ since: "2026-09-14T12:00:00.000Z" }),
    );
    expect(preferences).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("exports CSV when the request names no format the contract knows (negative)", async () => {
    await handleAuditExport(request("?format=pdf"), context, deps);
    expect(exportEvents).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ format: "csv" }),
    );
  });

  it("answers 404 for a non-member and reads nothing (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "not_found" });
    const res = await handleAuditExport(request(), context, deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "not_found" });
    expect(exportEvents).not.toHaveBeenCalled();
  });

  it("answers 401 for a signed-out request (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "unauthenticated" });
    const res = await handleAuditExport(request(), context, deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "unauthenticated" });
    expect(exportEvents).not.toHaveBeenCalled();
  });

  it("answers 403 for a member whose MFA enrollment is overdue (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "mfa_enroll" });
    const res = await handleAuditExport(request(), context, deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "mfa_required" });
  });

  it("answers 403 for a member whose organization requires SSO and whose session is not one (negative)", async () => {
    resolveViewer.mockResolvedValue({ kind: "sso_required" });
    const res = await handleAuditExport(request(), context, deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "sso_required" });
    expect(exportEvents).not.toHaveBeenCalled();
  });

  it("sends a historical slug to the canonical export with the filters intact", async () => {
    resolveViewer.mockResolvedValue({
      kind: "redirect",
      org: "acme-robotics",
      ws: null,
    });
    const res = await handleAuditExport(
      request("?outcome=deny&format=ndjson"),
      context,
      deps,
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe(
      "http://mission-control.test/acme-robotics/audit/export?outcome=deny&format=ndjson",
    );
    expect(exportEvents).not.toHaveBeenCalled();
  });

  it("refuses a reader the handler denied, and writes no file (negative)", async () => {
    exportEvents.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "org.admin",
    });
    const res = await handleAuditExport(request(), context, deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "denied" });
  });

  it("refuses while an access request is pending (negative)", async () => {
    exportEvents.mockResolvedValue({
      ok: false,
      reason: "pending_approval",
      accessRequestId: "acr_1",
    });
    const res = await handleAuditExport(request(), context, deps);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "pending_approval" });
  });

  it("answers the read's own status when the record could not be read, rather than a short file (negative)", async () => {
    exportEvents.mockResolvedValue(readError("audit_store_unavailable", 503));
    const res = await handleAuditExport(request(), context, deps);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "audit_store_unavailable" });
  });
});
