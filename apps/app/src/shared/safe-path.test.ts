import { describe, expect, it } from "vitest";
import {
  firstParam,
  pathOf,
  readNext,
  routes,
  sanitizeNext,
} from "./safe-path";

const ROOT = routes.root();
const NEW_ORG = routes.newOrganization();

describe("sanitizeNext", () => {
  it("keeps a valid same-origin path with its query and hash", () => {
    expect(sanitizeNext("/acme/core-platform", ROOT)).toBe(
      "/acme/core-platform",
    );
    expect(
      sanitizeNext("/acme/core-platform/tools?tab=registry#top", ROOT),
    ).toBe("/acme/core-platform/tools?tab=registry#top");
  });

  it("keeps the CLI authorize round-trip, whose query carries a loopback URL", () => {
    const next =
      "/cli/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Fcallback&state=s1";
    expect(sanitizeNext(next, ROOT)).toBe(next);
  });

  it.each([
    ["protocol-relative host", "//evil.example"],
    ["protocol-relative host with path", "//evil.example/acme"],
    ["backslash host", "/\\evil"],
    ["backslash host with more slashes", "/\\/evil.example"],
    ["absolute URL", "https://evil"],
    ["absolute URL to this app", "http://localhost:3000/acme"],
    ["javascript: URL", "javascript:alert(1)"],
    ["relative path without a slash", "acme/core-platform"],
    ["tab smuggled between slashes", "/\t/evil.example"],
    ["newline smuggled between slashes", "/\n/evil.example"],
    ["DEL character", "/acme\u007f"],
    ["backslash later in the path", "/acme\\..\\..\\evil"],
    ["dot segments that normalise to a host", "/a/../..//evil.example"],
    ["empty string", ""],
  ])("refuses %s (negative)", (_label, raw) => {
    expect(sanitizeNext(raw, ROOT)).toBe(ROOT);
  });

  it("refuses a destination back into the sign-in flow (negative)", () => {
    expect(sanitizeNext("/login", ROOT)).toBe(ROOT);
    expect(sanitizeNext("/two-factor?next=%2Facme", ROOT)).toBe(ROOT);
    expect(sanitizeNext("/loginx", ROOT)).toBe("/loginx");
  });

  it("refuses null and a value longer than 2048 characters (negative)", () => {
    const longest = `/${"a".repeat(2047)}`;
    expect(sanitizeNext(null, ROOT)).toBe(ROOT);
    expect(sanitizeNext(longest, ROOT)).toBe(longest);
    expect(sanitizeNext(`${longest}a`, ROOT)).toBe(ROOT);
  });

  it("returns the caller's fallback when refusing", () => {
    expect(sanitizeNext("//evil.example", NEW_ORG)).toBe("/new-organization");
  });
});

describe("firstParam", () => {
  it("takes the first of a repeated search param", () => {
    expect(firstParam(["/a", "/b"])).toBe("/a");
    expect(firstParam("/a")).toBe("/a");
    expect(firstParam(undefined)).toBeUndefined();
  });
});

describe("readNext", () => {
  const authorize = "/cli/authorize?state=abc&label=laptop";

  it("honours the CLI's returnTo when next is absent", () => {
    expect(readNext({ returnTo: authorize })).toBe(authorize);
    expect(readNext({ returnTo: ["/a", "/b"] })).toBe("/a");
  });

  it("lets next win when both are present", () => {
    expect(readNext({ next: "/acme", returnTo: authorize })).toBe("/acme");
  });

  it.each([
    ["protocol-relative host", "//evil"],
    ["absolute URL", "https://evil"],
  ])("refuses a %s through returnTo (negative)", (_label, raw) => {
    expect(readNext({ returnTo: raw })).toBe(ROOT);
    expect(readNext({ returnTo: raw }, NEW_ORG)).toBe("/new-organization");
  });

  it("does not fall through to returnTo when next is refused (negative)", () => {
    expect(readNext({ next: "//evil", returnTo: authorize })).toBe(ROOT);
  });

  it("returns the fallback when neither is present", () => {
    expect(readNext({})).toBe(ROOT);
    expect(readNext({}, NEW_ORG)).toBe("/new-organization");
  });
});

