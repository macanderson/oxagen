import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { resolveCredentialKms } from "./kms";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

describe("resolveCredentialKms", () => {
  const prev = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  beforeEach(() => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.AUTH_TOKEN_ENCRYPTION_KEY = prev;
  });

  it("returns null when no key is configured", () => {
    expect(resolveCredentialKms()).toBeNull();
  });

  it("returns an adapter when a valid key is configured", () => {
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = VALID_KEY;
    const kms = resolveCredentialKms();
    expect(kms).not.toBeNull();
    expect(typeof kms!.adapter.generateDataKey).toBe("function");
    expect(kms!.keyId).toBe("mcp_cred_v1");
  });
});
