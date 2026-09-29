import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Each call on the fake transaction takes the next queued result. A chain
// records every method it saw, so a test can read the SQL it built.
type Step = { method: string; args: unknown[] };
type Chain = { op: string; table: unknown; steps: Step[] };

const { state, withSystemDbMock, cryptoMock } = vi.hoisted(() => {
  type HoistedChain = {
    op: string;
    table: unknown;
    steps: Array<{ method: string; args: unknown[] }>;
  };
  const state = { results: [] as unknown[], chains: [] as HoistedChain[] };
  function chain(op: string, table: unknown): Record<string, unknown> {
    const record: HoistedChain = { op, table, steps: [] };
    state.chains.push(record);
    const result = state.results.shift();
    const node: Record<string, unknown> = {};
    for (const method of [
      "from",
      "where",
      "orderBy",
      "limit",
      "values",
      "onConflictDoUpdate",
      "set",
      "returning",
    ])
      node[method] = (...args: unknown[]) => {
        record.steps.push({ method, args });
        if (method === "from") record.table = args[0];
        return node;
      };
    node["then"] = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return node;
  }
  const tx = {
    select: (fields: unknown) => chain("select", fields),
    insert: (table: unknown) => chain("insert", table),
    update: (table: unknown) => chain("update", table),
    delete: (table: unknown) => chain("delete", table),
  };
  return {
    state,
    withSystemDbMock: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    cryptoMock: {
      createIngestionCryptoAdapter: () => ({ adapter: "write-adapter", keyId: "env:v1" }),
      resolveIngestionCryptoAdapterForKeyId: (keyId: string) => ({
        adapter: `read-adapter:${keyId}`,
        keyId,
      }),
      encrypt: async (plain: string) => Buffer.from(`sealed:${plain}`),
      decrypt: async (cipher: Buffer) =>
        Buffer.from(cipher.toString("utf8").replace(/^sealed:/, "")),
    },
  };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withSystemDb: vi.fn(withSystemDbMock) };
});

vi.mock("@oxagen/crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/crypto")>()),
  ...cryptoMock,
}));

import { schema } from "@oxagen/database";
import {
  SLACK_NOTICES_PROVIDER,
  deleteSlackConnection,
  loadSlackConnection,
  openSlackToken,
  recordSlackFailure,
  saveSlackConnection,
  setSlackChannel,
} from "./slack-connection";

const dialect = new PgDialect();

function render(value: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(value as SQL);
}

function step(chain: Chain | undefined, method: string): unknown[] {
  const found = chain?.steps.find((s) => s.method === method);
  if (!found) throw new Error(`no ${method} step on ${chain?.op}`);
  return found.args;
}

const INSTALL = {
  accessToken: "xoxb-new",
  appId: "A1",
  botUserId: "U1",
  scopes: ["chat:write", "channels:read"],
  team: { id: "T1", name: "Acme" },
};

beforeEach(() => {
  state.results = [];
  state.chains = [];
});

describe("openSlackToken", () => {
  it("decrypts the envelope with the adapter its key id names", async () => {
    const envelope = {
      keyId: "env:v1",
      ciphertext: Buffer.from("sealed:xoxb-1").toString("base64"),
    };
    await expect(openSlackToken(envelope)).resolves.toBe("xoxb-1");
  });

  it("throws on an envelope that is not the stored shape", async () => {
    await expect(openSlackToken({ keyId: "" })).rejects.toThrow();
    await expect(openSlackToken(null)).rejects.toThrow();
  });
});

