/**
 * The SCIM bearer token (#3734): minted with its hash, stored as the hash, and
 * resolved only by a live row whose hash matches.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  row: null as null | {
    id: string;
    orgId: string;
    tokenHash: string;
    lastUsedAt: Date | null;
  },
  updates: 0,
  wheres: [] as unknown[],
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const tx = {
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          db.wheres.push(w);
          return { limit: async () => (db.row ? [db.row] : []) };
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          db.updates += 1;
        },
      }),
    }),
  };
  return {
    ...real,
    withSystemDb: async (fn: (t: typeof tx) => unknown) => fn(tx),
  };
});

import {
  hashScimToken,
  mintScimToken,
  resolveScimToken,
  SCIM_TOKEN_PREFIX_LENGTH,
} from "./scim-token";

beforeEach(() => {
  db.row = null;
  db.updates = 0;
  db.wheres = [];
});

describe("mintScimToken", () => {
  it("answers the token once with only what is stored beside it", () => {
    const minted = mintScimToken();
    expect(minted.token).toMatch(/^oxscim_[A-Za-z0-9_-]{43}$/);
    expect(minted.tokenPrefix).toBe(
      minted.token.slice(0, SCIM_TOKEN_PREFIX_LENGTH),
    );
    expect(minted.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.tokenHash).toBe(hashScimToken(minted.token));
    // The stored hash does not contain the secret part of the token.
    expect(minted.tokenHash).not.toContain(minted.token.slice(7));
  });

  it("mints a different token every time", () => {
    expect(mintScimToken().token).not.toBe(mintScimToken().token);
  });
});

describe("resolveScimToken", () => {
  it("refuses a string that is not a SCIM token before reading anything", async () => {
    await expect(resolveScimToken("ox_api_key_lookalike")).resolves.toEqual({
      ok: false,
      kind: "malformed",
    });
    expect(db.wheres).toHaveLength(0);
  });

  it("refuses a token with no live row (revoked or never minted)", async () => {
    const { token } = mintScimToken();
    await expect(resolveScimToken(token)).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
  });

  it("refuses a token whose prefix matches a live row but whose hash does not", async () => {
    const { token } = mintScimToken();
    db.row = {
      id: "row-1",
      orgId: "org-1",
      tokenHash: hashScimToken(`${token}x`),
      lastUsedAt: null,
    };
    await expect(resolveScimToken(token)).resolves.toEqual({
      ok: false,
      kind: "invalid",
    });
    expect(db.updates).toBe(0);
  });

  it("resolves a live token to its organization and records the use", async () => {
    const minted = mintScimToken();
    db.row = {
      id: "row-1",
      orgId: "org-1",
      tokenHash: minted.tokenHash,
      lastUsedAt: null,
    };
    await expect(resolveScimToken(minted.token)).resolves.toEqual({
      ok: true,
      tokenId: "row-1",
      orgId: "org-1",
      tokenPrefix: minted.tokenPrefix,
    });
    expect(db.updates).toBe(1);
  });

  it("does not rewrite last_used_at on every request", async () => {
    const minted = mintScimToken();
    db.row = {
      id: "row-1",
      orgId: "org-1",
      tokenHash: minted.tokenHash,
      lastUsedAt: new Date(),
    };
    await resolveScimToken(minted.token);
    expect(db.updates).toBe(0);
  });
});
