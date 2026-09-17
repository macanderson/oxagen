import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getAppBaseUrl, getMetadataBase } from "./app-url";

const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_APP_URL;
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe("getAppBaseUrl", () => {
  it("prefers NEXT_PUBLIC_APP_URL and strips a trailing slash", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://preview-app.oxagen.sh/");
    expect(getAppBaseUrl()).toBe("https://preview-app.oxagen.sh");
  });

  it("falls back to localhost:3000 in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(getAppBaseUrl()).toBe("http://localhost:3000");
  });

  it("falls back to app.oxagen.sh outside development", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(getAppBaseUrl()).toBe("https://app.oxagen.sh");
  });
});

describe("getMetadataBase", () => {
  it("returns the origin as a URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.oxagen.sh");
    expect(getMetadataBase().href).toBe("https://app.oxagen.sh/");
  });

  it("survives an override that is not a URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "app.oxagen.sh");
    expect(getMetadataBase().href).toBe("https://app.oxagen.sh/");
  });
});
