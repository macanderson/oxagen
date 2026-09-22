import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalKmsAdapter } from "@oxagen/crypto/kms";
import {
  SSO_SECRET_KEY_ID,
  isSealedSsoSecret,
  openSsoConfig,
  plaintextSsoSecretPaths,
  redactSsoConfig,
  sealSsoConfig,
  type ResolvedSsoKms,
} from "./sso-secrets";

const kms: ResolvedSsoKms = {
  adapter: createLocalKmsAdapter(randomBytes(32)),
  keyId: SSO_SECRET_KEY_ID,
};

describe("sealSsoConfig", () => {
  it("stores the OIDC client secret as a sealed token and nothing else changes", async () => {
    const stored = await sealSsoConfig(
      "oidc",
      {
        clientId: "abc",
        clientSecret: "s3cret",
        issuer: "https://idp.example",
      },
      kms,
    );
    expect(stored).not.toContain("s3cret");
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    expect(isSealedSsoSecret(parsed.clientSecret)).toBe(true);
    expect(parsed.clientId).toBe("abc");
    expect(plaintextSsoSecretPaths("oidc", parsed)).toEqual([]);
  });

  it("seals nested SAML private keys", async () => {
    const stored = await sealSsoConfig(
      "saml",
      {
        cert: "PUBLIC-CERT",
        spMetadata: { privateKey: "PRIVATE-KEY", privateKeyPass: "pass" },
      },
      kms,
    );
    expect(stored).not.toContain("PRIVATE-KEY");
    expect(stored).not.toContain('"pass"');
    expect(stored).toContain("PUBLIC-CERT");
  });

  it("keeps an already sealed value instead of sealing it twice", async () => {
    const once = await sealSsoConfig("oidc", { clientSecret: "x" }, kms);
    const twice = await sealSsoConfig("oidc", JSON.parse(once), kms);
    expect(twice).toBe(once);
  });
});

describe("openSsoConfig", () => {
  it("round-trips every sealed secret", async () => {
    const stored = await sealSsoConfig(
      "saml",
      { privateKey: "k1", idpMetadata: { encPrivateKey: "k2" } },
      kms,
    );
    const opened = JSON.parse(await openSsoConfig("saml", stored, kms));
    expect(opened.privateKey).toBe("k1");
    expect(opened.idpMetadata.encPrivateKey).toBe("k2");
  });

  it("refuses to open a sealed config without a KMS", async () => {
    const stored = await sealSsoConfig("oidc", { clientSecret: "x" }, kms);
    await expect(openSsoConfig("oidc", stored, null)).rejects.toThrow(
      /AUTH_TOKEN_ENCRYPTION_KEY/,
    );
  });

  it("fails on a token sealed under another master key", async () => {
    const stored = await sealSsoConfig("oidc", { clientSecret: "x" }, kms);
    const other: ResolvedSsoKms = {
      adapter: createLocalKmsAdapter(randomBytes(32)),
      keyId: SSO_SECRET_KEY_ID,
    };
    await expect(openSsoConfig("oidc", stored, other)).rejects.toThrow();
  });
});

describe("redactSsoConfig", () => {
  it("replaces each secret with whether it is set", () => {
    expect(
      redactSsoConfig("oidc", { clientId: "abc", clientSecret: "enc:v1:x:y" }),
    ).toEqual({ clientId: "abc", clientSecret: true });
  });
});
