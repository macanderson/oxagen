import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isLastingDecryptFailure } from "./decrypt-failure";
import { decrypt, encrypt } from "./envelope";
import { createLocalKmsAdapter } from "./kms/local";

/** An error named the way the AWS SDK names a KMS service exception. */
function kmsError(name: string): Error {
  const err = new Error(`KMS said ${name}`);
  err.name = name;
  return err;
}

describe("isLastingDecryptFailure", () => {
  it("reads a destroyed, disabled or foreign KMS key as lasting", () => {
    for (const name of [
      "DisabledException",
      "KMSInvalidStateException",
      "NotFoundException",
      "InvalidCiphertextException",
      "IncorrectKeyException",
    ]) {
      expect({
        name,
        lasting: isLastingDecryptFailure(kmsError(name)),
      }).toEqual({ name, lasting: true });
    }
  });

  it("reads a data key that no longer opens under the local key as lasting", async () => {
    const sealed = await encrypt("the prompt", "local", {
      adapter: createLocalKmsAdapter(randomBytes(32)),
    });
    const destroyed = createLocalKmsAdapter(randomBytes(32));
    const failure = await decrypt(sealed, "local", { adapter: destroyed }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(isLastingDecryptFailure(failure)).toBe(true);
  });

  it("reads a throttle, a timeout and a non-error as failures that may pass (negative)", () => {
    expect(isLastingDecryptFailure(kmsError("ThrottlingException"))).toBe(
      false,
    );
    expect(isLastingDecryptFailure(kmsError("KMSInternalException"))).toBe(
      false,
    );
    expect(isLastingDecryptFailure(new Error("timeout"))).toBe(false);
    expect(isLastingDecryptFailure("NotFoundException")).toBe(false);
  });
});
