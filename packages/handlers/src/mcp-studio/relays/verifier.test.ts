/**
 * postgresRelayTokenVerifier (M12, #4685).
 *
 * The verifier runs the real store against drizzle's pg-proxy driver. A token
 * without the oxr_ prefix is refused before any query. Any other token is
 * hashed, and only the hash reaches the database. A database error
 * propagates, so the broker refuses the connect instead of reading the error
 * as "no such relay".
 */
import { drizzle } from "drizzle-orm/pg-proxy";
import { schema, type Tx } from "@oxagen/database";
import {
  generateRelayToken,
  hashRelayToken,
} from "@oxagen/relay-broker/tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withSystemDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withSystemDb: mocks.withSystemDb,
}));

import { postgresRelayTokenVerifier } from "./verifier";

const ORG = "00000000-0000-4000-8000-00000000000a";
const WS = "00000000-0000-4000-8000-00000000000b";
const WORKSPACE_PUBLIC_ID = "wrk_0123456789abcdefghjkmn";

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

beforeEach(() => {
  vi.clearAllMocks();
  stmts = [];
  rows = [];
  mocks.withSystemDb.mockImplementation(
    async (fn: (tx: Tx) => Promise<unknown>) => fn(proxyTx()),
  );
});

describe("postgresRelayTokenVerifier", () => {
  it("names the organization, workspace, and relay of a live token", async () => {
    const token = generateRelayToken();
    rows = [[ORG, WS, WORKSPACE_PUBLIC_ID, "office-lan"]];
    await expect(postgresRelayTokenVerifier.verify(token)).resolves.toEqual({
      orgId: ORG,
      workspaceId: WS,
      workspacePublicId: WORKSPACE_PUBLIC_ID,
      relay: "office-lan",
    });

    const [stmt] = stmts;
    expect(stmt!.params).toContain(hashRelayToken(token));
    expect(stmt!.params).not.toContain(token);
    expect(stmt!.sql).not.toContain(token);
    // A revoked row never matches.
    expect(stmt!.sql).toContain('"mcp"."relays"."revoked_at" is null');
  });

  it("answers null for an unknown or revoked token", async () => {
    await expect(
      postgresRelayTokenVerifier.verify(generateRelayToken()),
    ).resolves.toBeNull();
    expect(stmts).toHaveLength(1);
  });

  it.each(["", "token", "oxscim_abc", "OXR_abc", " oxr_abc"])(
    "refuses %j without a query",
    async (token) => {
      await expect(postgresRelayTokenVerifier.verify(token)).resolves.toBeNull();
      expect(mocks.withSystemDb).not.toHaveBeenCalled();
      expect(stmts).toHaveLength(0);
    },
  );

  it("throws a database error instead of answering null", async () => {
    const down = new Error("connection refused");
    mocks.withSystemDb.mockRejectedValueOnce(down);
    await expect(
      postgresRelayTokenVerifier.verify(generateRelayToken()),
    ).rejects.toBe(down);
  });
});
