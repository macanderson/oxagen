/**
 * Unit tests for the CLI loopback-OAuth security core.
 *
 * The DB seam (auth.verifications via withSystemDb) is mocked at the module
 * level so no real connection is needed. PKCE/validator/redirect logic is pure
 * and tested directly, including the RFC 7636 Appendix B reference vector so
 * the server stays in lockstep with the CLI's client-side computation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB mock ──────────────────────────────────────────────────────────────────
const insertValues = vi.fn((_values: unknown) => Promise.resolve(undefined));
const deleteReturning = vi.fn(() =>
  Promise.resolve([] as Array<{ value: string; expiresAt: Date }>),
);

const mockTx = {
  insert: vi.fn(() => ({ values: insertValues })),
  delete: vi.fn(() => ({
    where: vi.fn(() => ({ returning: deleteReturning })),
  })),
};

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: async (fn: (tx: typeof mockTx) => Promise<unknown>) =>
      fn(mockTx),
  };
});

import {
  generateCliAuthCode,
  pkceChallengeFromVerifier,
  verifyPkceS256,
  isValidCodeVerifier,
  isValidCodeChallenge,
  isLoopbackRedirectUri,
  createCliAuthCode,
  consumeCliAuthCode,
  CLI_AUTH_CODE_TTL_MS,
  type CliAuthCodeData,
} from "./index";

// RFC 7636 Appendix B reference vector — shared with apps/cli/src/lib/pkce.test.ts
// to prove the client and server compute the identical S256 challenge.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const SAMPLE: CliAuthCodeData = {
  userId: "usr_1",
  orgId: "org_1",
  workspaceId: "wrk_1",
  orgSlug: "acme",
  workspaceSlug: "main",
  codeChallenge: RFC_CHALLENGE,
  redirectUri: "http://127.0.0.1:51789/callback",
  label: "host.local",
};

describe("PKCE S256", () => {
  it("recomputes the RFC 7636 Appendix B challenge from the verifier", () => {
    expect(pkceChallengeFromVerifier(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it("verifies a matching verifier/challenge pair", () => {
    expect(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
  });

  it("rejects a verifier that does not match the challenge", () => {
    const otherVerifier = "ZZZftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(verifyPkceS256(otherVerifier, RFC_CHALLENGE)).toBe(false);
  });

  it("rejects a malformed (too-short) verifier without throwing", () => {
    expect(verifyPkceS256("tooshort", RFC_CHALLENGE)).toBe(false);
  });

  it("rejects a malformed challenge without throwing", () => {
    expect(verifyPkceS256(RFC_VERIFIER, "not-a-valid-challenge")).toBe(false);
  });
});

describe("validators", () => {
  it("isValidCodeVerifier accepts 43–128 unreserved chars", () => {
    expect(isValidCodeVerifier(RFC_VERIFIER)).toBe(true);
    expect(isValidCodeVerifier("a".repeat(43))).toBe(true);
    expect(isValidCodeVerifier("a".repeat(128))).toBe(true);
  });

  it("isValidCodeVerifier rejects out-of-range lengths and bad chars", () => {
    expect(isValidCodeVerifier("a".repeat(42))).toBe(false);
    expect(isValidCodeVerifier("a".repeat(129))).toBe(false);
    expect(isValidCodeVerifier("has spaces and !@#".padEnd(43, "x"))).toBe(
      false,
    );
  });

  it("isValidCodeChallenge requires exactly 43 base64url chars", () => {
    expect(isValidCodeChallenge(RFC_CHALLENGE)).toBe(true);
    expect(isValidCodeChallenge("a".repeat(42))).toBe(false);
    expect(isValidCodeChallenge("a".repeat(44))).toBe(false);
    expect(
      isValidCodeChallenge("contains+slash/and=pad" + "a".repeat(21)),
    ).toBe(false);
  });
});

describe("isLoopbackRedirectUri", () => {
  it("accepts loopback http URLs with an explicit port", () => {
    expect(isLoopbackRedirectUri("http://127.0.0.1:51789/callback")).toBe(true);
    expect(isLoopbackRedirectUri("http://localhost:3000/callback")).toBe(true);
    expect(isLoopbackRedirectUri("http://[::1]:8080/cb")).toBe(true);
  });

  it("rejects non-loopback hosts", () => {
    expect(isLoopbackRedirectUri("http://evil.example.com:80/callback")).toBe(
      false,
    );
    expect(isLoopbackRedirectUri("http://169.254.1.1:80/callback")).toBe(false);
  });

  it("rejects https and missing/invalid ports", () => {
    expect(isLoopbackRedirectUri("https://127.0.0.1:443/callback")).toBe(false);
    expect(isLoopbackRedirectUri("http://127.0.0.1/callback")).toBe(false);
    expect(isLoopbackRedirectUri("http://127.0.0.1:0/callback")).toBe(false);
  });

  it("rejects URLs carrying credentials, query, or fragment", () => {
    expect(isLoopbackRedirectUri("http://user:pass@127.0.0.1:80/cb")).toBe(
      false,
    );
    expect(isLoopbackRedirectUri("http://127.0.0.1:80/cb?x=1")).toBe(false);
    expect(isLoopbackRedirectUri("http://127.0.0.1:80/cb#frag")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isLoopbackRedirectUri("not a url")).toBe(false);
    expect(isLoopbackRedirectUri("")).toBe(false);
  });
});

describe("generateCliAuthCode", () => {
  it("produces a urlsafe random code unique per call", () => {
    const a = generateCliAuthCode();
    const b = generateCliAuthCode();
    expect(a).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(a).not.toBe(b);
  });
});

describe("createCliAuthCode / consumeCliAuthCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteReturning.mockResolvedValue([]);
  });

  it("stores the code under the cli_auth: namespace with the TTL expiry", async () => {
    const now = 1_000_000;
    await createCliAuthCode("CODE123", SAMPLE, now);
    expect(mockTx.insert).toHaveBeenCalledTimes(1);
    const values = insertValues.mock.calls[0]?.[0] as {
      id: string;
      identifier: string;
      value: string;
      expiresAt: Date;
    };
    expect(values.id).toBe("cli_auth:CODE123");
    expect(values.identifier).toBe("cli_auth:CODE123");
    expect(JSON.parse(values.value)).toEqual(SAMPLE);
    expect(values.expiresAt.getTime()).toBe(now + CLI_AUTH_CODE_TTL_MS);
  });

  it("redeems a fresh code and returns its bound scope", async () => {
    const now = 2_000_000;
    deleteReturning.mockResolvedValueOnce([
      { value: JSON.stringify(SAMPLE), expiresAt: new Date(now + 60_000) },
    ]);
    const data = await consumeCliAuthCode("CODE123", now);
    expect(data).toEqual(SAMPLE);
    // Redemption is an atomic delete — that is what makes it single-use.
    expect(mockTx.delete).toHaveBeenCalledTimes(1);
  });

  it("returns null for an unknown/already-redeemed code (no row)", async () => {
    deleteReturning.mockResolvedValueOnce([]);
    const data = await consumeCliAuthCode("missing", 3_000_000);
    expect(data).toBeNull();
  });

  it("returns null for an expired code", async () => {
    const now = 4_000_000;
    deleteReturning.mockResolvedValueOnce([
      { value: JSON.stringify(SAMPLE), expiresAt: new Date(now - 1) },
    ]);
    const data = await consumeCliAuthCode("CODE123", now);
    expect(data).toBeNull();
  });

  it("returns null (no throw) for an unparseable payload", async () => {
    const now = 5_000_000;
    deleteReturning.mockResolvedValueOnce([
      { value: "{not json", expiresAt: new Date(now + 60_000) },
    ]);
    const data = await consumeCliAuthCode("CODE123", now);
    expect(data).toBeNull();
  });
});
