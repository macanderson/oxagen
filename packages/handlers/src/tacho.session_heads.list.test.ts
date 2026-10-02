import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  resolve: vi.fn(),
  role: vi.fn(),
}));
vi.mock("@oxagen/database", async (original) => ({
  ...(await original<typeof import("@oxagen/database")>()),
  withTenantDb: mocks.db,
}));
vi.mock("./lib/tacho-host", () => ({ resolveEnrolledHost: mocks.resolve }));
vi.mock("./lib/capability-role-guard", () => ({
  assertContractRole: mocks.role,
}));

import { tachoSessionHeadsList as contract } from "@oxagen/oxagen/contracts/tacho.session_heads.list";
import { tachoSessionHeadsListHandler as handler } from "./tacho.session_heads.list";

const HOST = "tch_0123456789abcdefghjkmn";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ctx: CapabilityContext = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: null,
  apiKeyId: "host-key",
  requestId: "req",
  messageId: null,
  surface: "api",
};

/** A transaction whose one read answers `rows` and keeps its WHERE. */
function reading(rows: unknown[]) {
  const seen: { where?: SQL } = {};
  const tx = {
    select: () => ({
      from: () => ({
        where: async (where: SQL) => {
          seen.where = where;
          return rows;
        },
      }),
    }),
  };
  mocks.db.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(tx));
  return seen;
}

function rendered(where: SQL | undefined): { sql: string; params: unknown[] } {
  const query = new PgDialect().sqlToQuery(where as SQL);
  return { sql: query.sql, params: query.params };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ id: HOST_ID, agentKey: "acme.laptop" });
  mocks.role.mockResolvedValue("Owner");
});

describe("list_tacho_session_heads", () => {
  it("answers each held session's head and how it was recorded", async () => {
    reading([
      {
        sessionUuid: SESSION_A,
        harnessSessionId: "sess-a",
        seqCount: 42,
        recordBasis: "backfill",
        backfillNormalizer: "1",
      },
      {
        sessionUuid: SESSION_B,
        harnessSessionId: "sess-b",
        seqCount: 7,
        recordBasis: "live",
        backfillNormalizer: null,
      },
    ]);
    const input = contract.input.parse({
      host_enrollment_id: HOST,
      session_uuids: [SESSION_A, SESSION_B],
    });
    const output = await handler(input, ctx);
    expect(contract.output.parse(output)).toEqual({
      sessions: [
        {
          session_uuid: SESSION_A,
          harness_session_id: "sess-a",
          seq_count: 42,
          record_basis: "backfill",
          backfill_normalizer: "1",
        },
        {
          session_uuid: SESSION_B,
          harness_session_id: "sess-b",
          seq_count: 7,
          record_basis: "live",
          backfill_normalizer: null,
        },
      ],
    });
    expect(mocks.resolve).toHaveBeenCalledWith(
      "list_tacho_session_heads",
      ctx,
      expect.anything(),
      HOST,
    );
    expect(mocks.role).toHaveBeenCalledWith(contract, ctx);
  });

  it("reads only this host's root sessions by uuid when no ids are named", async () => {
    const seen = reading([]);
    await handler(
      contract.input.parse({ host_enrollment_id: HOST, session_uuids: [SESSION_A] }),
      ctx,
    );
    const { sql, params } = rendered(seen.where);
    expect(sql).toContain('"parent_session_uuid" is null');
    expect(sql).toContain('"host_id" = ');
    expect(sql).not.toContain('"agent_key"');
    expect(params).toEqual(
      expect.arrayContaining([ctx.orgId, ctx.workspaceId, HOST_ID, SESSION_A]),
    );
  });

  it("also finds the same agent's sessions by harness session id", async () => {
    const seen = reading([]);
    await handler(
      contract.input.parse({
        host_enrollment_id: HOST,
        session_uuids: [SESSION_A],
        harness_session_ids: ["sess-a"],
      }),
      ctx,
    );
    const { sql, params } = rendered(seen.where);
    expect(sql).toContain('"agent_key" = ');
    expect(sql).toContain('"harness_session_id" in');
    expect(params).toEqual(expect.arrayContaining(["acme.laptop", "sess-a"]));
  });

  it("reads a basis the constraint would refuse as live", async () => {
    reading([
      {
        sessionUuid: SESSION_A,
        harnessSessionId: "sess-a",
        seqCount: 3,
        recordBasis: "something-else",
        backfillNormalizer: null,
      },
    ]);
    const output = await handler(
      contract.input.parse({ host_enrollment_id: HOST, session_uuids: [SESSION_A] }),
      ctx,
    );
    expect(output.sessions[0]?.record_basis).toBe("live");
  });

  it("refuses a key that does not own the enrollment, and reads nothing", async () => {
    const seen = reading([]);
    mocks.resolve.mockRejectedValue(
      new CapabilityError(
        "list_tacho_session_heads",
        "authz_denied",
        "Forbidden: host enrollment mismatch",
      ),
    );
    await expect(
      handler(
        contract.input.parse({ host_enrollment_id: HOST, session_uuids: [SESSION_A] }),
        ctx,
      ),
    ).rejects.toThrow(/enrollment mismatch/);
    expect(seen.where).toBeUndefined();
  });

  it("takes at most 500 sessions in one call", () => {
    const many = Array.from({ length: 501 }, () => SESSION_A);
    expect(
      contract.input.safeParse({ host_enrollment_id: HOST, session_uuids: many })
        .success,
    ).toBe(false);
  });
});
