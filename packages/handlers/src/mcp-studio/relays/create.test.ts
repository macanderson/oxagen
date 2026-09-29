/**
 * create_relay (M12, #4685).
 *
 * The handler runs the real store against drizzle's pg-proxy driver, so each
 * case reads the statements the handler would send. The row stores the
 * token's SHA-256 and never the token, the answer carries the token once, a
 * live name is refused as a conflict, and only an org Owner or Admin gets
 * past the role gate.
 */
import { drizzle } from "drizzle-orm/pg-proxy";
import { schema, type Tx } from "@oxagen/database";
import { hashRelayToken } from "@oxagen/relay-broker/tokens";
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

import { toolRelayCreateHandler } from "./create";
import { makeCTX, TEST_CTX as CTX } from "../../test-utils/fixtures";
import { resetRoleGate, roleGate } from "../../test-utils/org-role-gate";

const PUBLIC_ID = "rly_0123456789abcdefghjkmn";
const WORKSPACE_PUBLIC_ID = "wrk_0123456789abcdefghjkmn";
const T1 = new Date("2026-09-28T18:00:00Z");
const INPUT = { name: "office-lan" };

type Stmt = { sql: string; params: unknown[] };
let stmts: Stmt[];
/** The rows each statement answers, in the order the handler sends them. */
let answers: unknown[][][];

function proxyTx(): Tx {
  return drizzle(
    async (sql, params) => {
      stmts.push({ sql, params });
      return { rows: answers.shift() ?? [] };
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

function insertOf(): Stmt | undefined {
  return stmts.find((s) => s.sql.startsWith('insert into "mcp"."relays"'));
}

/** The workspace is found, no live relay holds the name, and the insert answers a row. */
function happyPath(): void {
  answers = [
    [[WORKSPACE_PUBLIC_ID]],
    [],
    [[PUBLIC_ID, "office-lan", T1, null]],
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRoleGate();
  stmts = [];
  answers = [];
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: Tx) => Promise<unknown>) => fn(proxyTx()),
  );
});

describe("toolRelayCreateHandler", () => {
  it("stores the token's hash, never the token, and answers the token once", async () => {
    happyPath();
    const out = await toolRelayCreateHandler(INPUT, CTX);

    expect(out).toEqual({
      publicId: PUBLIC_ID,
      name: "office-lan",
      createdAt: T1.toISOString(),
      token: expect.stringMatching(/^oxr_[A-Za-z0-9_-]{43}$/),
    });

    const insert = insertOf();
    expect(insert).toBeDefined();
    // The returned token hashes to the stored hash.
    expect(insert!.params).toContain(hashRelayToken(out.token));
    // No statement carries the plaintext token.
    for (const stmt of stmts) {
      expect(stmt.params).not.toContain(out.token);
      expect(stmt.sql).not.toContain(out.token);
    }
    expect(insert!.params).toEqual(
      expect.arrayContaining([
        CTX.orgId,
        CTX.workspaceId,
        WORKSPACE_PUBLIC_ID,
        "office-lan",
        CTX.userId,
      ]),
    );
  });

  it("reads and writes only in the caller's organization and workspace", async () => {
    happyPath();
    await toolRelayCreateHandler(INPUT, CTX);

    const [workspace, live] = stmts;
    expect(boundTo(workspace!, '"workspace"."workspaces"."org_id"')).toEqual([
      CTX.orgId,
    ]);
    expect(boundTo(workspace!, '"workspace"."workspaces"."id"')).toEqual([
      CTX.workspaceId,
    ]);
    expect(boundTo(live!, '"mcp"."relays"."org_id"')).toEqual([CTX.orgId]);
    expect(boundTo(live!, '"mcp"."relays"."workspace_id"')).toEqual([
      CTX.workspaceId,
    ]);
    expect(live!.sql).toContain('"mcp"."relays"."revoked_at" is null');
    expect(mocks.withSystemDb).toHaveBeenCalledTimes(1);
  });

  it("mints a new token on every call", async () => {
    happyPath();
    const a = await toolRelayCreateHandler(INPUT, CTX);
    happyPath();
    const b = await toolRelayCreateHandler(INPUT, CTX);
    expect(a.token).not.toBe(b.token);
  });

  it("never logs the token", async () => {
    happyPath();
    const out = await toolRelayCreateHandler(INPUT, CTX);
    expect(mocks.info).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(mocks.info.mock.calls);
    expect(logged).not.toContain(out.token);
    expect(logged).not.toContain(hashRelayToken(out.token));
    expect(logged).toContain(PUBLIC_ID);
  });

  it("refuses a name a live relay in the workspace holds, and writes nothing", async () => {
    answers = [[[WORKSPACE_PUBLIC_ID]], [[PUBLIC_ID, "office-lan", T1, null]]];
    await expect(toolRelayCreateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "relay_name_taken",
    });
    expect(insertOf()).toBeUndefined();
  });

  it("answers a conflict when a concurrent create wins the partial unique index", async () => {
    mocks.withSystemDb.mockRejectedValueOnce(
      Object.assign(new Error("Failed query: insert into mcp.relays"), {
        cause: {
          code: "23505",
          constraint_name: "relays_workspace_name_live_uq",
        },
      }),
    );
    await expect(toolRelayCreateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "conflict",
      reason: "relay_name_taken",
    });
  });

  it("rethrows any other unique violation unchanged", async () => {
    const collision = Object.assign(new Error("token hash collision"), {
      code: "23505",
      constraint_name: "relays_token_hash_unique",
    });
    mocks.withSystemDb.mockRejectedValueOnce(collision);
    await expect(toolRelayCreateHandler(INPUT, CTX)).rejects.toBe(collision);
  });

  it("answers not_found when the workspace is not in the organization", async () => {
    answers = [[]];
    await expect(toolRelayCreateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "not_found",
      reason: "workspace_not_found",
    });
    expect(insertOf()).toBeUndefined();
  });

  it.each([
    { org: "Member" },
    { org: null, workspace: "Owner" },
  ])("refuses %o as forbidden before any database call", async (roles) => {
    roleGate.roles = roles;
    await expect(toolRelayCreateHandler(INPUT, CTX)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(mocks.withSystemDb).not.toHaveBeenCalled();
  });

  it.each(["Owner", "Admin"])("allows an org %s", async (role) => {
    roleGate.roles = { org: role };
    happyPath();
    await expect(toolRelayCreateHandler(INPUT, CTX)).resolves.toMatchObject({
      publicId: PUBLIC_ID,
    });
  });

  it("records an API key's creator as the relay's creator", async () => {
    roleGate.roles = { org: "Admin", keyCreator: "u_creator" };
    happyPath();
    await toolRelayCreateHandler(
      INPUT,
      makeCTX({ userId: null, apiKeyId: "key_1" }),
    );
    expect(insertOf()!.params).toContain("u_creator");
  });
});
