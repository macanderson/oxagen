import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  createIngestionCryptoAdapter,
  resolveIngestionCryptoAdapterForKeyId,
  INGESTION_KEY_ID_ENV,
  INGESTION_KEY_ID_KMS,
} from "./ingestion";
import { encrypt, decrypt } from "./envelope";

const validBase64Key = randomBytes(32).toString("base64");

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  };
  let result: void | Promise<void>;
  try {
    result = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(restore);
  }
  restore();
  return Promise.resolve();
}

afterEach(() => {
  delete process.env["INGESTION_CRYPTO_PROVIDER"];
  delete process.env["INGESTION_ENCRYPTION_KEY"];
  delete process.env["AWS_KMS_INGESTION_KEY_ARN"];
});

describe("createIngestionCryptoAdapter", () => {
  it("returns local adapter with ENV key id when provider=env (default)", () => {
    withEnv(
      {
        INGESTION_CRYPTO_PROVIDER: undefined,
        INGESTION_ENCRYPTION_KEY: validBase64Key,
      },
      () => {
        const result = createIngestionCryptoAdapter();
        expect(result.keyId).toBe(INGESTION_KEY_ID_ENV);
        expect(result.adapter).toBeDefined();
        expect(typeof result.adapter.generateDataKey).toBe("function");
        expect(typeof result.adapter.decryptDataKey).toBe("function");
      },
    );
  });

  it("returns local adapter with ENV key id when INGESTION_CRYPTO_PROVIDER=env explicitly", () => {
    withEnv(
      {
        INGESTION_CRYPTO_PROVIDER: "env",
        INGESTION_ENCRYPTION_KEY: validBase64Key,
      },
      () => {
        const result = createIngestionCryptoAdapter();
        expect(result.keyId).toBe(INGESTION_KEY_ID_ENV);
      },
    );
  });

  it("throws when provider=env and INGESTION_ENCRYPTION_KEY is missing", () => {
    withEnv(
      {
        INGESTION_CRYPTO_PROVIDER: "env",
        INGESTION_ENCRYPTION_KEY: undefined,
      },
      () => {
        expect(() => createIngestionCryptoAdapter()).toThrow(
          /INGESTION_ENCRYPTION_KEY is not set/,
        );
      },
    );
  });

  it("throws when provider=kms and AWS_KMS_INGESTION_KEY_ARN is missing", () => {
    withEnv(
      {
        INGESTION_CRYPTO_PROVIDER: "kms",
        AWS_KMS_INGESTION_KEY_ARN: undefined,
      },
      () => {
        expect(() => createIngestionCryptoAdapter()).toThrow(
          /AWS_KMS_INGESTION_KEY_ARN is not set/,
        );
      },
    );
  });

  it("returns KMS adapter with KMS key id when provider=kms and ARN is supplied", () => {
    withEnv(
      {
        INGESTION_CRYPTO_PROVIDER: "kms",
        AWS_KMS_INGESTION_KEY_ARN:
          "arn:aws:kms:us-east-2:123456789012:key/test-key",
      },
      () => {
        const result = createIngestionCryptoAdapter();
        expect(result.keyId).toBe(INGESTION_KEY_ID_KMS);
        expect(typeof result.adapter.generateDataKey).toBe("function");
        expect(typeof result.adapter.decryptDataKey).toBe("function");
      },
    );
  });

  it("INGESTION_KEY_ID_ENV is the expected constant", () => {
    expect(INGESTION_KEY_ID_ENV).toBe("ingestion:env:v1");
  });

  it("INGESTION_KEY_ID_KMS is the expected constant", () => {
    expect(INGESTION_KEY_ID_KMS).toBe("ingestion:kms:v1");
  });

  it("adapter from env provider can round-trip encryption", async () => {
    await withEnv(
      {
        INGESTION_CRYPTO_PROVIDER: "env",
        INGESTION_ENCRYPTION_KEY: validBase64Key,
      },
      async () => {
        const { adapter, keyId } = createIngestionCryptoAdapter();
        const { plaintext, encrypted } = await adapter.generateDataKey(keyId);
        expect(plaintext.length).toBe(32);
        expect(encrypted.length).toBeGreaterThan(0);

        const recovered = await adapter.decryptDataKey(encrypted, keyId);
        expect(Buffer.from(recovered).equals(plaintext)).toBe(true);
      },
    );
  });
});

