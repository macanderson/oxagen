import { describe, expect, it } from "vitest";
import { auditLogQuery } from "./audit.log.query";
import { getCapability } from "../registry";

describe("audit.log.query capability", () => {
  // ── registration / metadata ───────────────────────────────────────────────

  it("is registered under its name with the audit domain", () => {
    const cap = getCapability("query_audit_log");
    expect(cap).toBeDefined();
    expect(auditLogQuery.domain).toBe("audit");
    expect(auditLogQuery.mode).toBe("sync");
  });

  it("is read-only, org-scoped, deny-by-default and admin-gated", () => {
    expect(auditLogQuery.scoped).toBe(true);
    expect(auditLogQuery.defaultEffect).toBe("deny");
    expect(auditLogQuery.sensitivity).toBe("high");
    expect(auditLogQuery.agent.category).toBe("read");
    expect(auditLogQuery.agent.requiresApproval).toBe(false);
    expect(auditLogQuery.defaultRoles.org).toMatchObject({
      Owner: "allow",
      Admin: "allow",
    });
  });

  it("exposes api, mcp, agent and cli surfaces", () => {
    expect(auditLogQuery.surfaces).toEqual(
      expect.arrayContaining(["api", "mcp", "agent", "cli"]),
    );
  });

  // ── input: defaults & bounds ──────────────────────────────────────────────

  it("defaults source=all, limit=50, offset=0 on empty input", () => {
    const parsed = auditLogQuery.input.parse({});
    expect(parsed.source).toBe("all");
    expect(parsed.limit).toBe(50);
    expect(parsed.offset).toBe(0);
  });

  it("accepts each valid source", () => {
    for (const source of ["all", "security", "playbook"] as const) {
      expect(auditLogQuery.input.parse({ source }).source).toBe(source);
    }
  });

  it("rejects an unknown source", () => {
    expect(() => auditLogQuery.input.parse({ source: "everything" })).toThrow();
  });

  it("enforces limit bounds (1–200)", () => {
    expect(() => auditLogQuery.input.parse({ limit: 0 })).toThrow();
    expect(() => auditLogQuery.input.parse({ limit: 201 })).toThrow();
    expect(auditLogQuery.input.parse({ limit: 200 }).limit).toBe(200);
  });

  it("rejects a negative offset", () => {
    expect(() => auditLogQuery.input.parse({ offset: -1 })).toThrow();
  });

  it("only accepts known security outcomes", () => {
    expect(auditLogQuery.input.parse({ outcome: "deny" }).outcome).toBe("deny");
    expect(() => auditLogQuery.input.parse({ outcome: "maybe" })).toThrow();
  });

  it("rejects a non-ISO 'from' timestamp", () => {
    expect(() => auditLogQuery.input.parse({ from: "last tuesday" })).toThrow();
    expect(
      auditLogQuery.input.parse({ from: "2024-01-01T00:00:00Z" }).from,
    ).toBe("2024-01-01T00:00:00Z");
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with a mixed event feed", () => {
    const parsed = auditLogQuery.output.parse({
      events: [
        {
          source: "security",
          eventType: "capability.invoked",
          occurredAt: "2024-01-03T18:42:10.000Z",
          actorUserId: "u_1",
          workspaceId: "ws_1",
          capability: "start_subscription_upgrade",
          outcome: "success",
          requestId: "req_1",
          playbookRunId: null,
          sequence: null,
          eventData: null,
        },
        {
          source: "playbook",
          eventType: "run_completed",
          occurredAt: "2024-01-05T00:00:00.000Z",
          actorUserId: null,
          workspaceId: "ws_1",
          capability: null,
          outcome: null,
          requestId: null,
          playbookRunId: "run_1",
          sequence: 7,
          eventData: { ok: true },
        },
      ],
      total: 2,
      hasMore: false,
      limit: 50,
      offset: 0,
    });
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[1]?.sequence).toBe(7);
  });

  it("rejects an event with an unknown source", () => {
    expect(() =>
      auditLogQuery.output.parse({
        events: [
          {
            source: "weird",
            eventType: "x",
            occurredAt: "2024-01-01T00:00:00.000Z",
          },
        ],
        total: 1,
        hasMore: false,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
  });
});
