// The origin every absolute URL in the app's metadata resolves against. The
// cases that matter are the ones that differ per environment: an unset
// override in production must not read as localhost, which is the shape of the
// defect this module closes (#3091).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHostRedirect, getMetadataBase } from "./app-url";

const ENV = { ...process.env };

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  // `NODE_ENV` decides the fallback origin, so a shell that exports
  // `development` (every `next dev` terminal) would otherwise flip the
  // production cases to localhost. Pin it; the one development case
  // stubs over this.
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...ENV };
});

/** The origin `getMetadataBase` resolved, without the URL normaliser's trailing slash. */
const origin = (): string => getMetadataBase().href.replace(/\/$/, "");

describe("the origin getMetadataBase resolves", () => {
  it("takes an explicit override over the environment default", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.staging.oxagen.sh";
    expect(origin()).toBe("https://app.staging.oxagen.sh");
  });

  it("strips trailing slashes from the override", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.oxagen.sh///";
    expect(origin()).toBe("https://app.oxagen.sh");
  });

  it("ignores an override that is blank or whitespace (negative)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "   ";
    expect(origin()).toBe("https://app.oxagen.sh");
  });

  it("falls back to the production origin, not localhost, when nothing is set", () => {
    expect(origin()).toBe("https://app.oxagen.sh");
  });

  it("falls back to the dev server only under NODE_ENV=development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(origin()).toBe("http://localhost:3000");
  });
});

describe("getMetadataBase", () => {
  it("is the override as a URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.oxagen.sh";
    expect(getMetadataBase().href).toBe("https://app.oxagen.sh/");
  });

  it("resolves a relative social image against the override", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.oxagen.sh";
    expect(new URL("/social/og.png", getMetadataBase()).href).toBe(
      "https://app.oxagen.sh/social/og.png",
    );
  });

  it("falls back rather than throwing when the override is not a URL (negative)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "app.oxagen.sh";
    expect(getMetadataBase().href).toBe("https://app.oxagen.sh/");
  });

  it("falls back to the dev server when a malformed override is set in development", () => {
    // A typo in a developer's .env.local must not make their machine advertise
    // the production origin.
    vi.stubEnv("NODE_ENV", "development");
    process.env.NEXT_PUBLIC_APP_URL = "http://:::";
    expect(getMetadataBase().href).toBe("http://localhost:3000/");
  });
});

/** A GET for `pathname` on `host`, as the proxy passes it. */
const visit = (host: string, pathname: string, search = "") => ({
  method: "GET",
  host,
  pathname,
  search,
});

/** Where the visit is sent, or null when it stays. */
const target = (host: string, pathname: string, search = ""): string | null =>
  canonicalHostRedirect(visit(host, pathname, search))?.location.href ?? null;

describe("canonicalHostRedirect once oxagen.app is canonical (ADR-215)", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://oxagen.app";
  });

  it("sends a page on app.oxagen.sh to the same page on oxagen.app, for good", () => {
    const moved = canonicalHostRedirect(
      visit("app.oxagen.sh", "/acme/core-platform/runs", "?tab=live"),
    );
    expect(moved?.location.href).toBe(
      "https://oxagen.app/acme/core-platform/runs?tab=live",
    );
    expect(moved?.permanent).toBe(true);
  });

  it("sends www.oxagen.app to the apex", () => {
    expect(target("www.oxagen.app", "/")).toBe("https://oxagen.app/");
  });

  it("reads the host whatever its case, and with a port", () => {
    expect(target("APP.Oxagen.SH:443", "/acme")).toBe(
      "https://oxagen.app/acme",
    );
  });

  it("moves a HEAD like a GET", () => {
    const moved = canonicalHostRedirect({
      ...visit("app.oxagen.sh", "/acme"),
      method: "HEAD",
    });
    expect(moved?.location.href).toBe("https://oxagen.app/acme");
  });

  it("leaves a visit that is already on oxagen.app (negative)", () => {
    expect(target("oxagen.app", "/acme")).toBeNull();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "leaves a %s, which cannot follow a redirect intact (negative)",
    (method) => {
      expect(
        canonicalHostRedirect({ ...visit("app.oxagen.sh", "/acme"), method }),
      ).toBeNull();
    },
  );

  it.each([
    "/api",
    "/api/auth/callback/github",
    "/api/auth/sso/saml2/sp/acs/acme-entra",
    "/api/scim/v2/Users",
    "/api/v1/runs",
    "/.well-known/oauth-protected-resource",
  ])("keeps %s answering on the old host (negative)", (pathname) => {
    expect(target("app.oxagen.sh", pathname)).toBeNull();
  });

  it("moves a page whose name only starts with api", () => {
    expect(target("app.oxagen.sh", "/apiary")).toBe(
      "https://oxagen.app/apiary",
    );
  });

  it.each([
    "localhost:3000",
    "app.staging.oxagen.sh",
    "docs.oxagen.sh",
    "oxagen.sh",
  ])(
    "leaves %s, which is not a host the production app answers on (negative)",
    (host) => {
      expect(target(host, "/acme")).toBeNull();
    },
  );

  it.each(["//evil.example/x", "/\\evil.example"])(
    "keeps a path shaped like another host on oxagen.app: %s",
    (pathname) => {
      const moved = canonicalHostRedirect(visit("app.oxagen.sh", pathname));
      expect(moved?.location.host).toBe("oxagen.app");
      expect(moved?.location.origin).toBe("https://oxagen.app");
    },
  );
});

describe("canonicalHostRedirect while app.oxagen.sh is canonical", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.oxagen.sh";
  });

  it("sends oxagen.app to app.oxagen.sh, temporarily", () => {
    const moved = canonicalHostRedirect(visit("oxagen.app", "/acme", "?x=1"));
    expect(moved?.location.href).toBe("https://app.oxagen.sh/acme?x=1");
    expect(moved?.permanent).toBe(false);
  });

  it("leaves app.oxagen.sh, which is where visits belong today (negative)", () => {
    expect(target("app.oxagen.sh", "/acme")).toBeNull();
  });

  it("falls back to app.oxagen.sh as canonical when nothing is set", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(target("oxagen.app", "/")).toBe("https://app.oxagen.sh/");
  });
});

describe("canonicalHostRedirect with an origin that is not a production host", () => {
  it.each(["http://localhost:3000", "https://app.staging.oxagen.sh"])(
    "sends nothing from production hosts to %s (negative)",
    (origin) => {
      process.env.NEXT_PUBLIC_APP_URL = origin;
      expect(target("app.oxagen.sh", "/acme")).toBeNull();
      expect(target("oxagen.app", "/acme")).toBeNull();
    },
  );
});
