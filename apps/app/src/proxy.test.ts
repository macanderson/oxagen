import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { isPublicPath, proxy } from "./proxy";

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
    "/new-organization",
    "/cli/authorizex",
    "/github/setupx",
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
    const target = new URL(res.headers.get("location") ?? "");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe(
      "/acme/core-platform/tools?tab=registry",
    );
  });

  it("sends a signed-out organization-creation visit to /login and back", () => {
    const res = proxy(request("/new-organization"));
    const target = new URL(res.headers.get("location") ?? "");
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe("/new-organization");
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

  it("redirects a cookie that is not a session token (negative)", () => {
    expect(
      proxy(request("/acme/core-platform", "theme=dark; operator=marcus"))
        .status,
    ).toBe(307);
  });
});
