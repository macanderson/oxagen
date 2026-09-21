/**
 * export_audit_events handler tests, moved from the deprecated app's
 * audit-export.test.ts and audit-query.test.ts.
 *
 * The org is tier-free: each refusal comes from the handler's role gate, which
 * runs for real against a withTenantDb double (test-utils/role-tx.ts). The
 * walk runs against an in-memory store that applies the org fence, the
 * newest-first order and the keyset cursor the Postgres read applies, so a
 * test proves the export carries every matching event exactly once. The
 * signature is recomputed with node:crypto, independently of the handler.
 */
import { createHmac } from "node:crypto";
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
import {
  AUDIT_EXPORT_COLUMNS,
  AUDIT_EXPORT_MAX_ROWS,
  auditEventsExport,
} from "@oxagen/oxagen/contracts/audit.events.export";
import type { AuditEvent } from "@oxagen/oxagen/contracts/audit.log.query";
import { schema } from "@oxagen/database";
import { and, eq, type SQL } from "drizzle-orm";
import {
  auditEventsExportHandler,
  type AuditEventsExportDeps,
  createAuditEventsExportHandler,
  EXPORT_PAGE_SIZE,
  exportSigningSecret,
} from "./audit.events.export";
import { afterCursor, type AuditRow, ORG_ONLY_WS } from "./audit.shared";
import { makeCTX } from "./test-utils/fixtures";
import { type RoleFixture, roleTenantDb } from "./test-utils/role-tx";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000a0d1";
const OTHER_ORG = "0192d4a8-7c1e-7a00-8000-00000000a0d2";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const SECRET = "a-signing-key-of-32-characters!!";

const ctx = () =>
  makeCTX({ orgId: ORG, userId: USER, workspaceId: ORG_ONLY_WS });

function roles(fixture: RoleFixture) {
  mocks.withTenantDb.mockImplementation(roleTenantDb(fixture));
}

type Stored = AuditRow & { orgId: string };

function stored(
  n: number,
  over: Partial<AuditEvent> = {},
  orgId = ORG,
): Stored {
  const id = `0192d4a8-7c1e-7a00-8000-${String(n).padStart(12, "0")}`;
  // Every event shares one millisecond; only the microseconds and the id order them.
  const at = `2026-09-15 12:00:00.${String(999_999 - n).padStart(6, "0")}+00`;
  return {
    orgId,
    cursor: { at, id },
    event: {
      id,
      source: "security",
      eventType: "capability.invoke_denied",
      occurredAt: "2026-09-15T12:00:00.999Z",
      actorUserId: USER,
      actorPublicId: "usr_7k2m9q4x8r1t5v3w6y0z2a",
      workspaceId: null,
      workspaceSlug: null,
      capability: "set_spend_budget",
      outcome: "deny",
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0",
      requestId: `req_${n}`,
      ...over,
    },
  };
}

/** Rows older than the cursor in (at, id) order, newest first, fenced to the org. */
function storeReader(rows: Stored[]) {
  const ordered = [...rows].sort((a, b) =>
    a.cursor.at === b.cursor.at
      ? b.cursor.id.localeCompare(a.cursor.id)
      : b.cursor.at.localeCompare(a.cursor.at),
  );
  return vi.fn<AuditEventsExportDeps["readPage"]>(
    async (orgId, _filter, cursor, limit) =>
      ordered
        .filter((r) => r.orgId === orgId)
        .filter(
          (r) =>
            cursor === null ||
            r.cursor.at < cursor.at ||
            (r.cursor.at === cursor.at && r.cursor.id < cursor.id),
        )
        .slice(0, limit),
  );
}

function handlerOver(rows: Stored[]) {
  const readPage = storeReader(rows);
  return {
    readPage,
    handler: createAuditEventsExportHandler({
      readPage,
      signingSecret: () => SECRET,
    }),
  };
}

const hmac = (body: string) =>
  createHmac("sha256", SECRET).update(body, "utf8").digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  roles({ org: "Owner" });
});

describe("export_audit_events role gate", () => {
  it.each(["Member", "Billing"])(
    "refuses an org %s as forbidden before reading a row",
    async (role) => {
      roles({ org: role });
      const { handler, readPage } = handlerOver([stored(1)]);
      const err = await handler(auditEventsExport.input.parse({}), ctx()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isHandlerError(err)).toBe(true);
      expect(err).toMatchObject({ code: "forbidden" });
      expect(readPage).not.toHaveBeenCalled();
    },
  );

  it("exports for an org Admin", async () => {
    roles({ org: "Admin" });
    const { handler } = handlerOver([stored(1)]);
    const out = await handler(auditEventsExport.input.parse({}), ctx());
    expect(out.rowCount).toBe(1);
  });
});

