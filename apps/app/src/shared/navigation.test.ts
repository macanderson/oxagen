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

const { parseCheckoutUrl } = await import("./checkout-url");
const { parseLoopbackUri } = await import("./loopback-uri");
const { routes } = await import("./safe-path");
const { parseSlackAuthorizationUrl } = await import(
  "./slack-authorization-url"
);
const {
  permanentRedirectTo,
  redirectTo,
  redirectToCheckout,
  redirectToLoopback,
  redirectToSlackAuthorization,
  responseRedirect,
} = await import("./navigation");

const loopback = parseLoopbackUri("http://127.0.0.1:53682/callback");
if (loopback === null) throw new Error("fixture: loopback URI refused");
const checkout = parseCheckoutUrl(
  "https://checkout.stripe.com/c/pay/cs_test_a1#fidkdWxOYHwnPyd1blpxYHZxWjA0",
);
if (checkout === null) throw new Error("fixture: checkout URL refused");

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

describe("redirectToCheckout", () => {
  it("sends the browser to the Checkout page as parsed", () => {
    expect(() => redirectToCheckout(checkout)).toThrow(
      "NEXT_REDIRECT https://checkout.stripe.com/c/pay/cs_test_a1#fidkdWxOYHwnPyd1blpxYHZxWjA0",
    );
  });
});

describe("redirectToSlackAuthorization", () => {
  it("sends the browser to Slack's authorize page as parsed", () => {
    const authorize = `https://slack.com/oauth/v2/authorize?client_id=123.456&state=${"s".repeat(43)}`;
    const slack = parseSlackAuthorizationUrl(authorize);
    if (slack === null) throw new Error("fixture: Slack authorize URL refused");
    expect(() => redirectToSlackAuthorization(slack)).toThrow(
      `NEXT_REDIRECT ${authorize}`,
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

  it("keeps the visitor's host when the server addresses the request by its own", () => {
    const res = responseRedirect(
      new Request("https://localhost:3000/github/setup?installation_id=1", {
        headers: { host: "app.oxagen.sh" },
      }),
      routes.root(),
    );
    expect(res.headers.get("location")).toBe("https://app.oxagen.sh/");
  });

  it("ignores a Host header that is not a bare host (negative)", () => {
    const res = responseRedirect(
      new Request("https://app.oxagen.sh/github/setup", {
        headers: { host: "evil.example/x" },
      }),
      routes.root(),
    );
    expect(res.headers.get("location")).toBe("https://app.oxagen.sh/");
  });
});
