import { randomBytes } from "node:crypto";
import type { DBAdapter } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import { createLocalKmsAdapter } from "@oxagen/crypto/kms";
import {
  SSO_SECRET_KEY_ID,
  sealSsoConfig,
  type ResolvedSsoKms,
} from "@oxagen/database/sso-secrets";
import { SsoProviderWriteRefused, withSsoSecrets } from "./adapter";

const kms: ResolvedSsoKms = {
  adapter: createLocalKmsAdapter(randomBytes(32)),
  keyId: SSO_SECRET_KEY_ID,
};

async function fakeAdapter() {
  const row = {
    providerId: "acme",
    oidcConfig: await sealSsoConfig(
      "oidc",
      { clientId: "c", clientSecret: "s3cret" },
      kms,
    ),
    samlConfig: null,
  };
  const inner = {
    findOne: vi.fn(async ({ model }: { model: string }) =>
      model === "ssoProvider" ? row : { id: "u1", email: "a@b.com" },
    ),
    findMany: vi.fn(async () => [row]),
    create: vi.fn(async () => ({ id: "x" })),
    update: vi.fn(async () => null),
    updateMany: vi.fn(async () => 1),
    transaction: vi.fn(async (cb: (trx: unknown) => Promise<unknown>) =>
      cb(inner),
    ),
  };
  return { inner, row };
}

/** Wrap the fake as a real Better Auth adapter factory would be wrapped. */
function wrap(
  inner: Awaited<ReturnType<typeof fakeAdapter>>["inner"],
  kmsFor: ResolvedSsoKms | null = kms,
): DBAdapter {
  return withSsoSecrets(
    () => inner as unknown as DBAdapter,
    () => kmsFor,
  )({} as never);
}

describe("withSsoSecrets", () => {
  it("opens sealed secrets on a provider read", async () => {
    const { inner } = await fakeAdapter();
    const adapter = wrap(inner);
    const found = (await adapter.findOne({
      model: "ssoProvider",
      where: [],
    })) as {
      oidcConfig: string;
    };
    expect(JSON.parse(found.oidcConfig).clientSecret).toBe("s3cret");
  });

  // #3740: on a domain miss /sign-in/sso lists every provider. The listing
  // used to open every row's secrets, and one unopenable row failed it.
  it("lists providers with no secret and never resolves a key", async () => {
    const { inner } = await fakeAdapter();
    const resolveKms = vi.fn(() => kms);
    const adapter = withSsoSecrets(
      () => inner as unknown as DBAdapter,
      resolveKms,
    )({} as never);
    const many = (await adapter.findMany({
      model: "ssoProvider",
    })) as unknown as { providerId: string; oidcConfig: string }[];
    expect(many[0]!.providerId).toBe("acme");
    expect(JSON.parse(many[0]!.oidcConfig)).toEqual({ clientId: "c" });
    expect(many[0]!.oidcConfig).not.toContain("enc:v1:");
    expect(resolveKms).not.toHaveBeenCalled();
  });

  it("lists a provider sealed under an unknown key id, or with a malformed config, without throwing", async () => {
    const { inner, row } = await fakeAdapter();
    const orphan = {
      ...row,
      providerId: "orphan",
      oidcConfig: JSON.stringify({
        clientId: "o",
        clientSecret: "enc:v1:sso_v0:AAAA",
      }),
    };
    const malformed = { ...row, providerId: "bad", oidcConfig: "{not json" };
    inner.findMany.mockResolvedValueOnce([row, orphan, malformed]);
    const adapter = wrap(inner, null);
    const many = (await adapter.findMany({
      model: "ssoProviders",
    })) as unknown as { providerId: string; oidcConfig: string | null }[];
    expect(many.map((p) => p.providerId)).toEqual(["acme", "orphan", "bad"]);
    expect(JSON.parse(many[1]!.oidcConfig!)).toEqual({ clientId: "o" });
    expect(many[2]!.oidcConfig).toBeNull();
  });

  it("still opens one provider read through findOne after a listing", async () => {
    const { inner } = await fakeAdapter();
    const adapter = wrap(inner);
    await adapter.findMany({ model: "ssoProvider" });
    const found = (await adapter.findOne({
      model: "ssoProvider",
      where: [{ field: "providerId", value: "acme" }],
    })) as { oidcConfig: string };
    expect(JSON.parse(found.oidcConfig).clientSecret).toBe("s3cret");
  });

  it("leaves a listing of another model untouched", async () => {
    const { inner } = await fakeAdapter();
    inner.findMany.mockResolvedValueOnce([{ id: "u1" }] as never);
    const adapter = wrap(inner);
    expect(await adapter.findMany({ model: "user" })).toEqual([{ id: "u1" }]);
  });

  it("leaves other models untouched", async () => {
    const { inner } = await fakeAdapter();
    const adapter = wrap(inner);
    expect(await adapter.findOne({ model: "user", where: [] })).toEqual({
      id: "u1",
      email: "a@b.com",
    });
    await adapter.create({ model: "session", data: {} });
    expect(inner.create).toHaveBeenCalled();
  });

  it("refuses to write a provider through the adapter", async () => {
    const { inner } = await fakeAdapter();
    const adapter = wrap(inner);
    await expect(
      adapter.create({ model: "ssoProvider", data: {} }),
    ).rejects.toBeInstanceOf(SsoProviderWriteRefused);
    await expect(
      adapter.update({ model: "ssoProvider", where: [], update: {} }),
    ).rejects.toBeInstanceOf(SsoProviderWriteRefused);
    await expect(
      adapter.updateMany({ model: "ssoProviders", where: [], update: {} }),
    ).rejects.toBeInstanceOf(SsoProviderWriteRefused);
    expect(inner.create).not.toHaveBeenCalled();
  });

  it("wraps the adapter handed to a transaction", async () => {
    const { inner } = await fakeAdapter();
    const adapter = wrap(inner);
    const opened = await adapter.transaction(async (trx) =>
      trx.findOne({ model: "ssoProvider", where: [] }),
    );
    expect(
      JSON.parse((opened as { oidcConfig: string }).oidcConfig).clientSecret,
    ).toBe("s3cret");
  });

  it("fails a provider read when the secret is sealed and no key is configured", async () => {
    const { inner } = await fakeAdapter();
    const adapter = wrap(inner, null);
    await expect(
      adapter.findOne({ model: "ssoProvider", where: [] }),
    ).rejects.toThrow(/AUTH_TOKEN_ENCRYPTION_KEY/);
  });
});
