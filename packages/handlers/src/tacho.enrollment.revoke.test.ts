/**
 * Revoking a host must retire every credential the enrollment minted, not only
 * the one `tacho_hosts.api_key_id` happens to carry.
 *
 * Enrollment mints two keys (ADR-078): the host's control-plane key and the MCP
 * gateway key. Only the first has a column. The review finding on #3156
 * (discussion_r4032526896), repeated on #3154 and #3168, is that the gateway key
 * therefore stayed valid until expiry, so revoking a lost or copied host did not
 * take the connected app's authority away.
 *
 * The assertions compile the predicate each `update(...)` was given through
 * `PgDialect`, which is what proves the statement rather than the intent: the
 * old handler emitted a single `"id" = $1`, and reading the diff does not show
 * whether the new one reaches the second key.
 */
import type { CapabilityContext } from "@oxagen/oxagen";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
  resolveActorOrgRole: vi.fn(),
  resolveOperatorUserId: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@oxagen/database")>();
  return { ...original, withTenantDb: mocks.withTenantDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));
vi.mock("./lib/api-key-authz", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/api-key-authz")>();
  return {
    ...original,
    resolveActorOrgRole: mocks.resolveActorOrgRole,
    resolveOperatorUserId: mocks.resolveOperatorUserId,
  };
});
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { tachoEnrollmentRevokeHandler } from "./tacho.enrollment.revoke";

const ORG = "00000000-0000-0000-0000-000000000001";
const WORKSPACE = "00000000-0000-0000-0000-000000000002";
const OPERATOR = "00000000-0000-0000-0000-0000000000aa";
const HOST_KEY_ID = "00000000-0000-0000-0000-0000000000b1";
const ENROLLMENT = "tho_abc123";

const CONTEXT: CapabilityContext = {
  orgId: ORG,
  workspaceId: WORKSPACE,
  userId: OPERATOR,
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const dialect = new PgDialect();

interface Statement {
  table: string;
  sql: string;
  params: readonly unknown[];
}

/** Every `update(...)` the handler issued, with its predicate compiled. */
let updates: Statement[] = [];

/**
 * What `returning()` answers with: how the handler learns which keys the scope
 * predicate actually reached.
 */
let retiredRows: Array<{ id: string }> = [];

/** Rows the by-id fallback retires, when the scope sweep missed the host key. */
let byIdRetiredRows: Array<{ id: string }> = [];

/** Commands the handler queued. */
let inserts: number[] = [];

function tableNameOf(table: unknown): string {
  for (const s of Object.getOwnPropertySymbols(table as object)) {
    const v = (table as Record<symbol, unknown>)[s];
    if (typeof v === "string" && v !== "") return v;
  }
  return "unknown";
}

function fakeDb(
  host: Record<string, unknown>,
  opts: { byIdRetired?: Array<{ id: string }> } = {},
): void {
  if (opts.byIdRetired !== undefined) byIdRetiredRows = opts.byIdRetired;
  mocks.withTenantDb.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        // The gateway-column probe asks `information_schema` before a read
        // that names a column migration 20260917140000 adds. "Applied" is the
        // state these cases are about.
        execute: async () => [{ "?column?": 1 }],
        query: { tachoHosts: { findFirst: async () => host } },
        update: (table: unknown) => ({
          set: () => ({
            where: (pred: SQL) => {
              const q = dialect.sqlToQuery(pred);
              updates.push({
                table: tableNameOf(table),
                sql: q.sql,
                params: q.params,
              });
              // The scope sweep names the enrollment; the by-id fallback does
              // not, so the fixture can answer each with its own rows.
              const rows = q.sql.includes("host_enrollment_id")
                ? retiredRows
                : byIdRetiredRows;
              const result = Promise.resolve(rows) as Promise<
                Array<{ id: string }>
              > & {
                returning: () => Promise<Array<{ id: string }>>;
              };
              result.returning = async () => rows;
              return result;
            },
          }),
        }),
        insert: () => ({
          values: async () => {
            inserts.push(1);
          },
        }),
      }),
  );
}

beforeEach(() => {
  updates = [];
  inserts = [];
  retiredRows = [{ id: HOST_KEY_ID }, { id: "gateway-key" }];
  byIdRetiredRows = [{ id: HOST_KEY_ID }];
  mocks.withTenantDb.mockReset();
  mocks.emitSecurityEvent.mockReset();
  mocks.resolveOperatorUserId.mockResolvedValue(OPERATOR);
  mocks.resolveActorOrgRole.mockResolvedValue("Owner");
});

