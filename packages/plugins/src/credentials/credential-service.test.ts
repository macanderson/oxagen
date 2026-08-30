import { describe, expect, it } from "vitest";
import { createLocalKmsAdapter, loadMasterKey } from "@oxagen/crypto/kms";
import {
  encryptCredentialSecrets,
  decryptCredentialSecrets,
  MCP_CREDENTIAL_KEY_ID,
} from "./credential-service";

const kms = {
  adapter: createLocalKmsAdapter(
    loadMasterKey(Buffer.alloc(32, 9).toString("base64")),
  ),
  keyId: MCP_CREDENTIAL_KEY_ID,
};

describe("credential-service", () => {
  it("round-trips access + refresh + secret tokens", async () => {
    const enc = await encryptCredentialSecrets(
      {
        accessToken: "at-123",
        refreshToken: "rt-456",
        secret: null,
        oauthClientSecret: null,
      },
      kms,
    );
    expect(enc.tokenKmsKeyId).toBe(MCP_CREDENTIAL_KEY_ID);
    expect(Buffer.isBuffer(enc.accessTokenEnc)).toBe(true);
    expect(enc.secretEnc).toBeNull();

    const dec = await decryptCredentialSecrets(
      {
        tokenKmsKeyId: enc.tokenKmsKeyId,
        accessTokenEnc: enc.accessTokenEnc,
        refreshTokenEnc: enc.refreshTokenEnc,
        secretEnc: enc.secretEnc,
        oauthClientSecretEnc: enc.oauthClientSecretEnc,
      },
      kms,
    );
    expect(dec.accessToken).toBe("at-123");
    expect(dec.refreshToken).toBe("rt-456");
    expect(dec.secret).toBeNull();
  });

  it("encrypts a header secret for the secret auth kind", async () => {
    const enc = await encryptCredentialSecrets(
      {
        accessToken: null,
        refreshToken: null,
        secret: "sk-live-789",
        oauthClientSecret: null,
      },
      kms,
    );
    expect(Buffer.isBuffer(enc.secretEnc)).toBe(true);
    const dec = await decryptCredentialSecrets(
      { tokenKmsKeyId: enc.tokenKmsKeyId, secretEnc: enc.secretEnc },
      kms,
    );
    expect(dec.secret).toBe("sk-live-789");
  });

  it("returns null plaintext when no kms key id is present", async () => {
    const dec = await decryptCredentialSecrets(
      { tokenKmsKeyId: null, accessTokenEnc: Buffer.from("x") },
      kms,
    );
    expect(dec.accessToken).toBeNull();
  });
});
