import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalKmsAdapter } from "@oxagen/crypto/kms";
import {
  SSO_SECRET_KEY_ID,
  isSealedSsoSecret,
  openSsoConfig,
  plaintextSsoSecretPaths,
  redactSsoConfig,
  resolveSsoKms,
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

describe("resolveSsoKms", () => {
  const saved = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.AUTH_TOKEN_ENCRYPTION_KEY = saved;
  });

  it("is null when AUTH_TOKEN_ENCRYPTION_KEY is unset, so writers refuse", () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    expect(resolveSsoKms()).toBeNull();
  });

  it("is null when the key is the empty string", () => {
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = "";
    expect(resolveSsoKms()).toBeNull();
  });

  it("builds an adapter under the sso_v1 key id that round-trips a secret", async () => {
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const resolved = resolveSsoKms();
    expect(resolved?.keyId).toBe(SSO_SECRET_KEY_ID);
    const stored = await sealSsoConfig(
      "oidc",
      { clientSecret: "x" },
      resolved!,
    );
    expect(stored).toContain(`"enc:v1:${SSO_SECRET_KEY_ID}:`);
    const opened = JSON.parse(await openSsoConfig("oidc", stored, resolved));
    expect(opened.clientSecret).toBe("x");
  });

  it("throws on a key that does not decode to 32 bytes rather than sealing under it", () => {
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = randomBytes(16).toString("base64");
    expect(() => resolveSsoKms()).toThrow(/32 bytes/);
  });
});

describe("plaintextSsoSecretPaths", () => {
  it("names every plaintext secret by its dotted path", () => {
    expect(
      plaintextSsoSecretPaths("saml", {
        privateKey: "plain",
        decryptionPvk: "enc:v1:sso_v1:abc",
        spMetadata: { privateKeyPass: "plain", encPrivateKey: "" },
        idpMetadata: { encPrivateKeyPass: "plain" },
        cert: "PUBLIC-CERT",
      }),
    ).toEqual([
      "privateKey",
      "spMetadata.privateKeyPass",
      "idpMetadata.encPrivateKeyPass",
    ]);
  });

  it("flags an OIDC client secret left in the clear", () => {
    expect(plaintextSsoSecretPaths("oidc", { clientSecret: "s3cret" })).toEqual(
      ["clientSecret"],
    );
  });

  it("ignores a secret path whose parent is not an object", () => {
    expect(
      plaintextSsoSecretPaths("saml", { spMetadata: "not-an-object" }),
    ).toEqual([]);
  });

  it("finds nothing left in the clear after sealing every SAML path", async () => {
    const all = {
      privateKey: "a",
      decryptionPvk: "b",
      spMetadata: {
        privateKey: "c",
        privateKeyPass: "d",
        encPrivateKey: "e",
        encPrivateKeyPass: "f",
      },
      idpMetadata: {
        privateKey: "g",
        privateKeyPass: "h",
        encPrivateKey: "i",
        encPrivateKeyPass: "j",
      },
    };
    expect(plaintextSsoSecretPaths("saml", all)).toHaveLength(10);
    const stored = JSON.parse(await sealSsoConfig("saml", all, kms));
    expect(plaintextSsoSecretPaths("saml", stored)).toEqual([]);
  });
});

describe("sealSsoConfig edge cases", () => {
  it("leaves an empty secret empty and does not invent a missing parent", async () => {
    const stored = JSON.parse(
      await sealSsoConfig("saml", { privateKey: "", cert: "C" }, kms),
    );
    expect(stored).toEqual({ privateKey: "", cert: "C" });
  });

  it("does not mutate the caller's config", async () => {
    const config = { clientSecret: "s3cret" };
    await sealSsoConfig("oidc", config, kms);
    expect(config.clientSecret).toBe("s3cret");
  });
});

describe("openSsoConfig edge cases", () => {
  it("returns stored text that is not JSON unchanged", async () => {
    await expect(openSsoConfig("oidc", "not json", kms)).resolves.toBe(
      "not json",
    );
  });

  it("returns a JSON scalar unchanged", async () => {
    await expect(openSsoConfig("oidc", "null", null)).resolves.toBe("null");
  });

  it("opens a config with no sealed secret even without a KMS", async () => {
    const stored = JSON.stringify({ clientId: "abc", issuer: "https://i" });
    await expect(openSsoConfig("oidc", stored, null)).resolves.toBe(stored);
  });

  it("refuses a sealed token with no key id", async () => {
    const stored = JSON.stringify({ clientSecret: "enc:v1::abc" });
    await expect(openSsoConfig("oidc", stored, kms)).rejects.toThrow(
      /Malformed sealed SSO secret/,
    );
  });
});

describe("redactSsoConfig edge cases", () => {
  it("marks an empty secret false and leaves an absent one absent", () => {
    // The doc comment says an unset secret is removed; the code reports an
    // empty string as `false` and only skips a missing key. Pinned here.
    expect(
      redactSsoConfig("saml", {
        privateKey: "",
        spMetadata: { privateKeyPass: "enc:v1:sso_v1:x" },
      }),
    ).toEqual({ privateKey: false, spMetadata: { privateKeyPass: true } });
  });

  it("does not mutate the caller's config", () => {
    const config = { clientSecret: "enc:v1:sso_v1:x" };
    redactSsoConfig("oidc", config);
    expect(config.clientSecret).toBe("enc:v1:sso_v1:x");
  });
});
