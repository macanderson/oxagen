import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../envelope";

// vi.hoisted ensures mockSend is available inside the hoisted vi.mock factory.
const mockSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-kms", () => ({
  KMSClient: vi.fn(() => ({ send: mockSend })),
  GenerateDataKeyCommand: vi.fn((params: unknown) => ({
    _type: "GenerateDataKey",
    params,
  })),
  DecryptCommand: vi.fn((params: unknown) => ({ _type: "Decrypt", params })),
}));

import { GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { createAwsKmsAdapter } from "./aws";

const TEST_ARN =
  "arn:aws:kms:us-east-2:578673726240:key/00000000-0000-0000-0000-000000000000";
const KEY_ID = "ingestion:kms:v1";

beforeEach(() => {
  mockSend.mockReset();
});

describe("createAwsKmsAdapter — construction", () => {
  it("throws on an empty key ARN", () => {
    expect(() => createAwsKmsAdapter("")).toThrow(/keyArn must not be empty/);
  });

  it("throws when the ARN has too few segments to contain a region", () => {
    expect(() => createAwsKmsAdapter("not-an-arn")).toThrow(
      /Cannot parse AWS region from KMS ARN/,
    );
  });

  it("creates an adapter without throwing for a valid ARN", () => {
    expect(() => createAwsKmsAdapter(TEST_ARN)).not.toThrow();
  });
});

describe("generateDataKey", () => {
  it("sends GenerateDataKeyCommand with the bound key ARN and AES_256 spec", async () => {
    const dek = randomBytes(32);
    const encryptedDek = randomBytes(200);
    mockSend.mockResolvedValueOnce({
      Plaintext: dek,
      CiphertextBlob: encryptedDek,
    });

    const adapter = createAwsKmsAdapter(TEST_ARN);
    await adapter.generateDataKey(KEY_ID);

    expect(vi.mocked(GenerateDataKeyCommand)).toHaveBeenCalledWith({
      KeyId: TEST_ARN,
      KeySpec: "AES_256",
    });
  });

  it("returns Plaintext as plaintext and CiphertextBlob as encrypted", async () => {
    const dek = randomBytes(32);
    const encryptedDek = randomBytes(200);
    mockSend.mockResolvedValueOnce({
      Plaintext: dek,
      CiphertextBlob: encryptedDek,
    });

    const adapter = createAwsKmsAdapter(TEST_ARN);
    const result = await adapter.generateDataKey(KEY_ID);

    expect(result.plaintext).toBe(dek);
    expect(result.encrypted).toBe(encryptedDek);
  });

  it("throws when KMS returns no Plaintext", async () => {
    mockSend.mockResolvedValueOnce({
      Plaintext: undefined,
      CiphertextBlob: randomBytes(200),
    });

    const adapter = createAwsKmsAdapter(TEST_ARN);
    await expect(adapter.generateDataKey(KEY_ID)).rejects.toThrow(
      /GenerateDataKey returned empty Plaintext or CiphertextBlob/,
    );
  });

  it("throws when KMS returns no CiphertextBlob", async () => {
    mockSend.mockResolvedValueOnce({
      Plaintext: randomBytes(32),
      CiphertextBlob: undefined,
    });

    const adapter = createAwsKmsAdapter(TEST_ARN);
    await expect(adapter.generateDataKey(KEY_ID)).rejects.toThrow(
      /GenerateDataKey returned empty Plaintext or CiphertextBlob/,
    );
  });
});

describe("decryptDataKey", () => {
  it("sends DecryptCommand with the provided ciphertext and bound key ARN", async () => {
    const dek = randomBytes(32);
    const encryptedDek = randomBytes(200);
    mockSend.mockResolvedValueOnce({ Plaintext: dek });

    const adapter = createAwsKmsAdapter(TEST_ARN);
    await adapter.decryptDataKey(encryptedDek, KEY_ID);

    expect(vi.mocked(DecryptCommand)).toHaveBeenCalledWith({
      CiphertextBlob: encryptedDek,
      KeyId: TEST_ARN,
    });
  });

  it("returns the Plaintext DEK from the KMS response", async () => {
    const dek = randomBytes(32);
    mockSend.mockResolvedValueOnce({ Plaintext: dek });

    const adapter = createAwsKmsAdapter(TEST_ARN);
    const result = await adapter.decryptDataKey(randomBytes(200), KEY_ID);

    expect(result).toBe(dek);
  });

  it("throws when KMS returns no Plaintext", async () => {
    mockSend.mockResolvedValueOnce({ Plaintext: undefined });

    const adapter = createAwsKmsAdapter(TEST_ARN);
    await expect(
      adapter.decryptDataKey(randomBytes(200), KEY_ID),
    ).rejects.toThrow(/Decrypt returned empty Plaintext/);
  });
});

describe("round-trip through envelope encryption", () => {
  it("encrypts and decrypts a token through the full envelope layer", async () => {
    const dek = randomBytes(32);
    const encryptedDek = randomBytes(200);
    // envelope.ts zeros the plaintext DEK in its finally block after encrypt().
    // Use an independent copy so the decrypt mock still holds the original key bytes.
    const dekForDecrypt = Buffer.from(dek);

    mockSend
      .mockResolvedValueOnce({ Plaintext: dek, CiphertextBlob: encryptedDek })
      .mockResolvedValueOnce({ Plaintext: dekForDecrypt });

    const adapter = createAwsKmsAdapter(TEST_ARN);
    const ciphertext = await encrypt("oauth-token-value", KEY_ID, { adapter });
    const recovered = await decrypt(ciphertext, KEY_ID, { adapter });

    expect(recovered.toString("utf8")).toBe("oauth-token-value");
    expect(ciphertext.includes(Buffer.from("oauth-token-value", "utf8"))).toBe(
      false,
    );
  });

  it("produces distinct ciphertexts for the same plaintext (fresh IV per call)", async () => {
    // Use separate DEK buffers — envelope.ts zeros each after use.
    const dek1 = randomBytes(32);
    const dek2 = randomBytes(32);

    mockSend
      .mockResolvedValueOnce({
        Plaintext: dek1,
        CiphertextBlob: randomBytes(200),
      })
      .mockResolvedValueOnce({
        Plaintext: dek2,
        CiphertextBlob: randomBytes(200),
      });

    const adapter = createAwsKmsAdapter(TEST_ARN);
    const a = await encrypt("same-input", KEY_ID, { adapter });
    const b = await encrypt("same-input", KEY_ID, { adapter });

    expect(a.equals(b)).toBe(false);
  });
});
