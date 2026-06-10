import { describe, it, expect } from "vitest";
import { createAwsKmsAdapter } from "./aws";

describe("createAwsKmsAdapter", () => {
  it("throws a not-implemented error when called with any key ARN", () => {
    expect(() =>
      createAwsKmsAdapter("arn:aws:kms:us-east-2:123456789012:key/test-key"),
    ).toThrow(/AWS KMS adapter is not yet implemented/);
  });

  it("throws regardless of the key ARN format", () => {
    expect(() => createAwsKmsAdapter("")).toThrow(
      /AWS KMS adapter is not yet implemented/,
    );
    expect(() => createAwsKmsAdapter("any-arn")).toThrow(
      /AWS KMS adapter is not yet implemented/,
    );
  });

  it("error message includes instructions to use env provider instead", () => {
    expect(() =>
      createAwsKmsAdapter("arn:aws:kms:us-east-2:123456789012:key/k"),
    ).toThrow(/INGESTION_CRYPTO_PROVIDER=env/);
  });
});
