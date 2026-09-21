/**
 * query_audit_log handler tests.
 *
 * The org is tier-free in every case: the kernel's IAM check allows every
 * capability there, so each refusal below comes from the handler's own role
 * gate, which runs for real against a withTenantDb double that answers the
 * principal and role tables (test-utils/role-tx.ts). The events read runs
 * against a withSystemDb double that records the WHERE clause, the page
 * bounds and returns stored rows, so a test asserts which feed a caller was
 * given, not the shape of a canned reply.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withSystemDb: mocks.withSystemDb,
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

import { isHandlerError } from "@oxagen/oxagen";
import { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import { schema } from "@oxagen/database";
import { and, eq, gte, lt, type SQL } from "drizzle-orm";
import { auditLogQueryHandler } from "./audit.log.query";
import { ORG_ONLY_WS } from "./audit.shared";
import { makeCTX } from "./test-utils/fixtures";
import { type RoleFixture, roleTenantDb } from "./test-utils/role-tx";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000a0d1";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const OWN_WS = "0192d4a8-7c1e-7a00-8000-00000000c0e1";
const OTHER_WS = "0192d4a8-7c1e-7a00-8000-00000000c0e2";
const KEY = "0192d4a8-7c1e-7a00-8000-0000000a91e1";
const KEY_CREATOR = "0192d4a8-7c1e-7a00-8000-0000000c7ea7";

/** An organization-level call: the app's org pages carry the sentinel workspace. */
const orgCall = () =>
  makeCTX({ orgId: ORG, userId: USER, workspaceId: ORG_ONLY_WS });
/** A call scoped to one workspace: an API key or a workspace page. */
const wsCall = () => makeCTX({ orgId: ORG, userId: USER, workspaceId: OWN_WS });

const input = (
  over: Partial<Parameters<typeof auditLogQuery.input.parse>[0]> = {},
) => auditLogQuery.input.parse(over);

const read = {
  select: [] as Record<string, unknown>[],
  where: [] as SQL[],
  limit: [] as number[],
  offset: [] as number[],
};
let stored: Record<string, unknown>[] = [];

function eventsTx() {
  return {
    select: (fields: Record<string, unknown>) => {
      read.select.push(fields);
      const chain = {
        from: () => chain,
        leftJoin: () => chain,
        where: (cond: SQL) => {
          read.where.push(cond);
          return chain;
        },
        orderBy: () => chain,
        limit: (n: number) => {
          read.limit.push(n);
          return chain;
        },
        offset: (n: number) => {
          read.offset.push(n);
          return Promise.resolve(stored.slice(n, n + (read.limit.at(-1) ?? 0)));
        },
      };
      return chain;
    },
  };
}

function roles(fixture: RoleFixture) {
  mocks.withTenantDb.mockImplementation(roleTenantDb(fixture));
}

function row(n: number, over: Record<string, unknown> = {}) {
  const occurredAt = new Date(Date.UTC(2026, 8, 15, 12, 0, 60 - n));
  return {
    id: `0192d4a8-7c1e-7a00-8000-${String(n).padStart(12, "0")}`,
    at: `${occurredAt.toISOString().replace("T", " ").replace("Z", "")}123+00`,
    occurredAt,
    eventType: "capability.invoke_denied",
    actorUserId: USER,
    actorPublicId: "usr_7k2m9q4x8r1t5v3w6y0z2a",
    workspaceId: OWN_WS,
    workspaceSlug: "core-platform",
    capability: "set_spend_budget",
    outcome: "deny",
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    requestId: `req_${n}`,
    ...over,
  };
}

const orgIs = eq(schema.securityEvents.orgId, ORG);
const workspaceIs = (id: string) => eq(schema.securityEvents.workspaceId, id);

async function refusal(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isHandlerError(err)).toBe(true);
  return err as { code: string; reason: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  read.select = [];
  read.where = [];
  read.limit = [];
  read.offset = [];
  stored = [];
  mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(eventsTx())),
  );
});

