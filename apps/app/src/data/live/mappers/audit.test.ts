// The Audit mappers over real contract output: each sample is parsed by the
// contract's own output schema first, so a sample the contract would reject
// cannot make a mapper test pass, and the view model parse is the boundary the
// adapter runs (ARCHITECTURE.md §3.4).
import { auditEventsExport } from "@oxagen/oxagen/contracts/audit.events.export";
import { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import { describe, expect, it } from "vitest";
import { AuditExport, AuditPage } from "@/data/contracts/audit";
import { toAuditExport, toAuditPage } from "./audit";

const denied = {
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

/** An event the platform recorded with no actor, workspace, capability or client. */
const machine = {
  id: "1c7f1b3f-5b4c-4b9d-8e2e-3d4c5b6e7f80",
  source: "security",
  eventType: "auth.session_expired",
  occurredAt: "2026-09-15T09:00:00.000Z",
  actorUserId: null,
  actorPublicId: null,
  workspaceId: null,
  workspaceSlug: null,
  capability: null,
  outcome: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

function page(sample: unknown) {
  return auditLogQuery.output.parse(sample);
}

describe("toAuditPage", () => {
  it("carries every event, the actor as a public id and the workspace as its slug", () => {
    const view = AuditPage.parse(
      toAuditPage(
        page({
          events: [denied],
          total: 1,
          hasMore: true,
          limit: 50,
          offset: 0,
        }),
      ),
    );
    expect(view).toEqual({
      events: [
        {
          occurredAt: denied.occurredAt,
          eventType: "capability.invoke_denied",
          actor: "usr_7k2m9q4x8r1t5v3w6y0z2a",
          capability: "purchase_gau_bucket",
          outcome: "deny",
          workspace: "core-platform",
          ip: "203.0.113.7",
          userAgent: "oxagen-cli/1.4.0",
          request: "req_01K5ABCDE",
          detail: null,
        },
      ],
      hasMore: true,
      offset: 0,
      limit: 50,
    });
  });

  it("retains invalidation facts through the contract and view-model parse", () => {
    const detail = {
      ruleId: "rule_123",
      reason: "tool_version_changed",
      before: { tool: "v1" },
      after: { tool: "v2" },
    };
    const view = AuditPage.parse(
      toAuditPage(
        page({
          events: [
            { ...denied, eventType: "approval_rule.invalidated", detail },
          ],
          total: 1,
          hasMore: false,
          limit: 50,
          offset: 0,
        }),
      ),
    );
    expect(view.events[0]?.detail).toEqual(detail);
  });

  it("carries no database id onto the page (INV-11)", () => {
    const view = toAuditPage(
      page({
        events: [denied],
        total: 1,
        hasMore: false,
        limit: 50,
        offset: 0,
      }),
    );
    expect(JSON.stringify(view)).not.toContain(denied.id);
    expect(JSON.stringify(view)).not.toContain(denied.actorUserId);
    expect(JSON.stringify(view)).not.toContain(denied.workspaceId);
  });

  it("keeps a field the record did not fill null rather than filling it", () => {
    const view = AuditPage.parse(
      toAuditPage(
        page({
          events: [machine],
          total: 1,
          hasMore: false,
          limit: 50,
          offset: 50,
        }),
      ),
    );
    expect(view.events[0]).toMatchObject({
      actor: null,
      capability: null,
      outcome: null,
      workspace: null,
      ip: null,
      userAgent: null,
      request: null,
      detail: null,
    });
    expect(view.offset).toBe(50);
  });

  it("carries the last page as the last page", () => {
    const view = AuditPage.parse(
      toAuditPage(
        page({ events: [], total: 0, hasMore: false, limit: 50, offset: 0 }),
      ),
    );
    expect(view).toEqual({ events: [], hasMore: false, offset: 0, limit: 50 });
  });
});

describe("toAuditExport", () => {
  it("carries the file, its signature and the rows it holds", () => {
    const out = auditEventsExport.output.parse({
      format: "ndjson",
      body: '{"id":"evt"}\n',
      signature: "b".repeat(64),
      algorithm: "HMAC-SHA256",
      rowCount: 1,
    });
    expect(AuditExport.parse(toAuditExport(out))).toEqual({
      format: "ndjson",
      body: '{"id":"evt"}\n',
      signature: "b".repeat(64),
      algorithm: "HMAC-SHA256",
      rowCount: 1,
    });
  });
});