function host(overrides: Record<string, unknown> = {}) {
  return {
    id: "host-row-id",
    publicId: ENROLLMENT,
    orgId: ORG,
    apiKeyId: HOST_KEY_ID,
    status: "active",
    revokedAt: null,
    ...overrides,
  };
}

/** Updates against `auth.api_keys`, in the order the handler issued them. */
function keyUpdates(): Statement[] {
  return updates.filter((u) => u.table === "api_keys");
}

describe("revoking a host retires every key the enrollment minted", () => {
  it("selects keys by the enrollment marker both credentials carry", async () => {
    fakeDb(host());
    await tachoEnrollmentRevokeHandler(
      { hostEnrollmentId: ENROLLMENT },
      CONTEXT,
    );

    const sweep = keyUpdates().find((u) =>
      u.sql.includes("host_enrollment_id"),
    );
    expect(sweep).toBeDefined();
    // The enrollment id, not the single api_key_id, is what selects the rows.
    expect(sweep?.params).toContain(ENROLLMENT);
    expect(sweep?.params).toContain(ORG);
    // A key already retired is left alone rather than re-stamped.
    expect(sweep?.sql).toContain("deleted_at");
  });

  it("issues no second statement when the sweep reached the host key", async () => {
    fakeDb(host());
    await tachoEnrollmentRevokeHandler(
      { hostEnrollmentId: ENROLLMENT },
      CONTEXT,
    );
    expect(
      keyUpdates().filter((u) => u.params.includes(HOST_KEY_ID)),
    ).toHaveLength(0);
  });

  it("still retires the control-plane key of a host enrolled before the marker", async () => {
    // Such a row carries no `scope.host_enrollment_id`, so the sweep returns
    // nothing and the fallback is the only thing that takes its key away.
    retiredRows = [];
    fakeDb(host());
    await tachoEnrollmentRevokeHandler(
      { hostEnrollmentId: ENROLLMENT },
      CONTEXT,
    );
    expect(
      keyUpdates().filter((u) => u.params.includes(HOST_KEY_ID)),
    ).toHaveLength(1);
  });

  it("sweeps the keys of a host revoked before the sweep existed", async () => {
    // The population this sweep was written for. Such a host had only its
    // api_key_id deleted, so its gateway key is still live — and returning
    // early on `already` skipped exactly them. Verified against #3178's own
    // review (discussion_r4034318904).
    const revokedAt = new Date("2026-09-01T00:00:00.000Z");
    retiredRows = [{ id: "gateway-key" }];
    fakeDb(host({ status: "revoked", revokedAt }));
    const out = await tachoEnrollmentRevokeHandler(
      { hostEnrollmentId: ENROLLMENT },
      CONTEXT,
    );
    expect(keyUpdates().some((u) => u.sql.includes("host_enrollment_id"))).toBe(
      true,
    );
    // The revocation instant is the original one: the host was revoked when it
    // was revoked, and this call only takes the credentials it left live.
    expect(out.revokedAt).toBe(revokedAt.toISOString());
  });

  it("does not re-revoke the host or re-queue the command on a repeat", async () => {
    const revokedAt = new Date("2026-09-01T00:00:00.000Z");
    retiredRows = [{ id: HOST_KEY_ID }, { id: "gateway-key" }];
    fakeDb(host({ status: "revoked", revokedAt }));
    await tachoEnrollmentRevokeHandler(
      { hostEnrollmentId: ENROLLMENT },
      CONTEXT,
    );
    expect(updates.filter((u) => u.table === "hosts")).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("emits no audit event for a repeat that retired nothing", async () => {
    // Idempotent by construction: `deleted_at IS NULL` means the second call
    // matches no row. An audit event there would be noise, not a fact.
    const revokedAt = new Date("2026-09-01T00:00:00.000Z");
    retiredRows = [];
    fakeDb(host({ status: "revoked", revokedAt }), { byIdRetired: [] });
    await tachoEnrollmentRevokeHandler(
      { hostEnrollmentId: ENROLLMENT },
      CONTEXT,
    );
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("emits an audit event for a repeat that did retire a stranded key", async () => {
    // Not a duplicate: the first revocation did not take this credential, so
    // taking it is a new fact about the organisation's access.
    const revokedAt = new Date("2026-09-01T00:00:00.000Z");
    retiredRows = [{ id: "gateway-key" }];
    fakeDb(host({ status: "revoked", revokedAt }));
    await tachoEnrollmentRevokeHandler(
      { hostEnrollmentId: ENROLLMENT },
      CONTEXT,
    );
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "api_key.revoked" }),
    );
  });
});