describe("loadSlackConnection", () => {
  const account = {
    teamId: "T1",
    teamName: "Acme",
    scopes: ["chat:write"],
    tokenEnvelope: { keyId: "k", ciphertext: "c" },
    createdAt: new Date("2026-09-01T00:00:00Z"),
  };

  it("returns null when the organization has no token row", async () => {
    state.results = [[]];
    await expect(loadSlackConnection("org-1")).resolves.toBeNull();
    expect(state.chains).toHaveLength(1);
    const where = render(step(state.chains[0], "where")[0]);
    expect(where.params).toEqual(["org-1", SLACK_NOTICES_PROVIDER]);
  });

  it("joins the token row to the setting for the same team", async () => {
    state.results = [
      [account],
      [
        {
          settings: {
            other: true,
            slack_notices: {
              teamId: "T1",
              channel: { id: "C1", name: "alerts", isPrivate: false },
              lastFailure: { code: "not_in_channel", at: "2026-09-27T00:00:00Z" },
            },
          },
        },
      ],
    ];
    await expect(loadSlackConnection("org-1")).resolves.toEqual({
      orgId: "org-1",
      teamId: "T1",
      teamName: "Acme",
      scopes: ["chat:write"],
      channel: { id: "C1", name: "alerts", isPrivate: false },
      lastFailure: { code: "not_in_channel", at: "2026-09-27T00:00:00Z" },
      connectedAt: account.createdAt,
      tokenEnvelope: account.tokenEnvelope,
    });
    expect(state.chains[1]?.table).toBe(schema.organizations);
  });

  it("drops a setting that belongs to another team", async () => {
    state.results = [
      [account],
      [{ settings: { slack_notices: { teamId: "T0", channel: { id: "C9", name: "x", isPrivate: false } } } }],
    ];
    await expect(loadSlackConnection("org-1")).resolves.toMatchObject({
      channel: null,
      lastFailure: null,
    });
  });

  it("reads a malformed channel or failure as none", async () => {
    state.results = [
      [account],
      [{ settings: { slack_notices: { teamId: "T1", channel: { id: 5 }, lastFailure: "bad" } } }],
    ];
    await expect(loadSlackConnection("org-1")).resolves.toMatchObject({
      channel: null,
      lastFailure: null,
    });
  });

  it("copes with settings that are not an object and an org row that is gone", async () => {
    state.results = [[{ ...account, teamName: null }], [{ settings: null }]];
    await expect(loadSlackConnection("org-1")).resolves.toMatchObject({
      teamName: "T1",
      channel: null,
    });
    state.results = [[account], []];
    await expect(loadSlackConnection("org-1")).resolves.toMatchObject({ channel: null });
  });
});

describe("saveSlackConnection", () => {
  it("removes other teams' tokens, upserts this team's, and resets the setting", async () => {
    const old = { keyId: "env:v1", ciphertext: "old" };
    state.results = [[{ tokenEnvelope: old }], undefined, undefined];
    await expect(saveSlackConnection({ orgId: "org-1", install: INSTALL })).resolves.toEqual({
      replacedTokenEnvelopes: [old],
    });

    const [del, ins, upd] = state.chains;
    expect(del?.op).toBe("delete");
    expect(del?.table).toBe(schema.oauthAccounts);
    const delWhere = render(step(del, "where")[0]);
    expect(delWhere.sql).toContain("<>");
    expect(delWhere.params).toEqual(["org-1", SLACK_NOTICES_PROVIDER, "T1"]);

    expect(ins?.op).toBe("insert");
    const [row] = step(ins, "values") as [Record<string, unknown>];
    expect(row).toMatchObject({
      orgId: "org-1",
      provider: SLACK_NOTICES_PROVIDER,
      providerUserId: "T1",
      providerUserName: "Acme",
      accessTokenEnc: {
        keyId: "env:v1",
        ciphertext: Buffer.from("sealed:xoxb-new").toString("base64"),
      },
      refreshTokenEnc: null,
      expiresAt: null,
      tokenType: "bot",
      scopes: ["chat:write", "channels:read"],
    });
    expect(row["publicId"]).toMatch(/^oa_[0-9a-f]{16}$/);
    const [conflict] = step(ins, "onConflictDoUpdate") as [
      { target: unknown[]; set: Record<string, unknown> },
    ];
    expect(conflict.target).toEqual([
      schema.oauthAccounts.orgId,
      schema.oauthAccounts.provider,
      schema.oauthAccounts.providerUserId,
    ]);
    expect(conflict.set).toMatchObject({
      accessTokenEnc: row["accessTokenEnc"],
      expiresAt: null,
      refreshFailureCount: 0,
    });

    expect(upd?.op).toBe("update");
    expect(upd?.table).toBe(schema.organizations);
    const [values] = step(upd, "set") as [{ settings: unknown }];
    const setSql = render(values.settings);
    expect(setSql.sql).toContain("jsonb_set");
    expect(setSql.sql).toContain("CASE WHEN");
    expect(setSql.params).toContain(
      JSON.stringify({ teamId: "T1", channel: null, lastFailure: null }),
    );
    expect(render(step(upd, "where")[0]).params).toEqual(["org-1"]);
  });

  it("returns no envelopes when no other team was connected", async () => {
    state.results = [[], undefined, undefined];
    await expect(saveSlackConnection({ orgId: "org-1", install: INSTALL })).resolves.toEqual({
      replacedTokenEnvelopes: [],
    });
  });
});