describe("export_audit_events serialization and signature", () => {
  it("writes RFC 4180 CSV with the header, quoted fields, empty nulls and CRLF lines, signed over the exact bytes", async () => {
    const { handler } = handlerOver([
      stored(1, { capability: 'say "hi", then', userAgent: "line\nbreak" }),
      stored(2, { actorUserId: null, ip: null, workspaceId: null }),
      stored(3, {}, OTHER_ORG),
    ]);
    const out = await handler(auditEventsExport.input.parse({}), ctx());

    const lines = out.body.split("\r\n");
    expect(lines[0]).toBe(AUDIT_EXPORT_COLUMNS.join(","));
    expect(out.body).toContain('"say ""hi"", then"');
    expect(out.body).toContain('"line\nbreak"');
    expect(out.body.endsWith("\r\n")).toBe(true);
    expect(out.body).not.toContain(OTHER_ORG);
    expect(out.rowCount).toBe(2);
    expect(out).toMatchObject({ format: "csv", algorithm: "HMAC-SHA256" });
    expect(out.signature).toBe(hmac(out.body));
    expect(out.signature).not.toBe(hmac(`${out.body} `));
    expect(auditEventsExport.output.parse(out)).toEqual(out);
  });

  it("neutralizes a formula-leading field in CSV and leaves NDJSON the recorded value", async () => {
    // A member can plant this: packages/auth/src/auth.ts writes the session
    // User-Agent onto the organization's events, and an Owner opening the CSV
    // would otherwise have the spreadsheet evaluate it.
    const planted = '=HYPERLINK("http://evil.test","click")';
    const rows = [stored(1, { userAgent: planted, capability: "+1+1" })];

    const csv = await handlerOver(rows).handler(
      auditEventsExport.input.parse({}),
      ctx(),
    );
    expect(csv.body).toContain(`"\t${planted.replace(/"/g, '""')}"`);
    expect(csv.body).toContain('"\t+1+1"');
    expect(csv.body).not.toContain(`,${planted}`);

    const ndjson = await handlerOver(rows).handler(
      auditEventsExport.input.parse({ format: "ndjson" }),
      ctx(),
    );
    const object = JSON.parse(ndjson.body.trimEnd()) as Record<string, string>;
    expect(object.user_agent).toBe(planted);
    expect(object.capability).toBe("+1+1");
  });

  it("writes one JSON object per line in NDJSON, every column present and nulls empty", async () => {
    const { handler } = handlerOver([stored(1), stored(2, { ip: null })]);
    const out = await handler(
      auditEventsExport.input.parse({ format: "ndjson" }),
      ctx(),
    );
    const objects = out.body
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, string>);
    expect(objects).toHaveLength(2);
    expect(Object.keys(objects[0] ?? {})).toEqual([...AUDIT_EXPORT_COLUMNS]);
    expect(objects[0]).toMatchObject({ org_id: ORG, request_id: "req_1" });
    expect(objects[1]?.ip).toBe("");
    expect(out.signature).toBe(hmac(out.body));
  });

  it("signs an empty export as an empty file", async () => {
    const { handler } = handlerOver([]);
    const out = await handler(
      auditEventsExport.input.parse({ format: "ndjson" }),
      ctx(),
    );
    expect(out).toMatchObject({ body: "", rowCount: 0, signature: hmac("") });
  });
});

