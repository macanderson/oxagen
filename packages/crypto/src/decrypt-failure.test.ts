import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { lastingDecryptFailure } from "./decrypt-failure";
import { decrypt, encrypt } from "./envelope";
import { createLocalKmsAdapter } from "./kms/local";

/** An error named the way the AWS SDK names a KMS service exception. */
function kmsError(name: string): Error {
  const err = new Error(`KMS said ${name}`);
  err.name = name;
  return err;
}

describe("lastingDecryptFailure", () => {
  it("reads a destroyed, disabled or pending-deletion KMS key as lasting for the key", () => {
    for (const name of [
      "DisabledException",
      "KMSInvalidStateException",
      "NotFoundException",
    ]) {
      expect({ name, lasting: lastingDecryptFailure(kmsError(name)) }).toEqual({
        name,
        lasting: "key",
      });
    }
  });

  // Finding P2-A of the ADR-182 fifth review: one damaged envelope marked its
  // whole key gone, and every other body under the deployment KEK with it.
  it("reads a data key KMS refuses as lasting for that body only", () => {
    for (const name of [
      "InvalidCiphertextException",
      "IncorrectKeyException",
    ]) {
      expect({ name, lasting: lastingDecryptFailure(kmsError(name)) }).toEqual({
        name,
        lasting: "body",
      });
    }
  });

  it("reads a data key that no longer opens under the local key as lasting for that body", async () => {
    const sealed = await encrypt("the prompt", "local", {
      adapter: createLocalKmsAdapter(randomBytes(32)),
    });
    const destroyed = createLocalKmsAdapter(randomBytes(32));
    const failure = await decrypt(sealed, "local", { adapter: destroyed }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(lastingDecryptFailure(failure)).toBe("body");
  });

  it("reads a tampered payload under a key that still works as lasting for that body", async () => {
    const adapter = createLocalKmsAdapter(randomBytes(32));
    const sealed = await encrypt("the prompt", "local", { adapter });
    const tampered = Buffer.from(sealed);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    const failure = await decrypt(tampered, "local", { adapter }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(lastingDecryptFailure(failure)).toBe("body");
    await expect(decrypt(sealed, "local", { adapter })).resolves.toEqual(
      Buffer.from("the prompt"),
    );
  });

  it("reads a throttle, a timeout and a non-error as failures that may pass (negative)", () => {
    expect(lastingDecryptFailure(kmsError("ThrottlingException"))).toBeNull();
    expect(lastingDecryptFailure(kmsError("KMSInternalException"))).toBeNull();
    expect(lastingDecryptFailure(new Error("timeout"))).toBeNull();
    expect(lastingDecryptFailure("NotFoundException")).toBeNull();
  });
});
