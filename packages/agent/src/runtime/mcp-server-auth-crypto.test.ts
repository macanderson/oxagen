/**
 * Unit tests for the mcp_servers.auth_config envelope-encryption helpers.
 * These assert the core security property directly: a secret
 * written via encryptMcpAuthConfig() is NOT recoverable from the stored
 * shape without going back through decryptMcpAuthConfig() + the KMS key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// A valid base64-encoded 256-bit key (all-zero, deterministic for tests).
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

describe("mcp-server-auth-crypto", () => {
  const originalKey = process.env.AUTH_TOKEN_ENCRYPTION_KEY;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.AUTH_TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it("encryptMcpAuthConfig(undefined) returns {} without requiring a key", async () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    const { encryptMcpAuthConfig } = await import("./mcp-server-auth-crypto");
    await expect(encryptMcpAuthConfig(undefined)).resolves.toEqual({});
  });

  it("encryptMcpAuthConfig({}) returns {} without requiring a key", async () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    const { encryptMcpAuthConfig } = await import("./mcp-server-auth-crypto");
    await expect(encryptMcpAuthConfig({})).resolves.toEqual({});
  });

  it("throws when secrets are supplied but AUTH_TOKEN_ENCRYPTION_KEY is unset (fail-closed, never plaintext)", async () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    const { encryptMcpAuthConfig } = await import("./mcp-server-auth-crypto");
    await expect(
      encryptMcpAuthConfig({ token: "super-secret-value" }),
    ).rejects.toThrow(/AUTH_TOKEN_ENCRYPTION_KEY/);
  });

  it("encrypts a non-empty auth_config into the { v, kmsKeyId, ciphertext } shape — the raw plaintext never appears in the stored value", async () => {
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const { encryptMcpAuthConfig, MCP_SERVER_AUTH_KEY_ID } = await import(
      "./mcp-server-auth-crypto"
    );

    const plaintext = { token: "super-secret-bearer-token-123" };
    const stored = await encryptMcpAuthConfig(plaintext);

    expect(stored).toMatchObject({ v: 1, kmsKeyId: MCP_SERVER_AUTH_KEY_ID });
    expect(typeof (stored as { ciphertext: string }).ciphertext).toBe("string");
    // The core regression guard: the DB-bound value must not contain the
    // plaintext secret anywhere in its serialized form.
    expect(JSON.stringify(stored)).not.toContain(
      "super-secret-bearer-token-123",
    );
  });

  it("round-trips: decryptMcpAuthConfig(encryptMcpAuthConfig(x)) === x", async () => {
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const { encryptMcpAuthConfig, decryptMcpAuthConfig } = await import(
      "./mcp-server-auth-crypto"
    );

    const plaintext = {
      token: "round-trip-secret",
      "x-api-version": "2026-07-01",
    };
    const stored = await encryptMcpAuthConfig(plaintext);
    const decrypted = await decryptMcpAuthConfig(stored);

    expect(decrypted).toEqual(plaintext);
  });

  it("decryptMcpAuthConfig({}) and decryptMcpAuthConfig(null/undefined) return {}", async () => {
    const { decryptMcpAuthConfig } = await import("./mcp-server-auth-crypto");
    await expect(decryptMcpAuthConfig({})).resolves.toEqual({});
    await expect(decryptMcpAuthConfig(null)).resolves.toEqual({});
    await expect(decryptMcpAuthConfig(undefined)).resolves.toEqual({});
  });

  it("decryptMcpAuthConfig passes through a legacy plaintext row unchanged (pre-backfill back-compat)", async () => {
    const { decryptMcpAuthConfig } = await import("./mcp-server-auth-crypto");
    const legacyPlaintext = { token: "was-never-encrypted" };
    await expect(decryptMcpAuthConfig(legacyPlaintext)).resolves.toEqual(
      legacyPlaintext,
    );
  });

  it("decryptMcpAuthConfig fails a wrong key gracefully (throws — tampered/foreign ciphertext, GCM auth tag mismatch)", async () => {
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const encModule = await import("./mcp-server-auth-crypto");
    const stored = await encModule.encryptMcpAuthConfig({ token: "abc" });

    vi.resetModules();
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = OTHER_KEY;
    const decModule = await import("./mcp-server-auth-crypto");
    await expect(decModule.decryptMcpAuthConfig(stored)).rejects.toThrow();
  });

  it("decryptMcpAuthConfig returns {} (and does not throw) when the key is missing for an encrypted row", async () => {
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = TEST_KEY;
    const encModule = await import("./mcp-server-auth-crypto");
    const stored = await encModule.encryptMcpAuthConfig({ token: "abc" });

    vi.resetModules();
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const decModule = await import("./mcp-server-auth-crypto");
    await expect(decModule.decryptMcpAuthConfig(stored)).resolves.toEqual({});
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("isEncryptedAuthConfig distinguishes the encrypted shape from legacy plaintext", async () => {
    const { isEncryptedAuthConfig } = await import("./mcp-server-auth-crypto");
    expect(
      isEncryptedAuthConfig({ v: 1, kmsKeyId: "k", ciphertext: "abc" }),
    ).toBe(true);
    expect(isEncryptedAuthConfig({ token: "plaintext" })).toBe(false);
    expect(isEncryptedAuthConfig({})).toBe(false);
    expect(isEncryptedAuthConfig(null)).toBe(false);
  });
});
