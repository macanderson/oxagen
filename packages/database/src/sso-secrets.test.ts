import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalKmsAdapter } from "@oxagen/crypto/kms";
import {
  SSO_SECRET_KEY_ID,
  SsoSecretKeyMissingError,
  SsoSecretKeyringConfigError,
  isSealedSsoSecret,
  openSsoConfig,
  plaintextSsoSecretPaths,
  redactSsoConfig,
  resealSsoConfig,
  resolveSsoKms,
  sealSsoConfig,
  stripSsoSecrets,
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

// ── Rotation (#3740) ─────────────────────────────────────────────────────────
// Before the keyring, resolveSsoKms loaded one key, so rotating
// AUTH_TOKEN_ENCRYPTION_KEY made every stored token unreadable and every SSO
// sign-in failed. These pin the keyring and the re-seal that retires a key.

const b64 = () => randomBytes(32).toString("base64");

/** Every sealed token's key id in a stored config. */
function tokenKeyIds(stored: string): string[] {
  return [...stored.matchAll(/"enc:v1:([^:"]+):/g)].map((m) => m[1]!);
}

describe("keyring rotation", () => {
  const keyA = b64();
  const keyB = b64();
  const samlSecrets = {
    privateKey: "sp-private",
    spMetadata: { privateKeyPass: "sp-pass" },
    idpMetadata: { encPrivateKey: "idp-enc" },
    cert: "PUBLIC-CERT",
  };

  async function sealedUnderA(): Promise<string> {
    const kmsA = resolveSsoKms({ AUTH_TOKEN_ENCRYPTION_KEY: keyA })!;
    expect(kmsA.keyId).toBe("sso_v1");
    return sealSsoConfig("saml", samlSecrets, kmsA);
  }

  it("opens a token under a retired key listed in SSO_SECRET_PREVIOUS_KEYS", async () => {
    const stored = await sealedUnderA();
    const rotated = resolveSsoKms({
      AUTH_TOKEN_ENCRYPTION_KEY: keyB,
      SSO_SECRET_KEY_ID: "sso_v2",
      SSO_SECRET_PREVIOUS_KEYS: `sso_v1=${keyA}`,
    })!;
    const opened = JSON.parse(await openSsoConfig("saml", stored, rotated));
    expect(opened.privateKey).toBe("sp-private");
    expect(opened.spMetadata.privateKeyPass).toBe("sp-pass");
    expect(opened.idpMetadata.encPrivateKey).toBe("idp-enc");
  });

  it("fails with a named error when the retired key is not in the keyring", async () => {
    const stored = await sealedUnderA();
    const rotated = resolveSsoKms({
      AUTH_TOKEN_ENCRYPTION_KEY: keyB,
      SSO_SECRET_KEY_ID: "sso_v2",
    })!;
    const err = await openSsoConfig("saml", stored, rotated).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SsoSecretKeyMissingError);
    expect((err as SsoSecretKeyMissingError).keyId).toBe("sso_v1");
    expect((err as Error).message).toMatch(/"sso_v1"/);
    expect((err as Error).message).toMatch(/SSO_SECRET_PREVIOUS_KEYS/);
    expect((err as Error).message).not.toContain(keyA);
    expect((err as Error).message).not.toContain(keyB);
  });

  it("re-seals every token under the current key, and the result opens with that key alone", async () => {
    const stored = await sealedUnderA();
    expect(tokenKeyIds(stored)).toEqual(["sso_v1", "sso_v1", "sso_v1"]);
    const rotated = resolveSsoKms({
      AUTH_TOKEN_ENCRYPTION_KEY: keyB,
      SSO_SECRET_KEY_ID: "sso_v2",
      SSO_SECRET_PREVIOUS_KEYS: `sso_v1=${keyA}`,
    })!;
    const resealed = await resealSsoConfig("saml", stored, rotated);
    expect(resealed).not.toBeNull();
    expect(tokenKeyIds(resealed!)).toEqual(["sso_v2", "sso_v2", "sso_v2"]);
    expect(JSON.parse(resealed!).cert).toBe("PUBLIC-CERT");

    const onlyB = resolveSsoKms({
      AUTH_TOKEN_ENCRYPTION_KEY: keyB,
      SSO_SECRET_KEY_ID: "sso_v2",
    })!;
    const opened = JSON.parse(await openSsoConfig("saml", resealed!, onlyB));
    expect(opened.privateKey).toBe("sp-private");
    expect(opened.spMetadata.privateKeyPass).toBe("sp-pass");
    expect(opened.idpMetadata.encPrivateKey).toBe("idp-enc");
  });

  it("has nothing to re-seal when every token is already under the current key", async () => {
    const kmsA = resolveSsoKms({ AUTH_TOKEN_ENCRYPTION_KEY: keyA })!;
    const stored = await sealedUnderA();
    await expect(resealSsoConfig("saml", stored, kmsA)).resolves.toBeNull();
    await expect(resealSsoConfig("oidc", "not json", kmsA)).resolves.toBeNull();
  });

  it("refuses to re-seal a token whose key is missing", async () => {
    const stored = await sealedUnderA();
    const rotated = resolveSsoKms({
      AUTH_TOKEN_ENCRYPTION_KEY: keyB,
      SSO_SECRET_KEY_ID: "sso_v2",
    })!;
    await expect(
      resealSsoConfig("saml", stored, rotated),
    ).rejects.toBeInstanceOf(SsoSecretKeyMissingError);
  });
});

