/**
 * auth-denial.test.ts — unit tests for isAuthDenialError.
 *
 * The helper must recognize the Next.js access-control sentinel (thrown by
 * notFound()/forbidden()/unauthorized()) by its `digest` while treating every
 * genuine runtime error (DB failure, plain Error, non-objects) as NOT a denial.
 * This is the discriminator that keeps an infra outage from masquerading as a
 * permission denial in the security-management server actions.
 */

import { describe, it, expect } from "vitest";
import {
  isAuthDenialError,
  authDenialStatus,
  isNextRedirectError,
} from "./auth-denial";

function withDigest(digest: string): Error {
  const e = new Error("sentinel");
  (e as Error & { digest: string }).digest = digest;
  return e;
}

describe("isAuthDenialError", () => {
  it("recognizes the notFound (404) fallback digest", () => {
    expect(isAuthDenialError(withDigest("NEXT_HTTP_ERROR_FALLBACK;404"))).toBe(
      true,
    );
  });

  it("recognizes the forbidden (403) fallback digest", () => {
    expect(isAuthDenialError(withDigest("NEXT_HTTP_ERROR_FALLBACK;403"))).toBe(
      true,
    );
  });

  it("recognizes the unauthorized (401) fallback digest", () => {
    expect(isAuthDenialError(withDigest("NEXT_HTTP_ERROR_FALLBACK;401"))).toBe(
      true,
    );
  });

  it("returns false for a plain DB/infra Error (no digest)", () => {
    expect(isAuthDenialError(new Error("connection refused"))).toBe(false);
  });

  it("returns false for an error whose digest is an unrelated string (e.g. a redirect)", () => {
    expect(
      isAuthDenialError(withDigest("NEXT_REDIRECT;replace;/login;307")),
    ).toBe(false);
  });

  it("returns false for null / undefined / primitives", () => {
    expect(isAuthDenialError(null)).toBe(false);
    expect(isAuthDenialError(undefined)).toBe(false);
    expect(isAuthDenialError("NEXT_HTTP_ERROR_FALLBACK;404")).toBe(false);
    expect(isAuthDenialError(404)).toBe(false);
  });

  it("returns false when digest is a non-string", () => {
    const e = new Error("x") as Error & { digest: unknown };
    e.digest = 404;
    expect(isAuthDenialError(e)).toBe(false);
  });
});

describe("authDenialStatus", () => {
  it("returns 404 for the notFound fallback digest", () => {
    expect(authDenialStatus(withDigest("NEXT_HTTP_ERROR_FALLBACK;404"))).toBe(
      404,
    );
  });

  it("returns 403 for the forbidden fallback digest", () => {
    expect(authDenialStatus(withDigest("NEXT_HTTP_ERROR_FALLBACK;403"))).toBe(
      403,
    );
  });

  it("defaults to 404 when the fallback digest has no parseable status", () => {
    expect(authDenialStatus(withDigest("NEXT_HTTP_ERROR_FALLBACK"))).toBe(404);
    expect(
      authDenialStatus(withDigest("NEXT_HTTP_ERROR_FALLBACK;notanumber")),
    ).toBe(404);
  });

  it("returns null for a non-denial error (so the caller falls through to 500)", () => {
    expect(authDenialStatus(new Error("connection refused"))).toBeNull();
    expect(
      authDenialStatus(withDigest("NEXT_REDIRECT;replace;/login;307")),
    ).toBeNull();
    expect(authDenialStatus(null)).toBeNull();
  });
});

describe("isNextRedirectError", () => {
  it("recognizes the redirect sentinel digest", () => {
    expect(
      isNextRedirectError(withDigest("NEXT_REDIRECT;replace;/login;307")),
    ).toBe(true);
    expect(isNextRedirectError(withDigest("NEXT_REDIRECT;push;/x;308"))).toBe(
      true,
    );
  });

  it("returns false for the notFound fallback and plain errors", () => {
    expect(
      isNextRedirectError(withDigest("NEXT_HTTP_ERROR_FALLBACK;404")),
    ).toBe(false);
    expect(isNextRedirectError(new Error("boom"))).toBe(false);
    expect(isNextRedirectError(null)).toBe(false);
  });
});
