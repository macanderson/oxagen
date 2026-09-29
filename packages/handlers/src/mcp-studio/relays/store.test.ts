/**
 * The mcp.relays rows (M12, #4685), asserted on the statements sent.
 *
 * Every statement runs inside withSystemDb, so the org_id and workspace_id
 * predicates are the only thing that keeps one workspace from reading or
 * revoking another's relay. The transaction is drizzle's pg-proxy driver, so
 * each assertion reads the statement the store would really send.
 */
import { drizzle } from "drizzle-orm/pg-proxy";
import { schema, type Tx } from "@oxagen/database";
import { beforeEach, describe, expect, it } from "vitest";
import {
  findLiveRelay,
  findLiveRelayByHash,
  insertRelay,
  readWorkspacePublicId,
  revokeLiveRelay,
} from "./store";

const ORG = "00000000-0000-4000-8000-00000000000a";
const WS = "00000000-0000-4000-8000-00000000000b";
const ACTOR = "00000000-0000-4000-8000-0000000000aa";
const SCOPE = { orgId: ORG, workspaceId: WS };
const HASH = "a".repeat(64);
const T1 = new Date("2026-09-28T18:00:00Z");
const T2 = new Date("2026-09-28T18:05:00Z");
const PUBLIC_ID = "rly_0123456789abcdefghjkmn";

let stmts: { sql: string; params: unknown[] }[];
let rows: unknown[][];

function renderingTx(): Tx {
  return drizzle(
    async (sql, params) => {
      stmts.push({ sql, params });
      return { rows };
    },
    { schema },
  ) as unknown as Tx;
}

/** Every value bound to `<column> = $n`. */
function boundTo(
  stmt: { sql: string; params: unknown[] },
  column: string,
): unknown[] {
  const escaped = column.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");
  return [...stmt.sql.matchAll(new RegExp(`${escaped} = \\$(\\d+)`, "g"))].map(
    (m) => stmt.params[Number(m[1]) - 1],
  );
}

const ORG_ID = '"mcp"."relays"."org_id"';
const WORKSPACE_ID = '"mcp"."relays"."workspace_id"';
const NAME = '"mcp"."relays"."name"';
const TOKEN_HASH = '"mcp"."relays"."token_hash"';
const LIVE = '"mcp"."relays"."revoked_at" is null';

beforeEach(() => {
  stmts = [];
  rows = [];
});

describe("readWorkspacePublicId", () => {
  it("reads the workspace only inside the caller's organization", async () => {
    rows = [["wrk_0123456789abcdefghjkmn"]];
    await expect(readWorkspacePublicId(renderingTx(), SCOPE)).resolves.toBe(
      "wrk_0123456789abcdefghjkmn",
    );
    const [stmt] = stmts;
    expect(boundTo(stmt!, '"workspace"."workspaces"."org_id"')).toEqual([ORG]);
    expect(boundTo(stmt!, '"workspace"."workspaces"."id"')).toEqual([WS]);
  });

  it("answers null when the workspace is not in the organization", async () => {
    await expect(
      readWorkspacePublicId(renderingTx(), SCOPE),
    ).resolves.toBeNull();
  });
});

describe("findLiveRelay", () => {
  it("reads only the live relay of that name in the caller's workspace", async () => {
    rows = [[PUBLIC_ID, "office-lan", T1, null]];
    await expect(
      findLiveRelay(renderingTx(), SCOPE, "office-lan"),
    ).resolves.toEqual({
      publicId: PUBLIC_ID,
      name: "office-lan",
      createdAt: T1,
      revokedAt: null,
    });
    const [stmt] = stmts;
    expect(boundTo(stmt!, ORG_ID)).toEqual([ORG]);
    expect(boundTo(stmt!, WORKSPACE_ID)).toEqual([WS]);
    expect(boundTo(stmt!, NAME)).toEqual(["office-lan"]);
    expect(stmt!.sql).toContain(LIVE);
    // The token hash is never read back to a caller.
    expect(stmt!.sql).not.toContain("token_hash");
  });

  it("answers null when no live relay has the name", async () => {
    await expect(
      findLiveRelay(renderingTx(), SCOPE, "office-lan"),
    ).resolves.toBeNull();
  });
});

