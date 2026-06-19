/**
 * Unit tests for resolveBaseURL in @oxagen/auth client.
 *
 * resolveBaseURL picks the better-auth client baseURL across three runtime
 * contexts, each of which previously broke in production:
 *   - browser: must use window.location.origin (no env var needed).
 *   - SSR: must use the NORMALIZED BETTER_AUTH_URL from loadEnv() so an
 *     over-quoted Vercel value (`"http://..."` with literal quotes) is stripped
 *     before better-auth parses it — passing the raw value yields "Invalid URL".
 *   - build time: loadEnv() can throw when the full env is absent; we must fall
 *     back to undefined rather than crash module evaluation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { loadEnvMock } = vi.hoisted(() => ({ loadEnvMock: vi.fn() }));
vi.mock("@oxagen/config/env", () => ({ loadEnv: loadEnvMock }));

import { resolveBaseURL } from "./client";

type MutableGlobal = { window?: { location?: { origin?: string } } };

describe("resolveBaseURL", () => {
  const g = globalThis as MutableGlobal;
  const originalWindow = g.window;

  beforeEach(() => {
    loadEnvMock.mockReset();
    delete g.window;
  });

  afterEach(() => {
    if (originalWindow === undefined) delete g.window;
    else g.window = originalWindow;
  });

  it("uses window.location.origin in the browser", () => {
    g.window = { location: { origin: "https://app.example.com" } };
    expect(resolveBaseURL()).toBe("https://app.example.com");
    // loadEnv must not be consulted once a browser origin is available.
    expect(loadEnvMock).not.toHaveBeenCalled();
  });

  it("uses the normalized BETTER_AUTH_URL on the server", () => {
    loadEnvMock.mockReturnValue({ BETTER_AUTH_URL: "http://localhost:3000" });
    expect(resolveBaseURL()).toBe("http://localhost:3000");
    expect(loadEnvMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when loadEnv throws (build time)", () => {
    loadEnvMock.mockImplementation(() => {
      throw new Error("env not present at build time");
    });
    expect(resolveBaseURL()).toBeUndefined();
  });

  it("falls back to undefined when window has no location origin", () => {
    g.window = {};
    loadEnvMock.mockReturnValue({ BETTER_AUTH_URL: "http://localhost:3000" });
    expect(resolveBaseURL()).toBe("http://localhost:3000");
  });
});
