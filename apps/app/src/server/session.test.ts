import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIXTURE_SESSION_COOKIE,
  FIXTURE_SESSION_VALUE,
} from "./fixture-session";

const { cookieJar, getSessionMock, requestHeaders } = vi.hoisted(() => ({
  cookieJar: new Map<string, string>(),
  getSessionMock: vi.fn(),
  requestHeaders: new Headers({ cookie: "better-auth.session_token=abc" }),
}));

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value === undefined ? undefined : { name, value };
      },
    }),
  headers: () => Promise.resolve(requestHeaders),
}));

vi.mock("@oxagen/auth/server", () => ({
  auth: { api: { getSession: getSessionMock } },
}));

import { readSession } from "./session";

beforeEach(() => {
  cookieJar.clear();
  getSessionMock.mockReset();
});

describe("readSession: Better Auth", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_DATA", "");
  });

  it("returns the Better Auth user, normalised", async () => {
    getSessionMock.mockResolvedValue({
      user: { id: "u1", email: "a@b.c", name: "", image: undefined },
      session: { id: "s1" },
    });
    await expect(readSession()).resolves.toEqual({
      source: "better-auth",
      user: { id: "u1", email: "a@b.c", name: null, image: null },
    });
    expect(getSessionMock).toHaveBeenCalledWith({ headers: requestHeaders });
  });

  it("returns null when Better Auth has no session", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(readSession()).resolves.toBeNull();
  });
});

describe("readSession: fixture operator", () => {
  it("signs in the fixture operator in fixture mode, without touching Better Auth", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "fixture");
    cookieJar.set(FIXTURE_SESSION_COOKIE, FIXTURE_SESSION_VALUE);
    const session = await readSession();
    expect(session?.source).toBe("fixture");
    expect(session?.user.id).toBe("usr_marcusbell");
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("is signed out in fixture mode without the cookie, and never falls back to Better Auth", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MC_DATA", "fixture");
    cookieJar.set(FIXTURE_SESSION_COOKIE, "admin");
    await expect(readSession()).resolves.toBeNull();
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it("is unreachable in production: the fixture cookie with MC_DATA=fixture still goes to Better Auth", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_DATA", "fixture");
    cookieJar.set(FIXTURE_SESSION_COOKIE, FIXTURE_SESSION_VALUE);
    getSessionMock.mockResolvedValue(null);
    await expect(readSession()).resolves.toBeNull();
    expect(getSessionMock).toHaveBeenCalledOnce();
  });
});
