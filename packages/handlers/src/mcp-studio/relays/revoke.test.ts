/**
 * revoke_relay (M12, #4685).
 *
 * The handler runs the real store against drizzle's pg-proxy driver, so each
 * case reads the update the handler would send. The update binds the
 * caller's organization and workspace, so a relay in another workspace is
 * never touched, and a name with no live relay answers not_found.
 */
import { drizzle } from "drizzle-orm/pg-proxy";
import { schema, type Tx } from "@oxagen/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withSystemDb: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withSystemDb: mocks.withSystemDb,
}));
vi.mock("@oxagen/iam/org-role", async () =>
  (await import("../../test-utils/org-role-gate")).orgRoleModule(),
);
vi.mock("../../logger", () => ({
  logger: { info: mocks.info, warn: vi.fn(), error: vi.fn() },
}));

import { toolRelayRevokeHandler } from "./revoke";
import { makeCTX, TEST_CTX as CTX } from "../../test-utils/fixtures";
import { resetRoleGate, roleGate } from "../../test-utils/org-role-gate";

const PUBLIC_ID = "rly_0123456789abcdefghjkmn";
const T1 = new Date("2026-09-28T18:00:00Z");
const T2 = new Date("2026-09-28T18:05:00Z");
const INPUT = { name: "office-lan" };
const ORG_ID = '"mcp"."relays"."org_id"';
const WORKSPACE_ID = '"mcp"."relays"."workspace_id"';

type Stmt = { sql: string; params: unknown[] };
let stmts: Stmt[];
let rows: unknown[][];

function proxyTx(): Tx {
  return drizzle(
    async (sql, params) => {
      stmts.push({ sql, params });
      return { rows };
    },
    { schema },
  ) as unknown as Tx;
}

/** Every value bound to `<column> = $n`. */
function boundTo(stmt: Stmt, column: string): unknown[] {
  const escaped = column.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");
  return [...stmt.sql.matchAll(new RegExp(`${escaped} = \\$(\\d+)`, "g"))].map(
    (m) => stmt.params[Number(m[1]) - 1],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  stmts = [];
  rows = [];
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: Tx) => Promise<unknown>) => fn(proxyTx()),
  );
});

describe("toolRelayRevokeHandler", () => {
  it("revokes the live relay in the caller's workspace and records who did it", async () => {
    rows = [[PUBLIC_ID, "office-lan", T1, T2]];
    await expect(toolRelayRevokeHandler(INPUT, CTX)).resolves.toEqual({
      publicId: PUBLIC_ID,
      name: "office-lan",
      revokedAt: T2.toISOString(),
    });

    expect(stmts).toHaveLength(1);
    const [stmt] = stmts;
    expect(stmt!.sql).toMatch(/^update "mcp"."relays" set/);
    expect(boundTo(stmt!, ORG_ID)).toEqual([CTX.orgId]);
    expect(boundTo(stmt!, WORKSPACE_ID)).toEqual([CTX.workspaceId]);
    expect(boundTo(stmt!, '"mcp"."relays"."name"')).toEqual(["office-lan"]);
    expect(stmt!.sql).toContain('"mcp"."relays"."revoked_at" is null');
    expect(stmt!.params).toContain(CTX.userId);
    expect(mocks.info).toHaveBeenCalledTimes(1);
  });

  it("binds only the caller's workspace, so another workspace's relay is never touched", async () => {
    const other = makeCTX({ workspaceId: "ws_2" });
    await expect(toolRelayRevokeHandler(INPUT, other)).rejects.toMatchObject({
      code: "not_found",
      reason: "relay_not_found",
    });
    const [stmt] = stmts;
    expect(boundTo(stmt!, WORKSPACE_ID)).toEqual(["ws_2"]);
    expect(stmt!.params).not.toContain(CTX.workspaceId);
  });

  it("answers not_found for a name with no live relay, including one already revoked", async () => {
    await expect(toolRelayRevokeHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "not_found",
      reason: "relay_not_found",
    });
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("lets a database error propagate", async () => {
    const down = new Error("connection refused");
    mocks.withSystemDb.mockRejectedValueOnce(down);
    await expect(toolRelayRevokeHandler(INPUT, CTX)).rejects.toBe(down);
  });

  it.each([
    { org: "Member" },
    { org: null, workspace: "Owner" },
  ])("refuses %o as forbidden before any database call", async (roles) => {
    roleGate.roles = roles;
    await expect(toolRelayRevokeHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it.each(["Owner", "Admin"])("allows an org %s", async (role) => {
    roleGate.roles = { org: role };
    rows = [[PUBLIC_ID, "office-lan", T1, T2]];
    await expect(toolRelayRevokeHandler(INPUT, CTX)).resolves.toMatchObject({
      publicId: PUBLIC_ID,
    });
  });

  it("records an API key's creator as the revoker", async () => {
    roleGate.roles = { org: "Admin", keyCreator: "u_creator" };
    rows = [[PUBLIC_ID, "office-lan", T1, T2]];
    await toolRelayRevokeHandler(
      INPUT,
      makeCTX({ userId: null, apiKeyId: "key_1" }),
    );
    expect(stmts[0]!.params).toContain("u_creator");
  });
});