describe("resolveIngestionCryptoAdapterForKeyId (decrypt-path routing)", () => {
  it("routes the env keyId to the local adapter regardless of current provider", () => {
    // Simulate a runtime configured for KMS that nonetheless must read an
    // env-wrapped row: routing must follow the STORED keyId, not the env var.
    withEnv(
      {
        INGESTION_CRYPTO_PROVIDER: "kms",
        AWS_KMS_INGESTION_KEY_ARN:
          "arn:aws:kms:us-east-2:123456789012:key/test-key",
        INGESTION_ENCRYPTION_KEY: validBase64Key,
      },
      () => {
        const result =
          resolveIngestionCryptoAdapterForKeyId(INGESTION_KEY_ID_ENV);
        expect(result.keyId).toBe(INGESTION_KEY_ID_ENV);
      },
    );
  });

  it("routes the KMS keyId to the AWS adapter regardless of current provider", () => {
    withEnv(
      {
        INGESTION_CRYPTO_PROVIDER: "env",
        INGESTION_ENCRYPTION_KEY: validBase64Key,
        AWS_KMS_INGESTION_KEY_ARN:
          "arn:aws:kms:us-east-2:123456789012:key/test-key",
      },
      () => {
        const result =
          resolveIngestionCryptoAdapterForKeyId(INGESTION_KEY_ID_KMS);
        expect(result.keyId).toBe(INGESTION_KEY_ID_KMS);
      },
    );
  });

  it("decrypts an env-wrapped envelope after the runtime flips provider to kms (lazy-migration contract)", async () => {
    // 1. Encrypt while provider=env → envelope carries keyId "ingestion:env:v1".
    let cipher: Buffer = Buffer.alloc(0);
    let storedKeyId = "";
    await withEnv(
      {
        INGESTION_CRYPTO_PROVIDER: "env",
        INGESTION_ENCRYPTION_KEY: validBase64Key,
      },
      async () => {
        const w = createIngestionCryptoAdapter();
        storedKeyId = w.keyId;
        cipher = await encrypt("ghp_secret_token", w.keyId, {
          adapter: w.adapter,
        });
      },
    );
    expect(storedKeyId).toBe(INGESTION_KEY_ID_ENV);

    // 2. Runtime now configured for KMS. Routing the global adapter would pick
    //    AWS KMS and fail on the 60-byte env-wrapped DEK; routing by the stored
    //    keyId picks the local adapter and decrypts cleanly.
    await withEnv(
      {
        INGESTION_CRYPTO_PROVIDER: "kms",
        AWS_KMS_INGESTION_KEY_ARN:
          "arn:aws:kms:us-east-2:123456789012:key/test-key",
        INGESTION_ENCRYPTION_KEY: validBase64Key,
      },
      async () => {
        const r = resolveIngestionCryptoAdapterForKeyId(storedKeyId);
        const plain = await decrypt(cipher, storedKeyId, {
          adapter: r.adapter,
        });
        expect(plain.toString("utf8")).toBe("ghp_secret_token");
      },
    );
  });

  it("throws an actionable error (not a length error) when the env keyId's key material is absent", () => {
    withEnv(
      { INGESTION_CRYPTO_PROVIDER: "kms", INGESTION_ENCRYPTION_KEY: undefined },
      () => {
        expect(() =>
          resolveIngestionCryptoAdapterForKeyId(INGESTION_KEY_ID_ENV),
        ).toThrow(/INGESTION_ENCRYPTION_KEY is not set/);
      },
    );
  });

  it("throws an actionable error when the KMS keyId's ARN is absent", () => {
    withEnv(
      {
        INGESTION_CRYPTO_PROVIDER: "env",
        AWS_KMS_INGESTION_KEY_ARN: undefined,
      },
      () => {
        expect(() =>
          resolveIngestionCryptoAdapterForKeyId(INGESTION_KEY_ID_KMS),
        ).toThrow(/AWS_KMS_INGESTION_KEY_ARN is not set/);
      },
    );
  });

  it("throws on an unrecognized keyId", () => {
    withEnv({ INGESTION_ENCRYPTION_KEY: validBase64Key }, () => {
      expect(() =>
        resolveIngestionCryptoAdapterForKeyId("ingestion:bogus:v9"),
      ).toThrow(/unrecognized credential keyId/);
    });
  });
});