describe("insertRelay", () => {
  it("writes the hash, the scope, and the creator, and reads no hash back", async () => {
    rows = [[PUBLIC_ID, "office-lan", T1, null]];
    const row = await insertRelay(renderingTx(), {
      scope: SCOPE,
      workspacePublicId: "wrk_0123456789abcdefghjkmn",
      name: "office-lan",
      tokenHash: HASH,
      createdById: ACTOR,
      createdAt: T1,
    });
    expect(row).toEqual({
      publicId: PUBLIC_ID,
      name: "office-lan",
      createdAt: T1,
      revokedAt: null,
    });
    const [stmt] = stmts;
    expect(stmt!.sql).toMatch(/^insert into "mcp"."relays"/);
    expect(stmt!.params).toEqual(
      expect.arrayContaining([
        ORG,
        WS,
        "wrk_0123456789abcdefghjkmn",
        "office-lan",
        HASH,
        ACTOR,
      ]),
    );
    // The idMixin mints the rly_ public id on insert.
    expect(stmt!.params.some((p) => /^rly_[0-9a-z]{22}$/.test(String(p)))).toBe(
      true,
    );
    const returning = stmt!.sql.slice(stmt!.sql.indexOf(" returning "));
    expect(returning).not.toContain("token_hash");
  });

  it("throws when the insert answers no row", async () => {
    await expect(
      insertRelay(renderingTx(), {
        scope: SCOPE,
        workspacePublicId: "wrk_0123456789abcdefghjkmn",
        name: "office-lan",
        tokenHash: HASH,
        createdById: ACTOR,
        createdAt: T1,
      }),
    ).rejects.toThrow(/mcp.relays insert returned no row/);
  });
});

describe("revokeLiveRelay", () => {
  it("revokes only the live relay of that name in the caller's workspace", async () => {
    rows = [[PUBLIC_ID, "office-lan", T1, T2]];
    await expect(
      revokeLiveRelay(renderingTx(), SCOPE, "office-lan", ACTOR, T2),
    ).resolves.toEqual({
      publicId: PUBLIC_ID,
      name: "office-lan",
      createdAt: T1,
      revokedAt: T2,
    });
    const [stmt] = stmts;
    expect(stmt!.sql).toMatch(/^update "mcp"."relays" set/);
    expect(boundTo(stmt!, ORG_ID)).toEqual([ORG]);
    expect(boundTo(stmt!, WORKSPACE_ID)).toEqual([WS]);
    expect(boundTo(stmt!, NAME)).toEqual(["office-lan"]);
    // An already-revoked row keeps the time and actor of its own revocation.
    expect(stmt!.sql).toContain(LIVE);
    expect(stmt!.sql).toMatch(/"revoked_by_id" = \$\d+/);
    expect(stmt!.params).toContain(ACTOR);
  });

  it("answers null when there was nothing to revoke", async () => {
    await expect(
      revokeLiveRelay(renderingTx(), SCOPE, "office-lan", ACTOR, T2),
    ).resolves.toBeNull();
  });
});

describe("findLiveRelayByHash", () => {
  it("looks a token up by its hash among live rows and names the row's own scope", async () => {
    rows = [[ORG, WS, "wrk_0123456789abcdefghjkmn", "office-lan"]];
    await expect(
      findLiveRelayByHash(renderingTx(), HASH),
    ).resolves.toEqual({
      orgId: ORG,
      workspaceId: WS,
      workspacePublicId: "wrk_0123456789abcdefghjkmn",
      name: "office-lan",
    });
    const [stmt] = stmts;
    expect(boundTo(stmt!, TOKEN_HASH)).toEqual([HASH]);
    expect(stmt!.sql).toContain(LIVE);
  });

  it("answers null when no live row holds the hash", async () => {
    await expect(
      findLiveRelayByHash(renderingTx(), HASH),
    ).resolves.toBeNull();
  });
});
