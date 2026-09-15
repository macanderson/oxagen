import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
  permanentRedirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT 308 ${to}`);
  }),
}));
vi.mock("next/navigation", () => nav);

const { parseLoopbackUri } = await import("./loopback-uri");
const { routes } = await import("./safe-path");
const {
  permanentRedirectTo,
  redirectTo,
  redirectToLoopback,
  responseRedirect,
} = await import("./navigation");

const loopback = parseLoopbackUri("http://127.0.0.1:53682/callback");
if (loopback === null) throw new Error("fixture: loopback URI refused");

beforeEach(() => {
  nav.redirect.mockClear();
  nav.permanentRedirect.mockClear();
});

describe("redirectTo", () => {
  it("redirects to the path", () => {
    expect(() => redirectTo(routes.login(routes.people("acme")))).toThrow(
      "NEXT_REDIRECT /login?next=%2Facme",
    );
  });

  it("308s with permanentRedirectTo", () => {
    expect(() => permanentRedirectTo(routes.fleet("acme", "core"))).toThrow(
      "NEXT_REDIRECT 308 /acme/core",
    );
  });
});

describe("redirectToLoopback", () => {
  it("carries the code and the state", () => {
    expect(() =>
      redirectToLoopback(loopback, { code: "c o+de", state: "st_1" }),
    ).toThrow(
      "NEXT_REDIRECT http://127.0.0.1:53682/callback?code=c+o%2Bde&state=st_1",
    );
  });

  it("carries a refusal and the state", () => {
    expect(() =>
      redirectToLoopback(loopback, { error: "access_denied", state: "st_1" }),
    ).toThrow(
      "NEXT_REDIRECT http://127.0.0.1:53682/callback?error=access_denied&state=st_1",
    );
  });
});

describe("responseRedirect", () => {
  it("answers 307 to the path on the request's origin", () => {
    const res = responseRedirect(
      new Request("https://app.oxagen.sh/github/setup?installation_id=1"),
      routes.root(),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.oxagen.sh/");
  });

  it("answers 308 when asked for a permanent move", () => {
    const res = responseRedirect(
      new Request("https://app.oxagen.sh/acme/members"),
      routes.people("acme"),
      308,
    );
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://app.oxagen.sh/acme");
  });
});
