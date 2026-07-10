/**
 * Unit tests for the CLI's client-side PKCE helpers.
 *
 * The RFC 7636 Appendix B reference vector is asserted here AND in
 * packages/auth/src/cli-auth/cli-auth.test.ts — if these two ever diverge, the
 * challenge the CLI sends won't match what the server recomputes at exchange
 * and every login breaks. Keep both pinned to the same vector.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  generateCodeVerifier,
  codeChallengeS256,
  generateState,
} from "../pkce";

const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("codeChallengeS256", () => {
  it("matches the RFC 7636 Appendix B reference vector", () => {
    expect(codeChallengeS256(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it("is BASE64URL(SHA256(ASCII(verifier)))", () => {
    const v = generateCodeVerifier();
    const expected = createHash("sha256")
      .update(v, "ascii")
      .digest("base64url");
    expect(codeChallengeS256(v)).toBe(expected);
  });
});

describe("generateCodeVerifier", () => {
  it("produces a 43-char unreserved-charset verifier", () => {
    const v = generateCodeVerifier();
    expect(v).toHaveLength(43);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("is unique per call", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });
});

describe("generateState", () => {
  it("produces a urlsafe token, unique per call", () => {
    const s = generateState();
    expect(s).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(generateState()).not.toBe(s);
  });
});
