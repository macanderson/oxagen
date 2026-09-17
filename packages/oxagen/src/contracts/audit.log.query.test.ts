import { describe, expect, it } from "vitest";
import {
  auditLogQuery,
  ORG_ONLY_WORKSPACE_ID as fromContract,
} from "./audit.log.query";
import { getCapability } from "../registry";
import { ORG_ONLY_WORKSPACE_ID as fromTypes } from "../types";

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

  it("is never a governed action: reading the record declares noBillingGate", () => {
    expect(auditLogQuery.noBillingGate).toBe(true);
  });

  it("accepts the actor's public id as a filter", () => {
    expect(
      auditLogQuery.input.parse({ actorPublicId: "usr_7k2m9q4x8r1t5v3w6y0z2a" })
        .actorPublicId,
    ).toBe("usr_7k2m9q4x8r1t5v3w6y0z2a");
  });

  it("refuses an event missing the id, ip and user agent keys", () => {
    expect(() =>
      auditLogQuery.output.parse({
        events: [
          {
            source: "security",
            eventType: "auth.sign_in",
            occurredAt: "2024-01-01T00:00:00.000Z",
            actorUserId: null,
            actorPublicId: null,
            workspaceId: null,
            workspaceSlug: null,
            capability: null,
            outcome: "success",
            requestId: null,
          },
        ],
        total: 1,
        hasMore: false,
        limit: 50,
        offset: 0,
      }),
    ).toThrow();
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
    for (const source of ["all", "security"] as const) {
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

  it("parses a valid output with a security event feed", () => {
    const parsed = auditLogQuery.output.parse({
      events: [
        {
          id: "0192d4a8-7c1e-7a00-8000-000000000e01",
          source: "security",
          eventType: "capability.invoke_allowed",
          occurredAt: "2024-01-03T18:42:10.000Z",
          actorUserId: "u_1",
          actorPublicId: "usr_7k2m9q4x8r1t5v3w6y0z2a",
          workspaceId: "ws_1",
          workspaceSlug: "core-platform",
          capability: "start_subscription_upgrade",
          outcome: "success",
          ip: "203.0.113.7",
          userAgent: "oxagen-cli/3.0",
          requestId: "req_1",
        },
      ],
      total: 1,
      hasMore: false,
      limit: 50,
      offset: 0,
    });
    expect(parsed.events).toHaveLength(1);
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

  // ── the org-only sentinel ────────────────────────────────────────────────

  it("re-exports the one sentinel rather than declaring a second literal", () => {
    // This file used to carry its own `ORG_ONLY_WORKSPACE_ID`, while ADR-068
    // decision 1 names `packages/oxagen/src/types.ts` as "the one definition".
    // `auditLogQueryHandler` compares against the value reached from here and
    // `audit.events.export`'s route injects it, so two literals were two
    // constants that had to stay equal by hand. Identity, not equality: a
    // re-export is the same binding, a copied literal only ever looks like one.
    expect(fromContract).toBe(fromTypes);
  });
});
