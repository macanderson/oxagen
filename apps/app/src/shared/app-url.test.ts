// The origin every absolute URL in the app's metadata resolves against. The
// cases that matter are the ones that differ per environment: an unset
// override in production must not read as localhost, which is the shape of the
// defect this module closes (#3091).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMetadataBase } from "./app-url";

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
