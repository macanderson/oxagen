/**
 * The credential broker's grant log (spec §6.8, #2958): one row per credential
 * put to use, named by connection and server, with a scope that describes
 * reach and no secret material, and a TTL capped at one hour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const inserted: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const updates: Array<{ table: unknown; set: unknown; cond: unknown }> = [];
let credentialRows: Array<Record<string, unknown>> = [];

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(credentialRows) }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table, values });
        return { returning: () => Promise.resolve([{ id: "grant-1" }]) };
      },
    }),
    update: (table: unknown) => ({
      set: (set: unknown) => ({
        where: (cond: unknown) => {
          updates.push({ table, set, cond });
          return {
            returning: () => Promise.resolve([{ id: "g1" }, { id: "g2" }]),
          };
        },
      }),
    }),
  };
  return {
    ...real,
    withTenantDb: async (fn: (t: unknown) => unknown) => fn(tx),
  };
});

import { schema } from "@oxagen/database";
import {
  CREDENTIAL_GRANT_MAX_TTL_MS,
  findCredentialConnection,
  recordCredentialGrant,
  revokeCredentialGrants,
  type CredentialConnection,
} from "./credential-grants";

const OAUTH: CredentialConnection = {
  id: "cred-1",
  publicId: "mcrd_1",
  authKind: "oauth",
};

const args = {
  orgId: "o1",
  workspaceId: "w1",
  connection: OAUTH,
  mcpServerId: "server-1",
  mcpServerPublicId: "mcs_gh",
  mcpServerName: "GitHub",
  endpointUrl: "https://mcp.github.com/mcp",
  runId: "run_1",
  now: new Date("2026-09-15T10:00:00.000Z"),
};

beforeEach(() => {
  inserted.length = 0;
  updates.length = 0;
  credentialRows = [];
});

describe("findCredentialConnection", () => {
  const scope = { orgId: "o1", workspaceId: "w1", orgListingId: "listing-1" };

  it("resolves the workspace's stored credential for the listing to its connection", async () => {
    credentialRows = [{ id: "cred-1", publicId: "mcrd_1", authKind: "oauth" }];
    expect(await findCredentialConnection(scope)).toEqual(OAUTH);
  });

  it("names a stored secret as authKind secret", async () => {
    credentialRows = [{ id: "cred-2", publicId: "mcrd_2", authKind: "secret" }];
    expect(await findCredentialConnection(scope)).toEqual({
      id: "cred-2",
      publicId: "mcrd_2",
      authKind: "secret",
    });
  });

  it("is null when the workspace holds no credential for the listing", async () => {
    credentialRows = [];
    expect(await findCredentialConnection(scope)).toBeNull();
    expect(inserted).toEqual([]);
  });
});

describe("recordCredentialGrant", () => {
  it("writes one grant naming the connection, the server, the run and a one-hour TTL", async () => {
    const grant = await recordCredentialGrant(args);

    expect(grant).toEqual({
      grantId: "grant-1",
      connectionId: "cred-1",
      expiresAt: new Date("2026-09-15T11:00:00.000Z"),
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.table).toBe(schema.mcpCredentialGrants);
    const values = inserted[0]!.values;
    expect(values).toMatchObject({
      orgId: "o1",
      workspaceId: "w1",
      connectionId: "cred-1",
      connectionPublicId: "mcrd_1",
      mcpServerId: "server-1",
      // Named on the row, not joined: the server row does not outlive an
      // uninstall and the grants log has to (ADR-069).
      mcpServerPublicId: "mcs_gh",
      mcpServerName: "GitHub",
      runId: "run_1",
      providerTokenId: null,
      scope: {
        endpointUrl: "https://mcp.github.com/mcp",
        authKind: "oauth",
        downscope: "none",
      },
    });
    expect(
      (values.expiresAt as Date).getTime() -
        (values.issuedAt as Date).getTime(),
    ).toBe(CREDENTIAL_GRANT_MAX_TTL_MS);
    // Reach, never material: the row carries ids, the scope and times only.
    expect(Object.keys(values).sort()).toEqual([
      "connectionId",
      "connectionPublicId",
      "expiresAt",
      "issuedAt",
      "mcpServerId",
      "mcpServerName",
      "mcpServerPublicId",
      "orgId",
      "providerTokenId",
      "runId",
      "scope",
      "workspaceId",
    ]);
  });

  it("records a stored secret as authKind secret", async () => {
    await recordCredentialGrant({
      ...args,
      connection: { id: "cred-2", publicId: "mcrd_2", authKind: "secret" },
      runId: null,
    });
    expect(inserted[0]?.values.scope).toMatchObject({ authKind: "secret" });
    expect(inserted[0]?.values.runId).toBeNull();
  });
});

describe("revokeCredentialGrants", () => {
  it("revokes the connection's live grants and reports how many", async () => {
    const tx = {
      update: (table: unknown) => ({
        set: (set: unknown) => ({
          where: (cond: unknown) => {
            updates.push({ table, set, cond });
            return {
              returning: () => Promise.resolve([{ id: "g1" }, { id: "g2" }]),
            };
          },
        }),
      }),
    };
    const now = new Date("2026-09-15T10:30:00.000Z");
    const count = await revokeCredentialGrants(
      tx as unknown as Parameters<typeof revokeCredentialGrants>[0],
      { connectionId: "cred-1", now },
    );
    expect(count).toBe(2);
    expect(updates[0]?.table).toBe(schema.mcpCredentialGrants);
    expect(updates[0]?.set).toEqual({ revokedAt: now });
    const sql = new PgDialect().sqlToQuery(updates[0]?.cond as SQL).sql;
    expect(sql).toContain("connection_id");
    expect(sql).toContain("revoked_at");
  });
});
