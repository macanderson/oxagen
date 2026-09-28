// Revocation when an operator disconnects or leaves the workspace: what the
// authorization server is sent (RFC 7009), which client secret signs it, and
// that the row goes even when the server refuses or cannot be reached.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./oauth";
import type { StoredOperatorToken } from "./store";
import { basicClient, json, MemoryCredentialStore, noFetch, scriptedFetch, testKms } from "./test-support";

const mocks = vi.hoisted(() => ({
  store: null as unknown,
  postgresCredentialStore: vi.fn(),
}));

vi.mock("./store", async (importOriginal) => {
  const real = await importOriginal<typeof import("./store")>();
  return { ...real, postgresCredentialStore: mocks.postgresCredentialStore };
});

import { revokeAtServer, revokeDepartedOperator, revokeOperatorToken, revokeOperatorTokens } from "./revoke";

const kms = testKms();
const USER = randomUUID();
const REVOKE_URL = "https://auth.example.com/revoke";
const KEY = { userId: USER, server: "billing", environment: "sandbox" };

let store: MemoryCredentialStore;

beforeEach(() => {
  store = new MemoryCredentialStore(kms);
  mocks.store = store;
  mocks.postgresCredentialStore.mockReset();
  mocks.postgresCredentialStore.mockImplementation(() => mocks.store);
});

function accepting() {
  return scriptedFetch(() => new Response(null, { status: 200 }));
}

function connected(overrides: Partial<Parameters<MemoryCredentialStore["addOperatorToken"]>[0]> = {}) {
  return store.addOperatorToken({
    ...KEY,
    accessToken: "op-at",
    refreshToken: "op-rt",
    clientId: "client-1",
    clientSecret: "client-secret",
    revocationEndpoint: REVOKE_URL,
    ...overrides,
  });
}

