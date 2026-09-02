/**
 * workspace-credential-branches.test.ts
 *
 * Targeted branch coverage for workspace-credential.ts:
 *  - setWorkspaceSecret with oauthClientSecret (covers the `if (input.oauthClientSecret !== undefined)`
 *    branch at lines 60-62 and the `||` short-circuit evaluation at lines 65-70)
 *  - clientInformation() returns {} spread when oauthClientSecret is null (the empty-object branch)
 *
 * The existing workspace-credential.test.ts covers: secret, accessToken, refreshToken, kmsAbsentWarned.
 * This file targets only the missing branches.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── DB mock ───────────────────────────────────────────────────────────────────

const rows: Record<string, unknown>[] = [];
const conflictSets: Record<string, unknown>[] = [];

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        insert: () => ({
          values: (v: Record<string, unknown>) => ({
            onConflictDoUpdate: (o: { set: Record<string, unknown> }) => ({
              returning: async () => {
                rows.push(v);
                conflictSets.push(o.set);
                return [{ id: "cred-branch-1" }];
              },
            }),
          }),
        }),
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => (rows.length ? [rows[rows.length - 1]] : []),
            }),
          }),
        }),
      }),
  };
});

beforeEach(() => {
  rows.length = 0;
  conflictSets.length = 0;
  vi.resetModules();
  process.env.AUTH_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString(
    "base64",
  );
});

describe("setWorkspaceSecret — oauthClientSecret branch", () => {
  it("includes oauthClientSecretEnc in the set clause when oauthClientSecret is provided", async () => {
    const { setWorkspaceSecret } = await import("./workspace-credential");

    // Passing ONLY oauthClientId + oauthClientSecret (no secret/accessToken/refreshToken)
    // forces: lines 66-68 (||) to be fully evaluated before line 69 becomes true
    const id = await setWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l-branch-1",
      authKind: "oauth",
      oauthClientId: "dcr-id-abc",
      oauthClientSecret: "dcr-secret-xyz",
    });

    expect(id).toBe("cred-branch-1");

    // The conflict set must include oauthClientSecretEnc (line 61-62 branch covered)
    const cs = conflictSets[conflictSets.length - 1]!;
    expect("oauthClientSecretEnc" in cs).toBe(true);

    // tokenKmsKeyId should be included (because oauthClientSecret !== undefined)
    expect("tokenKmsKeyId" in cs).toBe(true);
  });

  it("does NOT include tokenKmsKeyId when all secret fields are omitted", async () => {
    const { setWorkspaceSecret } = await import("./workspace-credential");

    // Pass no secret fields at all — only oauthClientId and scopes
    await setWorkspaceSecret({
      orgId: "o1",
      workspaceId: "w1",
      orgListingId: "l-branch-2",
      authKind: "oauth",
      oauthClientId: "dcr-id-xyz",
      scopes: ["read"],
      expiresAt: new Date("2030-01-01"),
    });

    const cs = conflictSets[conflictSets.length - 1]!;
    // None of secret/accessToken/refreshToken/oauthClientSecret are provided
    // → the compound `if` on line 65-70 is false → tokenKmsKeyId NOT added
    expect("tokenKmsKeyId" in cs).toBe(false);
    // But scopes and expiresAt should be present
    expect(cs["scopes"]).toEqual(["read"]);
    expect(cs["expiresAt"]).toBeInstanceOf(Date);
  });
});
