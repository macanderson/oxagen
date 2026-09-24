/**
 * The organization's SCIM token row (#3734), asserted on the statements sent.
 *
 * These run inside withSystemDb, so the `org_id` predicate is the only thing
 * that keeps one organization's Admin from reading, revoking or locking
 * another organization's token. The handler tests (org.scim_token.test.ts)
 * mock this module, so this file is where its SQL is proven. The transaction
 * is drizzle's pg-proxy driver: each assertion reads the statement the store
 * would really send.
 */
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/pg-proxy";
import { schema, type Tx } from "@oxagen/database";
import { beforeEach, describe, expect, it } from "vitest";
import {
  insertScimToken,
  readLiveScimToken,
  revokeLiveScimToken,
  scimBaseUrl,
  toScimTokenView,
} from "./token-store";

const ORG = "00000000-0000-4000-8000-00000000000a";
const ACTOR = "00000000-0000-4000-8000-0000000000aa";
const T1 = new Date("2026-09-23T10:00:00Z");
const T2 = new Date("2026-09-23T11:30:00Z");

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

const ORG_ID = '"org"."scim_tokens"."org_id"';
const LIVE = '"org"."scim_tokens"."revoked_at" is null';

beforeEach(() => {
  stmts = [];
  rows = [];
});

describe("scimBaseUrl", () => {
  it("puts the SCIM root under the app host, however many slashes the host ends with", () => {
    expect(scimBaseUrl("https://app.oxagen.sh")).toBe(
      "https://app.oxagen.sh/api/scim/v2",
    );
    expect(scimBaseUrl("https://app.oxagen.sh///")).toBe(
      "https://app.oxagen.sh/api/scim/v2",
    );
  });
});

describe("toScimTokenView", () => {
  it("shows the prefix and times, never the row id", () => {
    expect(
      toScimTokenView({
        id: "row",
        tokenPrefix: "oxscim_abcdefgh",
        createdAt: T1,
        lastUsedAt: T2,
      }),
    ).toEqual({
      tokenPrefix: "oxscim_abcdefgh",
      createdAt: T1.toISOString(),
      lastUsedAt: T2.toISOString(),
    });
    expect(
      toScimTokenView({
        id: "row",
        tokenPrefix: "oxscim_abcdefgh",
        createdAt: T1,
        lastUsedAt: null,
      }).lastUsedAt,
    ).toBeNull();
  });
});

describe("readLiveScimToken", () => {
  it("reads only this organization's unrevoked token", async () => {
    rows = [["sct-1", "oxscim_abcdefgh", T1, null]];
    await expect(readLiveScimToken(renderingTx(), ORG)).resolves.toEqual({
      id: "sct-1",
      tokenPrefix: "oxscim_abcdefgh",
      createdAt: T1,
      lastUsedAt: null,
    });
    const [stmt] = stmts;
    expect(boundTo(stmt!, ORG_ID)).toEqual([ORG]);
    expect(stmt!.sql).toContain(LIVE);
    expect(stmt!.sql).not.toMatch(/for update/i);
    // The row's hash is never read back.
    expect(stmt!.sql).not.toContain("token_hash");
  });

  it("locks the row when asked, so two mints serialize on it", async () => {
    await readLiveScimToken(renderingTx(), ORG, true);
    expect(stmts[0]!.sql).toMatch(/ for update$/);
    expect(boundTo(stmts[0]!, ORG_ID)).toEqual([ORG]);
  });

  it("answers null when the organization has no live token", async () => {
    await expect(readLiveScimToken(renderingTx(), ORG)).resolves.toBeNull();
  });
});

describe("revokeLiveScimToken", () => {
  it("revokes only this organization's live token and records who did it", async () => {
    rows = [["sct-1", "oxscim_abcdefgh", T1, T2]];
    await expect(
      revokeLiveScimToken(renderingTx(), ORG, ACTOR),
    ).resolves.toEqual({
      id: "sct-1",
      tokenPrefix: "oxscim_abcdefgh",
      createdAt: T1,
      lastUsedAt: T2,
    });
    const [stmt] = stmts;
    expect(stmt!.sql).toMatch(/^update "org"."scim_tokens" set/);
    expect(boundTo(stmt!, ORG_ID)).toEqual([ORG]);
    // An already-revoked row keeps the time and actor of its own revocation.
    expect(stmt!.sql).toContain(LIVE);
    expect(stmt!.sql).toMatch(/"revoked_by_id" = \$\d+/);
    expect(stmt!.params.filter((p) => p === ACTOR)).toHaveLength(2);
  });

  it("answers null when there was nothing to revoke", async () => {
    await expect(
      revokeLiveScimToken(renderingTx(), ORG, ACTOR),
    ).resolves.toBeNull();
  });
});

describe("insertScimToken", () => {
  it("stores the prefix and the SHA-256 of the token, never the token, for this organization", async () => {
    rows = [["sct-2", "oxscim_placehold", T1, null]];
    const { token, row } = await insertScimToken(renderingTx(), ORG, ACTOR);
    expect(row.id).toBe("sct-2");
    expect(token).toMatch(/^oxscim_/);

    const [stmt] = stmts;
    expect(stmt!.sql).toMatch(/^insert into "org"."scim_tokens"/);
    expect(stmt!.params).toContain(ORG);
    expect(stmt!.params).toContain(token.slice(0, 16));
    expect(stmt!.params).toContain(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(stmt!.params).not.toContain(token);
    expect(stmt!.params.filter((p) => p === ACTOR)).toHaveLength(2);
  });

  it("mints a different token on every call", async () => {
    rows = [["sct-2", "oxscim_placehold", T1, null]];
    const a = await insertScimToken(renderingTx(), ORG, ACTOR);
    const b = await insertScimToken(renderingTx(), ORG, ACTOR);
    expect(a.token).not.toBe(b.token);
  });

  it("throws when the insert answers no row", async () => {
    await expect(insertScimToken(renderingTx(), ORG, ACTOR)).rejects.toThrow(
      /SCIM token insert returned no row/,
    );
  });
});