describe("resolveSsoKms keyring validation", () => {
  const key = b64();

  it("rejects a previous key under the current key id", () => {
    expect(() =>
      resolveSsoKms({
        AUTH_TOKEN_ENCRYPTION_KEY: key,
        SSO_SECRET_PREVIOUS_KEYS: `sso_v1=${b64()}`,
      }),
    ).toThrow(SsoSecretKeyringConfigError);
  });

  it("rejects an entry without a key id", () => {
    expect(() =>
      resolveSsoKms({
        AUTH_TOKEN_ENCRYPTION_KEY: key,
        SSO_SECRET_KEY_ID: "sso_v2",
        SSO_SECRET_PREVIOUS_KEYS: b64(),
      }),
    ).toThrow(/not <keyId>=<base64 key>/);
  });

  it("rejects a repeated key id", () => {
    expect(() =>
      resolveSsoKms({
        AUTH_TOKEN_ENCRYPTION_KEY: key,
        SSO_SECRET_KEY_ID: "sso_v3",
        SSO_SECRET_PREVIOUS_KEYS: `sso_v1=${b64()},sso_v1=${b64()}`,
      }),
    ).toThrow(/more than once/);
  });

  it("rejects a key id with a separator in it", () => {
    expect(() =>
      resolveSsoKms({
        AUTH_TOKEN_ENCRYPTION_KEY: key,
        SSO_SECRET_KEY_ID: "a:b",
      }),
    ).toThrow(SsoSecretKeyringConfigError);
  });

  it("names the key id, not the key, when a previous key is the wrong length", () => {
    const short = randomBytes(16).toString("base64");
    let message = "";
    try {
      resolveSsoKms({
        AUTH_TOKEN_ENCRYPTION_KEY: key,
        SSO_SECRET_KEY_ID: "sso_v2",
        SSO_SECRET_PREVIOUS_KEYS: `sso_v1=${short}`,
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/"sso_v1"/);
    expect(message).not.toContain(short);
  });

  it("accepts several previous keys and blank entries, and keys the ring by id", () => {
    const resolved = resolveSsoKms({
      AUTH_TOKEN_ENCRYPTION_KEY: key,
      SSO_SECRET_KEY_ID: "sso_v3",
      SSO_SECRET_PREVIOUS_KEYS: ` sso_v1=${b64()} ,, sso_v2=${b64()} `,
    })!;
    expect([...resolved.keyring!.keys()].sort()).toEqual([
      "sso_v1",
      "sso_v2",
      "sso_v3",
    ]);
    expect(resolved.keyring!.get("sso_v3")).toBe(resolved.adapter);
  });
});

describe("stripSsoSecrets", () => {
  it("removes every secret path and keeps the rest", async () => {
    const stored = await sealSsoConfig(
      "saml",
      {
        privateKey: "k",
        spMetadata: { privateKeyPass: "p", metadata: "<xml/>" },
        cert: "PUBLIC-CERT",
      },
      kms,
    );
    expect(JSON.parse(stripSsoSecrets("saml", stored)!)).toEqual({
      spMetadata: { metadata: "<xml/>" },
      cert: "PUBLIC-CERT",
    });
  });

  it("drops a config that is not a JSON object instead of throwing", () => {
    expect(stripSsoSecrets("oidc", "not json")).toBeNull();
    expect(stripSsoSecrets("oidc", "null")).toBeNull();
    expect(stripSsoSecrets("oidc", "[1]")).toBeNull();
  });
});