describe("setSlackChannel", () => {
  const channel = { id: "C1", name: "alerts", isPrivate: true };

  it("writes the channel, clears the failure, and guards on the team", async () => {
    state.results = [[{ id: "org-1" }]];
    await expect(setSlackChannel({ orgId: "org-1", teamId: "T1", channel })).resolves.toBe(true);
    const [upd] = state.chains;
    const [values] = step(upd, "set") as [{ settings: unknown }];
    const setSql = render(values.settings);
    expect(setSql.params).toContain(JSON.stringify(channel));
    expect(setSql.params).toContain("{slack_notices,channel}");
    expect(setSql.params).toContain("{slack_notices,lastFailure}");
    const where = render(step(upd, "where")[0]);
    expect(where.params).toEqual(["org-1", "slack_notices", "T1"]);
  });

  it("returns false when the connection moved to another team", async () => {
    state.results = [[]];
    await expect(setSlackChannel({ orgId: "org-1", teamId: "T0", channel })).resolves.toBe(false);
  });

  it("refuses a channel with no name", async () => {
    await expect(
      setSlackChannel({ orgId: "org-1", teamId: "T1", channel: { ...channel, name: "" } }),
    ).rejects.toThrow();
    expect(state.chains).toHaveLength(0);
  });
});

describe("recordSlackFailure", () => {
  it("writes a failure for the same team", async () => {
    state.results = [undefined];
    const failure = { code: "not_in_channel", at: "2026-09-28T00:00:00.000Z" };
    await recordSlackFailure({ orgId: "org-1", teamId: "T1", failure });
    const [upd] = state.chains;
    const [values] = step(upd, "set") as [{ settings: unknown }];
    expect(render(values.settings).params).toEqual([
      "{slack_notices,lastFailure}",
      JSON.stringify(failure),
    ]);
    const where = render(step(upd, "where")[0]);
    expect(where.sql).toContain("true");
    expect(where.params).toEqual(["org-1", "slack_notices", "T1"]);
  });

  it("clears a failure only when one is on record", async () => {
    state.results = [undefined];
    await recordSlackFailure({ orgId: "org-1", teamId: "T1", failure: null });
    const [upd] = state.chains;
    const [values] = step(upd, "set") as [{ settings: unknown }];
    expect(render(values.settings).params).toEqual(["{slack_notices,lastFailure}", "null"]);
    const where = render(step(upd, "where")[0]);
    expect(where.sql).toContain("jsonb_typeof");
    expect(where.params).toEqual(["org-1", "slack_notices", "T1", "slack_notices"]);
  });
});

describe("deleteSlackConnection", () => {
  it("removes every token row and the setting", async () => {
    const envelope = { keyId: "env:v1", ciphertext: "x" };
    state.results = [[{ tokenEnvelope: envelope }], undefined];
    await expect(deleteSlackConnection("org-1")).resolves.toEqual({
      removedTokenEnvelopes: [envelope],
    });
    const [del, upd] = state.chains;
    expect(del?.op).toBe("delete");
    expect(render(step(del, "where")[0]).params).toEqual(["org-1", SLACK_NOTICES_PROVIDER]);
    const [values] = step(upd, "set") as [{ settings: unknown }];
    const setSql = render(values.settings);
    expect(setSql.sql).toContain(" - ");
    expect(setSql.params).toEqual(["slack_notices"]);
    expect(render(step(upd, "where")[0]).params).toEqual(["org-1"]);
  });
});
