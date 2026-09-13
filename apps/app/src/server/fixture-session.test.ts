import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIXTURE_SESSION_VALUE,
  FIXTURE_USER,
  isFixtureMode,
  readFixtureSession,
} from "./fixture-session";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readFixtureSession", () => {
  it("signs in the fixture operator in fixture mode outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "fixture");
    expect(isFixtureMode()).toBe(true);
    expect(readFixtureSession(FIXTURE_SESSION_VALUE)).toEqual({
      user: FIXTURE_USER,
    });
  });

  it("is impossible in a production build, even with MC_DATA=fixture", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_DATA", "fixture");
    expect(isFixtureMode()).toBe(false);
    expect(readFixtureSession(FIXTURE_SESSION_VALUE)).toBeNull();
  });

  it("ignores the cookie when the live data source is selected", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "live");
    expect(readFixtureSession(FIXTURE_SESSION_VALUE)).toBeNull();
    vi.stubEnv("MC_DATA", "");
    expect(readFixtureSession(FIXTURE_SESSION_VALUE)).toBeNull();
  });

  it("ignores a missing or forged cookie value", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MC_DATA", "fixture");
    expect(readFixtureSession(undefined)).toBeNull();
    expect(readFixtureSession("admin")).toBeNull();
  });
});
