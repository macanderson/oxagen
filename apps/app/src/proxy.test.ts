import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIXTURE_SESSION_COOKIE,
  FIXTURE_SESSION_VALUE,
} from "@/server/fixture-session";
import { isPublicPath, proxy } from "./proxy";

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    headers: cookie ? { cookie } : {},
  });
}

describe("isPublicPath", () => {
  it.each([
    "/login",
    "/signup",
    "/verify",
    "/two-factor",
    "/forgot-password",
    "/reset-password",
    "/invite/tok_123",
    "/api/auth/get-session",
    "/cli/authorize",
    "/github/setup",
  ])("%s is public", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each([
    "/",
    "/acme",
    "/acme/core-platform",
    "/loginx",
    "/invite",
    "/api/mc/acme/core-platform/stream",
  ])("%s is gated", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe("proxy", () => {
  it("lets public paths through without a session", () => {
    const res = proxy(request("/login"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects a gated path to /login and remembers where the user was going", () => {
    const res = proxy(request("/acme/core-platform/tools?tab=registry"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe(
      "/acme/core-platform/tools?tab=registry",
    );
  });

  it("does not add next= for the root path", () => {
    const res = proxy(request("/"));
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });

  it("accepts a Better Auth session cookie, secure prefix included", () => {
    expect(
      proxy(request("/acme", "better-auth.session_token=abc")).headers.get(
        "location",
      ),
    ).toBeNull();
    expect(
      proxy(
        request("/acme", "__Secure-better-auth.session_token=abc"),
      ).headers.get("location"),
    ).toBeNull();
  });

  it("rejects an empty session cookie", () => {
    expect(proxy(request("/acme", "better-auth.session_token=")).status).toBe(
      307,
    );
  });

  it("accepts the fixture session only in fixture mode outside production", () => {
    const cookie = `${FIXTURE_SESSION_COOKIE}=${FIXTURE_SESSION_VALUE}`;
    vi.stubEnv("MC_DATA", "fixture");
    vi.stubEnv("NODE_ENV", "development");
    expect(
      proxy(request("/acme/core-platform", cookie)).headers.get("location"),
    ).toBeNull();

    vi.stubEnv("NODE_ENV", "production");
    expect(proxy(request("/acme/core-platform", cookie)).status).toBe(307);
  });
});
