import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The job's two database calls, faked: the select returns `rows`, and each
// update records what it would write and returns `updateResult`.
const db = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  updates: [] as { set: Record<string, unknown>; where: unknown }[],
  updateResult: [{ id: "x" }] as { id: string }[],
}));

vi.mock("./tenant", () => ({
  withSystemDb: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      select: () => ({ from: async () => db.rows }),
      update: () => ({
        set: (set: Record<string, unknown>) => ({
          where: (where: unknown) => ({
            returning: async () => {
              db.updates.push({ set, where });
              return db.updateResult;
            },
          }),
        }),
      }),
    }),
  ),
}));

const { resealSsoProviders } = await import("./sso-reseal");
const { openSsoConfig, resolveSsoKms, sealSsoConfig } = await import(
  "./sso-secrets"
);

const keyA = randomBytes(32).toString("base64");
const keyB = randomBytes(32).toString("base64");
const kmsA = resolveSsoKms({ AUTH_TOKEN_ENCRYPTION_KEY: keyA })!;
const rotated = resolveSsoKms({
  AUTH_TOKEN_ENCRYPTION_KEY: keyB,
  SSO_SECRET_KEY_ID: "sso_v2",
  SSO_SECRET_PREVIOUS_KEYS: `sso_v1=${keyA}`,
})!;
const onlyB = resolveSsoKms({
  AUTH_TOKEN_ENCRYPTION_KEY: keyB,
  SSO_SECRET_KEY_ID: "sso_v2",
})!;

beforeEach(() => {
  db.rows = [];
  db.updates = [];
  db.updateResult = [{ id: "x" }];
});

describe("resealSsoProviders", () => {
  it("re-seals the rows it can and reports the one it cannot open", async () => {
    // A row sealed under a key id nobody holds any more.
    const orphan = JSON.stringify({ clientSecret: "enc:v1:sso_v0:AAAA" });
    db.rows = [
      {
        id: "1",
        providerId: "acme",
        oidcConfig: await sealSsoConfig("oidc", { clientSecret: "a" }, kmsA),
        samlConfig: null,
      },
      { id: "2", providerId: "broken", oidcConfig: orphan, samlConfig: null },
      {
        id: "3",
        providerId: "globex",
        oidcConfig: null,
        samlConfig: await sealSsoConfig("saml", { privateKey: "g" }, kmsA),
      },
    ];

    const result = await resealSsoProviders({ kms: rotated });

    expect(result.scanned).toBe(3);
    expect(result.resealed).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.providerId).toBe("broken");
    expect(result.failed[0]!.reason).toMatch(/"sso_v0"/);

    expect(db.updates).toHaveLength(2);
    const [first, second] = db.updates;
    expect(Object.keys(first!.set).sort()).toEqual(["oidcConfig", "updatedAt"]);
    expect(Object.keys(second!.set).sort()).toEqual([
      "samlConfig",
      "updatedAt",
    ]);
    // What was written opens with the new key alone.
    const oidc = JSON.parse(
      await openSsoConfig("oidc", first!.set.oidcConfig as string, onlyB),
    );
    expect(oidc.clientSecret).toBe("a");
    const saml = JSON.parse(
      await openSsoConfig("saml", second!.set.samlConfig as string, onlyB),
    );
    expect(saml.privateKey).toBe("g");
  });

  it("writes nothing for a row already under the current key", async () => {
    db.rows = [
      {
        id: "1",
        providerId: "acme",
        oidcConfig: await sealSsoConfig("oidc", { clientSecret: "a" }, onlyB),
        samlConfig: "",
      },
    ];
    const result = await resealSsoProviders({ kms: rotated });
    expect(result).toEqual({ scanned: 1, resealed: 0, failed: [] });
    expect(db.updates).toEqual([]);
  });

  it("reports a row whose config changed during the run instead of overwriting it", async () => {
    db.rows = [
      {
        id: "1",
        providerId: "acme",
        oidcConfig: await sealSsoConfig("oidc", { clientSecret: "a" }, kmsA),
        samlConfig: null,
      },
    ];
    db.updateResult = [];
    const result = await resealSsoProviders({ kms: rotated });
    expect(result.resealed).toBe(0);
    expect(result.failed).toEqual([
      { providerId: "acme", reason: expect.stringMatching(/next run/) },
    ]);
  });

  it("skips the run when no key is configured", async () => {
    const result = await resealSsoProviders({ kms: null });
    expect(result.skipped).toMatch(/AUTH_TOKEN_ENCRYPTION_KEY/);
    expect(result.scanned).toBe(0);
  });
});