describe("query_audit_log from the organization (the org-only sentinel)", () => {
  it("gives an org Owner the whole organization's feed with every recorded field", async () => {
    roles({ org: "Owner" });
    stored = [
      row(1),
      row(2, { ip: null, userAgent: null, actorPublicId: null }),
    ];

    const out = await auditLogQueryHandler(input(), orgCall());

    expect(read.where).toEqual([and(orgIs)]);
    expect(out.events).toEqual([
      {
        id: row(1).id,
        source: "security",
        eventType: "capability.invoke_denied",
        occurredAt: row(1).occurredAt.toISOString(),
        actorUserId: USER,
        actorPublicId: "usr_7k2m9q4x8r1t5v3w6y0z2a",
        workspaceId: OWN_WS,
        workspaceSlug: "core-platform",
        capability: "set_spend_budget",
        outcome: "deny",
        ip: "203.0.113.7",
        userAgent: "Mozilla/5.0",
        requestId: "req_1",
        detail: null,
      },
      expect.objectContaining({
        ip: null,
        userAgent: null,
        actorPublicId: null,
      }),
    ]);
    expect(out).toMatchObject({
      total: 2,
      hasMore: false,
      limit: 50,
      offset: 0,
    });
  });

  it("returns stored invalidation evidence and accepts legacy events without detail", async () => {
    roles({ org: "Owner" });
    const detail = {
      ruleId: "rule_1",
      tool: "publish_release",
      reason: "classification_changed",
      before: {
        consequenceTags: ["read"],
        measures: null,
        classification: "read",
      },
      after: {
        consequenceTags: ["write"],
        measures: null,
        classification: "write",
      },
    };
    stored = [
      row(1, { eventType: "approval_rule.invalidated", detail }),
      row(2),
    ];
    const out = await auditLogQueryHandler(input(), orgCall());
    expect(read.select[0]).toHaveProperty(
      "detail",
      schema.securityEvents.detail,
    );
    expect(read.where).toEqual([and(orgIs)]);
    expect(out.events[0]?.detail).toEqual(detail);
    expect(out.events[1]?.detail).toBeNull();
    expect(auditLogQuery.output.parse(out)).toEqual(out);
    const legacy = {
      ...out,
      events: out.events.map(({ detail: _detail, ...event }) => event),
    };
    expect(auditLogQuery.output.parse(legacy)).toEqual(legacy);
  });

  it("gives an org Admin the whole organization's feed", async () => {
    roles({ org: "Admin" });
    await auditLogQueryHandler(input(), orgCall());
    expect(read.where).toEqual([and(orgIs)]);
  });

  it("refuses a Member as forbidden instead of an empty page filtered on the sentinel", async () => {
    roles({ org: "Member" });
    const err = await refusal(auditLogQueryHandler(input(), orgCall()));
    expect(err.code).toBe("forbidden");
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("refuses a Member naming a workspace", async () => {
    roles({ org: "Member", workspace: "Owner" });
    const err = await refusal(
      auditLogQueryHandler(input({ workspaceId: OWN_WS }), orgCall()),
    );
    expect(err.code).toBe("forbidden");
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });
});

describe("query_audit_log scoped to a workspace", () => {
  it("gives that workspace's Owner its own record when they name it", async () => {
    roles({ org: "Member", workspace: "Owner" });
    await auditLogQueryHandler(input({ workspaceId: OWN_WS }), wsCall());
    expect(read.where).toEqual([and(orgIs, workspaceIs(OWN_WS))]);
  });

  it("gives that workspace's Owner its own record when they name none", async () => {
    roles({ org: "Member", workspace: "Owner" });
    await auditLogQueryHandler(input(), wsCall());
    expect(read.where).toEqual([and(orgIs, workspaceIs(OWN_WS))]);
  });

  it("gives an org Admin the whole organization when they name no workspace", async () => {
    roles({ org: "Admin", workspace: null });
    await auditLogQueryHandler(input(), wsCall());
    expect(read.where).toEqual([and(orgIs)]);
  });

  it("lets an org Admin name a sibling workspace", async () => {
    roles({ org: "Admin" });
    await auditLogQueryHandler(input({ workspaceId: OTHER_WS }), wsCall());
    expect(read.where).toEqual([and(orgIs, workspaceIs(OTHER_WS))]);
  });

  it("refuses a workspace Owner naming another workspace, before reading", async () => {
    roles({ org: "Member", workspace: "Owner" });
    const err = await refusal(
      auditLogQueryHandler(input({ workspaceId: OTHER_WS }), wsCall()),
    );
    expect(err.code).toBe("forbidden");
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it("refuses a workspace Member naming no workspace", async () => {
    roles({ org: "Member", workspace: "Member" });
    const err = await refusal(auditLogQueryHandler(input(), wsCall()));
    expect(err.code).toBe("forbidden");
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });
});

describe("query_audit_log from an API key", () => {
  const keyCall = () =>
    makeCTX({ orgId: ORG, userId: null, apiKeyId: KEY, workspaceId: OWN_WS });

  it("acts as the key's creator: an org Owner's key reads the organization", async () => {
    roles({ org: "Owner", keyCreator: KEY_CREATOR });
    await auditLogQueryHandler(input(), keyCall());
    expect(read.where).toEqual([and(orgIs)]);
  });

  it("refuses a key with no recorded creator as no_principal", async () => {
    roles({ org: "Owner", keyCreator: null });
    const err = await refusal(
      auditLogQueryHandler(input({ workspaceId: OTHER_WS }), keyCall()),
    );
    expect(err).toMatchObject({ code: "forbidden", reason: "no_principal" });
  });
});

describe("query_audit_log filters and paging", () => {
  beforeEach(() => roles({ org: "Owner" }));

  it("applies every filter on top of the org fence", async () => {
    await auditLogQueryHandler(
      input({
        eventType: "auth.sign_in",
        actorUserId: USER,
        actorPublicId: "usr_7k2m9q4x8r1t5v3w6y0z2a",
        capability: "create_api_key",
        outcome: "allow",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-15T00:00:00.000Z",
      }),
      orgCall(),
    );
    const se = schema.securityEvents;
    expect(read.where).toEqual([
      and(
        orgIs,
        eq(se.eventType, "auth.sign_in"),
        eq(se.actorUserId, USER),
        eq(schema.users.publicId, "usr_7k2m9q4x8r1t5v3w6y0z2a"),
        eq(se.capability, "create_api_key"),
        eq(se.outcome, "allow"),
        gte(se.occurredAt, new Date("2026-09-01T00:00:00.000Z")),
        lt(se.occurredAt, new Date("2026-09-15T00:00:00.000Z")),
      ),
    ]);
  });

  it("reads one row past the page to report hasMore, and starts at the offset", async () => {
    stored = [row(1), row(2), row(3), row(4)];
    const out = await auditLogQueryHandler(
      input({ limit: 2, offset: 1 }),
      orgCall(),
    );
    expect(read.limit).toEqual([3]);
    expect(read.offset).toEqual([1]);
    expect(out.events.map((e) => e.requestId)).toEqual(["req_2", "req_3"]);
    expect(out).toMatchObject({ total: 2, hasMore: true, limit: 2, offset: 1 });
  });

  it("reports no more at the end of the record", async () => {
    stored = [row(1), row(2)];
    const out = await auditLogQueryHandler(
      input({ limit: 2, offset: 1 }),
      orgCall(),
    );
    expect(out.events).toHaveLength(1);
    expect(out.hasMore).toBe(false);
  });
});
