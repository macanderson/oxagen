import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIXTURE_SESSION_COOKIE,
  FIXTURE_SESSION_VALUE,
  FIXTURE_USER,
} from "@/server/fixture-session";

const cookieJar = new Map<string, string>();
const getSession = vi.fn();

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T>(fn: T) => fn,
}));
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined,
    }),
  headers: () =>
    Promise.resolve(new Headers({ cookie: "better-auth.session_token=abc" })),
}));
vi.mock("@oxagen/auth/server", () => ({ auth: { api: { getSession } } }));

const { getAuthUser } = await import("./session");

beforeEach(() => {
  cookieJar.clear();
  getSession.mockReset();
});

describe("getAuthUser", () => {
  it("returns the fixture operator for the fixture cookie in fixture mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "fixture");
    cookieJar.set(FIXTURE_SESSION_COOKIE, FIXTURE_SESSION_VALUE);
    await expect(getAuthUser()).resolves.toEqual({ ...FIXTURE_USER });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("ignores a Better Auth session in fixture mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "fixture");
    getSession.mockResolvedValue({
      user: { id: "u1", email: "x@y.z", name: "X" },
    });
    await expect(getAuthUser()).resolves.toBeNull();
  });

  it("never honours the fixture cookie in a production build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_DATA", "fixture");
    cookieJar.set(FIXTURE_SESSION_COOKIE, FIXTURE_SESSION_VALUE);
    getSession.mockResolvedValue(null);
    await expect(getAuthUser()).resolves.toBeNull();
    expect(getSession).toHaveBeenCalledOnce();
  });

  it("reads the Better Auth session from the request headers outside fixture mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "live");
    getSession.mockResolvedValue({
      user: {
        id: "u1",
        email: "priya@acme.example",
        name: "Priya",
        image: null,
      },
    });
    await expect(getAuthUser()).resolves.toEqual({
      id: "u1",
      email: "priya@acme.example",
      name: "Priya",
    });
    const call = getSession.mock.calls[0]?.[0] as { headers: Headers };
    expect(call.headers.get("cookie")).toContain("session_token");
  });
});
