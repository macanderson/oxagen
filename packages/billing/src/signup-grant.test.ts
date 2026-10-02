/**
 * signup-grant.test.ts: the one-time signup grant (ADR-241, #4886).
 *
 * The fake executor below answers the Free row's grant figures and keeps the
 * grant rows by org id, the way the unique index on
 * `gau_signup_grants.org_id` does. signup-grant.pg.test.ts proves the same
 * two rules against the real index and the real Free row.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@oxagen/database";
import {
  issueSignupGrant,
  signupGrantActive,
  signupGrantFor,
} from "./signup-grant";

const NOW = new Date("2026-10-01T09:30:00.000Z");

function fakeTx(policy: { grantGau: number; grantDays: number } | null) {
  const grants = new Map<string, Record<string, unknown>>();
  const tx = {
    grants,
    select: () => ({
      from: (table: unknown) => {
        if (table !== schema.plans) throw new Error("unexpected table");
        const chain = {
          where: () => chain,
          limit: () => Promise.resolve(policy === null ? [] : [policy]),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => {
      if (table !== schema.gauSignupGrants) throw new Error("unexpected table");
      return {
        values: (row: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            // RETURNING names three columns, so the org id is not among them.
            returning: () => {
              const { orgId, ...returned } = row;
              if (grants.has(orgId as string)) return Promise.resolve([]);
              grants.set(orgId as string, row);
              return Promise.resolve([returned]);
            },
          }),
        }),
      };
    },
  };
  return tx;
}

describe("signupGrantFor", () => {
  it("grants the policy's size and expires grantDays later", () => {
    expect(signupGrantFor({ grantGau: 33_000, grantDays: 30 }, NOW)).toEqual({
      grantedGau: 33_000,
      grantedAt: NOW,
      expiresAt: new Date("2026-10-31T09:30:00.000Z"),
    });
  });
});

describe("signupGrantActive", () => {
  const grant = signupGrantFor({ grantGau: 33_000, grantDays: 30 }, NOW);

  it("holds until the expiry instant and not at it", () => {
    expect(signupGrantActive(grant, NOW)).toBe(true);
    expect(
      signupGrantActive(grant, new Date(grant.expiresAt.getTime() - 1)),
    ).toBe(true);
    expect(signupGrantActive(grant, grant.expiresAt)).toBe(false);
  });
});

describe("issueSignupGrant", () => {
  it("grants the Free row's figures as they stand at signup", async () => {
    const tx = fakeTx({ grantGau: 33_000, grantDays: 30 });
    const grant = await issueSignupGrant(tx as never, "org-1", NOW);
    expect(grant).toEqual({
      grantedGau: 33_000,
      grantedAt: NOW,
      expiresAt: new Date("2026-10-31T09:30:00.000Z"),
    });
  });

  it("gives the next signup the new size after an operator changes the Free row", async () => {
    const tx = fakeTx({ grantGau: 33_000, grantDays: 30 });
    await issueSignupGrant(tx as never, "org-before", NOW);

    // The operator's UPDATE on billing.plans: no deploy, no code change.
    const changed = fakeTx({ grantGau: 50_000, grantDays: 14 });
    const grant = await issueSignupGrant(changed as never, "org-after", NOW);

    expect(grant?.grantedGau).toBe(50_000);
    expect(grant?.expiresAt).toEqual(new Date("2026-10-15T09:30:00.000Z"));
    expect(tx.grants.get("org-before")?.grantedGau).toBe(33_000);
  });

  it("issues a second grant to the same organisation as nothing", async () => {
    const tx = fakeTx({ grantGau: 33_000, grantDays: 30 });
    const first = await issueSignupGrant(tx as never, "org-1", NOW);
    const second = await issueSignupGrant(
      tx as never,
      "org-1",
      new Date("2026-12-01T00:00:00.000Z"),
    );

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(tx.grants.size).toBe(1);
    expect(tx.grants.get("org-1")?.grantedAt).toEqual(NOW);
  });

  it("refuses to guess a size when the Free row is not seeded", async () => {
    await expect(
      issueSignupGrant(fakeTx(null) as never, "org-1", NOW),
    ).rejects.toThrow(/Free plan row is not seeded/);
  });
});