describe("revokeAtServer", () => {
  it("revokes the refresh token, then the access token, as the row's client", async () => {
    const row = await connected();
    const fetch = accepting();
    expect(await revokeAtServer(row, { store, kms, fetch })).toBe(true);

    expect(fetch.sent.map((request) => request.url)).toEqual([REVOKE_URL, REVOKE_URL]);
    expect(fetch.sent.map((request) => Object.fromEntries(request.form ?? []))).toEqual([
      { token: "op-rt", token_type_hint: "refresh_token" },
      { token: "op-at", token_type_hint: "access_token" },
    ]);
    for (const request of fetch.sent) {
      expect(basicClient(request.headers.authorization)).toEqual({
        clientId: "client-1",
        clientSecret: "client-secret",
      });
    }
  });

  it("sends only the access token when the row holds no refresh token", async () => {
    const row = await connected({ refreshToken: null });
    const fetch = accepting();
    expect(await revokeAtServer(row, { store, kms, fetch })).toBe(true);
    expect(fetch.sent.map((request) => request.form?.get("token_type_hint"))).toEqual(["access_token"]);
  });

  it("answers true and sends nothing when the server names no revocation endpoint", async () => {
    const row = await connected({ revocationEndpoint: null });
    expect(await revokeAtServer(row, { store, kms, fetch: noFetch() })).toBe(true);
  });

  it("answers false and sends nothing when the vault has no key", async () => {
    const row = await connected();
    expect(await revokeAtServer(row, { store, kms: null, fetch: noFetch() })).toBe(false);
  });

  it("signs with the named client's secret when the row holds none", async () => {
    const client = await store.addCredential({
      name: "billing-client",
      authKind: "oauth",
      oauthClientId: "named-1",
      oauthClientSecret: "named-secret",
    });
    const row = await connected({ clientId: "named-1", clientSecret: null, credentialId: client.id });
    const fetch = accepting();
    expect(await revokeAtServer(row, { store, kms, fetch })).toBe(true);
    expect(basicClient(fetch.sent[0]?.headers.authorization)).toEqual({
      clientId: "named-1",
      clientSecret: "named-secret",
    });
  });

  it("sends the client id in the body when the named client is gone", async () => {
    const row = await connected({ clientId: "named-1", clientSecret: null, credentialId: randomUUID() });
    const fetch = accepting();
    expect(await revokeAtServer(row, { store, kms, fetch })).toBe(true);
    expect(fetch.sent[0]?.headers.authorization).toBeUndefined();
    expect(fetch.sent[0]?.form?.get("client_id")).toBe("named-1");
  });

  it("answers false when the server refuses either revocation", async () => {
    const row = await connected();
    let calls = 0;
    const fetch = scriptedFetch(() => {
      calls += 1;
      return calls === 1 ? new Response(null, { status: 200 }) : json(400, { error: "unsupported_token_type" });
    });
    expect(await revokeAtServer(row, { store, kms, fetch })).toBe(false);
    expect(fetch.sent).toHaveLength(2);
  });

  it("answers false when the server cannot be reached", async () => {
    const row = await connected();
    const fetch = scriptedFetch(() => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(await revokeAtServer(row, { store, kms, fetch })).toBe(false);
  });

  it("passes the caller's abort through", async () => {
    const row = await connected();
    const controller = new AbortController();
    const reason = new Error("run cancelled");
    controller.abort(reason);
    const fetch: FetchLike = () => Promise.reject(new Error("aborted"));
    await expect(revokeAtServer(row, { store, kms, fetch, signal: controller.signal })).rejects.toBe(reason);
  });
});

describe("revokeOperatorToken", () => {
  it("deletes the row after the server accepts", async () => {
    const row = await connected();
    expect(await revokeOperatorToken(row, { store, kms, fetch: accepting() })).toBe(true);
    expect(store.tokens.has(row.id)).toBe(false);
  });

  it("deletes the row when the server refuses, and answers false", async () => {
    const row = await connected();
    const fetch = scriptedFetch(() => json(503, {}));
    expect(await revokeOperatorToken(row, { store, kms, fetch })).toBe(false);
    expect(store.tokens.has(row.id)).toBe(false);
    expect(store.writes).toEqual([`deleteOperatorToken ${row.id}`]);
  });

  it("deletes the row when the vault has no key to open it", async () => {
    const row = await connected();
    expect(await revokeOperatorToken(row, { store, kms: null, fetch: noFetch() })).toBe(false);
    expect(store.tokens.has(row.id)).toBe(false);
  });
});

describe("revokeOperatorTokens", () => {
  it("revokes and deletes every token the operator holds, and no one else's", async () => {
    const billing = await connected();
    const payroll = await connected({ server: "payroll", accessToken: "payroll-at", refreshToken: null });
    const someoneElse = await connected({ userId: randomUUID(), accessToken: "other-at" });
    const fetch = accepting();

    expect(await revokeOperatorTokens(USER, { store, kms, fetch })).toBe(2);
    expect(store.tokens.has(billing.id)).toBe(false);
    expect(store.tokens.has(payroll.id)).toBe(false);
    expect(store.tokens.has(someoneElse.id)).toBe(true);
    const revoked = fetch.sent.map((request) => request.form?.get("token"));
    expect(revoked).toEqual(expect.arrayContaining(["op-rt", "op-at", "payroll-at"]));
    expect(revoked).not.toContain("other-at");
  });

  it("answers 0 for an operator with no tokens", async () => {
    expect(await revokeOperatorTokens(USER, { store, kms, fetch: noFetch() })).toBe(0);
  });
});

describe("revokeDepartedOperator", () => {
  it("revokes the departed operator's tokens in that workspace's store", async () => {
    const scope = { orgId: randomUUID(), workspaceId: randomUUID() };
    const row = await connected();
    const fetch = accepting();

    expect(await revokeDepartedOperator({ ...scope, userId: USER }, { kms, fetch })).toBe(1);
    expect(mocks.postgresCredentialStore).toHaveBeenCalledWith(scope);
    expect(store.tokens.has(row.id)).toBe(false);
    expect(fetch.sent.map((request) => request.form?.get("token_type_hint"))).toEqual([
      "refresh_token",
      "access_token",
    ]);
  });
});