describe("export_audit_events walk", () => {
  it("carries every event exactly once across pages that share a millisecond", async () => {
    const rows = Array.from({ length: EXPORT_PAGE_SIZE * 2 + 5 }, (_, i) =>
      stored(i + 1),
    );
    const { handler, readPage } = handlerOver(rows);
    const out = await handler(auditEventsExport.input.parse({}), ctx());

    expect(out.rowCount).toBe(rows.length);
    expect(readPage).toHaveBeenCalledTimes(3);
    const ids = out.body
      .split("\r\n")
      .slice(1, -1)
      .map((l) => l.split(",")[0]);
    expect(new Set(ids).size).toBe(rows.length);
    expect(readPage.mock.calls[1]?.[2]).toEqual(
      rows[EXPORT_PAGE_SIZE - 1]?.cursor,
    );
  });

  it("refuses a match wider than the bound as invalid_input rather than signing a truncated file", async () => {
    const rows = Array.from({ length: AUDIT_EXPORT_MAX_ROWS + 1 }, (_, i) =>
      stored(i + 1),
    );
    const { handler } = handlerOver(rows);
    await expect(
      handler(auditEventsExport.input.parse({}), ctx()),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("exports exactly the bound", async () => {
    const rows = Array.from({ length: AUDIT_EXPORT_MAX_ROWS }, (_, i) =>
      stored(i + 1),
    );
    const { handler } = handlerOver(rows);
    const out = await handler(auditEventsExport.input.parse({}), ctx());
    expect(out.rowCount).toBe(AUDIT_EXPORT_MAX_ROWS);
  });

  it("propagates a store failure mid-walk and signs nothing", async () => {
    const rows = Array.from({ length: EXPORT_PAGE_SIZE + 1 }, (_, i) =>
      stored(i + 1),
    );
    const readPage = storeReader(rows);
    readPage.mockImplementationOnce(async (orgId, f, c, limit) =>
      storeReader(rows)(orgId, f, c, limit),
    );
    readPage.mockRejectedValueOnce(new Error("connection reset"));
    const sign = vi.fn(() => SECRET);
    const handler = createAuditEventsExportHandler({
      readPage,
      signingSecret: sign,
    });
    await expect(
      handler(auditEventsExport.input.parse({}), ctx()),
    ).rejects.toThrow("connection reset");
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("the registered export handler", () => {
  it.each(["csv", "ndjson"] as const)(
    "reads and signs stored invalidation detail in %s",
    async (format) => {
      vi.stubEnv("AUDIT_EXPORT_SIGNING_SECRET", SECRET);
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
      const where: SQL[] = [];
      const selections: Record<string, unknown>[] = [];
      mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) => {
        const chain = {
          select: (fields: Record<string, unknown>) => {
            selections.push(fields);
            return chain;
          },
          from: () => chain,
          leftJoin: () => chain,
          where: (cond: SQL) => {
            where.push(cond);
            return chain;
          },
          orderBy: () => chain,
          limit: () => chain,
          offset: () =>
            Promise.resolve(
              [
                stored(1, { eventType: "approval_rule.invalidated", detail }),
                stored(2),
              ].map((r) => ({
                ...r.event,
                at: r.cursor.at,
                occurredAt: new Date(r.event.occurredAt),
              })),
            ),
        };
        return Promise.resolve(fn(chain));
      });
      const out = await auditEventsExportHandler(
        auditEventsExport.input.parse({ format }),
        ctx(),
      );
      expect(selections[0]).toHaveProperty(
        "detail",
        schema.securityEvents.detail,
      );
      expect(where).toEqual([and(eq(schema.securityEvents.orgId, ORG))]);
      if (format === "ndjson") {
        const rows = out.body
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(rows[0].detail).toEqual(detail);
        expect(rows[1].detail).toBeNull();
      } else {
        expect(out.body.split("\r\n")[0]).toBe(AUDIT_EXPORT_COLUMNS.join(","));
        expect(out.body).toContain(
          `"${JSON.stringify(detail).replace(/"/g, '""')}"`,
        );
        expect(out.body.split("\r\n")[2]?.endsWith(",")).toBe(true);
      }
      expect(out.signature).toBe(hmac(out.body));
      expect(out.signature).not.toBe(
        hmac(out.body.replace("classification_changed", "tool_scope_changed")),
      );
    },
  );

  it("reads through withSystemDb with the org fence, the named workspace and the cursor after the first page", async () => {
    vi.stubEnv("AUDIT_EXPORT_SIGNING_SECRET", SECRET);
    const where: SQL[] = [];
    const pages = [
      Array.from({ length: EXPORT_PAGE_SIZE }, (_, i) => {
        const r = stored(i + 1);
        return {
          ...r.event,
          at: r.cursor.at,
          occurredAt: new Date(r.event.occurredAt),
        };
      }),
      [],
    ];
    mocks.withSystemDb.mockImplementation((fn: (tx: unknown) => unknown) => {
      const chain = {
        select: () => chain,
        from: () => chain,
        leftJoin: () => chain,
        where: (cond: SQL) => {
          where.push(cond);
          return chain;
        },
        orderBy: () => chain,
        limit: () => chain,
        offset: () => Promise.resolve(pages.shift() ?? []),
      };
      return Promise.resolve(fn(chain));
    });
    const ws = "0192d4a8-7c1e-7a00-8000-00000000c0e1";
    const out = await auditEventsExportHandler(
      auditEventsExport.input.parse({ workspaceId: ws }),
      ctx(),
    );
    const fence = [
      eq(schema.securityEvents.orgId, ORG),
      eq(schema.securityEvents.workspaceId, ws),
    ];
    expect(where[0]).toEqual(and(...fence));
    expect(where[1]).toEqual(
      and(...fence, afterCursor(stored(EXPORT_PAGE_SIZE).cursor)),
    );
    expect(out.rowCount).toBe(EXPORT_PAGE_SIZE);
    expect(out.signature).toBe(hmac(out.body));
  });
});

describe("exportSigningSecret", () => {
  it("uses a dedicated key of at least 16 characters", () => {
    vi.stubEnv("AUDIT_EXPORT_SIGNING_SECRET", SECRET);
    vi.stubEnv("BETTER_AUTH_SECRET", "the-auth-secret-of-32-characters");
    expect(exportSigningSecret()).toBe(SECRET);
  });

  it.each([
    ["a shorter dedicated key", "short"],
    ["no dedicated key", ""],
  ])("falls back to BETTER_AUTH_SECRET for %s", (_label, dedicated) => {
    vi.stubEnv("AUDIT_EXPORT_SIGNING_SECRET", dedicated);
    vi.stubEnv("BETTER_AUTH_SECRET", "the-auth-secret-of-32-characters");
    expect(exportSigningSecret()).toBe("the-auth-secret-of-32-characters");
  });
});
