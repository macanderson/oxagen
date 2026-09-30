// Where a page visit on one of the production app's three names is sent
// (ADR-215). The cases that matter are the ones a redirect would break: a
// machine path, a method that cannot follow one, a host outside production,
// and a path shaped like another host.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalHostRedirect } from "./canonical-host";

const ENV = { ...process.env };

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  // `NODE_ENV` decides the fallback origin, so a shell that exports
  // `development` would otherwise make localhost the canonical origin.
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...ENV };
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
  canonicalHostRedirect(visit(host, pathname, search))?.url ?? null;

describe("canonicalHostRedirect once oxagen.app is canonical", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://oxagen.app";
  });

  it("sends a page on app.oxagen.sh to the same page on oxagen.app, for good", () => {
    const moved = canonicalHostRedirect(
      visit("app.oxagen.sh", "/acme/core-platform/runs", "?tab=live"),
    );
    expect(moved?.url).toBe(
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
    expect(moved?.url).toBe("https://oxagen.app/acme");
  });

  it("leaves a visit that is already on oxagen.app (negative)", () => {
    expect(target("oxagen.app", "/acme")).toBeNull();
  });

  it("leaves oxagen.app however the Host header spells it (negative)", () => {
    // Compared as sent, `OXAGEN.app:443` would get a cached 308 to itself.
    expect(target("OXAGEN.app:443", "/acme")).toBeNull();
  });

  it("builds the target from the origin alone, whatever else the origin carries", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://u:p@oxagen.app/x#y";
    expect(target("app.oxagen.sh", "/acme", "?tab=live")).toBe(
      "https://oxagen.app/acme?tab=live",
    );
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
      const url = target("app.oxagen.sh", pathname);
      expect(url).not.toBeNull();
      expect(new URL(url ?? "").origin).toBe("https://oxagen.app");
    },
  );
});

describe("canonicalHostRedirect while app.oxagen.sh is canonical", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.oxagen.sh";
  });

  it("sends oxagen.app to app.oxagen.sh, temporarily", () => {
    const moved = canonicalHostRedirect(visit("oxagen.app", "/acme", "?x=1"));
    expect(moved?.url).toBe("https://app.oxagen.sh/acme?x=1");
    expect(moved?.permanent).toBe(false);
  });

  it("leaves app.oxagen.sh, which is where visits belong today (negative)", () => {
    expect(target("app.oxagen.sh", "/acme")).toBeNull();
  });

});

describe("canonicalHostRedirect with no usable origin configured", () => {
  it("falls back to oxagen.app as canonical when nothing is set", () => {
    expect(target("app.oxagen.sh", "/")).toBe("https://oxagen.app/");
    expect(target("oxagen.app", "/")).toBeNull();
  });

  it("treats an origin that does not parse as oxagen.app, as the metadata does", () => {
    process.env.NEXT_PUBLIC_APP_URL = "app.oxagen.sh";
    const moved = canonicalHostRedirect(visit("app.oxagen.sh", "/acme"));
    expect(moved?.url).toBe("https://oxagen.app/acme");
    expect(moved?.permanent).toBe(true);
  });
});

describe("canonicalHostRedirect with www.oxagen.app as the origin", () => {
  it("sends a temporary redirect, because only oxagen.app is permanent", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://www.oxagen.app";
    const moved = canonicalHostRedirect(visit("oxagen.app", "/acme"));
    expect(moved?.url).toBe("https://www.oxagen.app/acme");
    expect(moved?.permanent).toBe(false);
  });
});

describe("canonicalHostRedirect with an origin that is not a production host", () => {
  it.each([
    "http://localhost:3000",
    "https://app.staging.oxagen.sh",
    "http://oxagen.app",
    "https://oxagen.app:8443",
  ])("sends nothing from production hosts to %s (negative)", (origin) => {
    process.env.NEXT_PUBLIC_APP_URL = origin;
    expect(target("app.oxagen.sh", "/acme")).toBeNull();
    expect(target("www.oxagen.app", "/acme")).toBeNull();
  });
});