describe("routes", () => {
  it("carries a destination forward, encoded, and leaves the link bare for the root", () => {
    const fleet = routes.fleet("acme", "core-platform");
    expect(routes.signup(fleet)).toBe("/signup?next=%2Facme%2Fcore-platform");
    expect(routes.login(ROOT)).toBe("/login");
    expect(routes.login()).toBe("/login");
    expect(routes.loginWithOAuthError("please_restart_the_process")).toBe(
      "/login?error=please_restart_the_process",
    );
    expect(routes.loginWithOAuthError("access_denied", pathOf("acme"))).toBe(
      "/login?next=%2Facme&error=access_denied",
    );
    expect(routes.twoFactor(routes.people("acme"))).toBe(
      "/two-factor?next=%2Facme",
    );
    expect(routes.verify({ email: "a@b.c", next: routes.people("acme") })).toBe(
      "/verify?email=a%40b.c&next=%2Facme",
    );
    expect(routes.newOrganization(routes.cliAuthorize({ state: "s" }))).toBe(
      "/new-organization?next=%2Fcli%2Fauthorize%3Fstate%3Ds",
    );
  });

  it("builds the fixed destinations", () => {
    expect(routes.mfaEnroll()).toBe("/two-factor?enroll=required");
    expect(routes.resetPassword()).toBe("/reset-password");
    expect(routes.invite("invi_1")).toBe("/invite/invi_1");
    expect(routes.cliAuthorize({})).toBe("/cli/authorize");
    expect(routes.people("acme")).toBe("/acme");
    expect(routes.roles("acme")).toBe("/acme/roles");
    expect(routes.billing("acme")).toBe("/acme/billing");
    expect(routes.billing("acme", { cursor: "c 2&x" })).toBe(
      "/acme/billing?cursor=c+2%26x",
    );
    expect(routes.billing("acme", { checkout: "success" })).toBe(
      "/acme/billing?checkout=success",
    );
    expect(routes.billing("acme", { checkout: "cancel" })).toBe(
      "/acme/billing?checkout=cancel",
    );
    expect(routes.steering("acme", "core")).toBe("/acme/core/steering");
    expect(
      routes.steering("acme", "core", {
        tab: "prs",
        offset: "50",
        proposal: "prp_1&x",
      }),
    ).toBe("/acme/core/steering?tab=prs&offset=50&proposal=prp_1%26x");
    expect(routes.repositories("acme", "core")).toBe("/acme/core/repositories");
    expect(routes.repositories("acme", "core", "changes")).toBe(
      "/acme/core/repositories/changes",
    );
  });

  it("percent-encodes every segment, so a slug cannot add a segment or a host", () => {
    expect(pathOf("acme", "a b", "agents")).toBe("/acme/a%20b/agents");
    expect(routes.fleet("a/b", "..")).toBe("/a%2Fb/..");
    expect(routes.people("\\evil")).toBe("/%5Cevil");
    expect(routes.apiKeys("a/b")).toBe("/a%2Fb/api-keys");
    expect(routes.modelFunding("a/b")).toBe("/a%2Fb/model-funding");
  });

  it("carries Fleet's runs cursor as a query and builds a run's path", () => {
    expect(routes.fleet("acme", "core-platform")).toBe("/acme/core-platform");
    expect(routes.fleet("acme", "core-platform", { cursor: "eyJ+/=" })).toBe(
      "/acme/core-platform?cursor=eyJ%2B%2F%3D",
    );
    expect(routes.run("acme", "core-platform", "arun_7k2")).toBe(
      "/acme/core-platform/runs/arun_7k2",
    );
    expect(routes.agents("acme", "core-platform")).toBe(
      "/acme/core-platform/agents",
    );
    expect(routes.agents("acme", "core-platform", { cursor: "c/2" })).toBe(
      "/acme/core-platform/agents?cursor=c%2F2",
    );
    expect(routes.agent("acme", "core-platform", "release-bot")).toBe(
      "/acme/core-platform/agents/release-bot",
    );
    expect(
      routes.agent("acme", "core-platform", "release-bot", {
        tab: "incidents",
        cursor: "c2",
      }),
    ).toBe("/acme/core-platform/agents/release-bot/activity?cursor=c2");
    expect(routes.agentSource("acme", "core-platform", "../evil")).toBe(
      "/acme/core-platform/agents/..%2Fevil/source",
    );
    expect(routes.run("acme", "core-platform", "../../evil")).toBe(
      "/acme/core-platform/runs/..%2F..%2Fevil",
    );
  });

  it.each([
    ["enrollment", "runtime"],
    ["budgets", "permissions"],
    ["mandates", "permissions"],
    ["incidents", "activity"],
    ["runs", "activity"],
  ])("builds the canonical agent section for %s", (alias, canonical) => {
    expect(routes.agent("acme", "core", "bot", { tab: alias })).toBe(
      `/acme/core/agents/bot/${canonical}`,
    );
  });

  it("refuses to build a protocol-relative path from an empty first segment (negative)", () => {
    expect(() => routes.fleet("", "evil.example")).toThrow("unsafe_path");
  });

  it("builds a run and a Spend view with every value encoded", () => {
    expect(routes.run("acme", "core-platform", "arun_01k5")).toBe(
      "/acme/core-platform/runs/arun_01k5",
    );
    expect(routes.spend("acme", "core-platform", { tab: "waste" })).toBe(
      "/acme/core-platform/spend?tab=waste",
    );
    expect(routes.skills("acme", "core-platform")).toBe(
      "/acme/core-platform/steering?tab=skills",
    );
    expect(routes.skills("acme", "core-platform", { cursor: "c 2&x" })).toBe(
      "/acme/core-platform/steering?tab=skills&cursor=c+2%26x",
    );
    expect(
      routes.spend("acme", "core-platform", {
        tab: "agent",
        drill: "acme/core-platform/triage&tab=x",
      }),
    ).toBe(
      "/acme/core-platform/spend?tab=agent&drill=acme%2Fcore-platform%2Ftriage%26tab%3Dx",
    );
    expect(
      routes.spend("acme", "core-platform", {
        tab: "findings",
        finding: "fnd_01k5rtgh",
      }),
    ).toBe("/acme/core-platform/spend?tab=findings&finding=fnd_01k5rtgh");
    expect(() => routes.run("", "x", "arun_1")).toThrow("unsafe_path");
  });
});
