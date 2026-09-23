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
    const many = (await adapter.findMany({
      model: "ssoProvider",
    })) as unknown as {
      oidcConfig: string;
    }[];
    expect(JSON.parse(many[0]!.oidcConfig).clientSecret).toBe("s3cret");
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
