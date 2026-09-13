import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIXTURE_SESSION_COOKIE,
  FIXTURE_SESSION_VALUE,
  FIXTURE_USER,
} from "@/server/fixture-session";
import { liveShell } from "./adapters/live";
import { SHELL_ENGINE_COOKIE } from "./fixture-switches";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = jar.get(name);
        return value === undefined ? undefined : { name, value };
      },
    }),
}));

beforeEach(() => {
  jar.clear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shellSource", () => {
  it("serves fixture reads and the fixture user in fixture mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "fixture");
    jar.set(FIXTURE_SESSION_COOKIE, FIXTURE_SESSION_VALUE);
    jar.set(SHELL_ENGINE_COOKIE, "down");
    const { shellSource } = await import("./source");
    const { port, userId } = await shellSource();
    expect(userId).toBe(FIXTURE_USER.id);
    expect(port).not.toBe(liveShell);
    expect(
      await port.assistantEngine({
        org: "acme",
        ws: null,
        userId: FIXTURE_USER.id,
      }),
    ).toMatchObject({
      ok: true,
      value: { status: "down" },
    });
  });

  it("has no user in fixture mode without the session cookie", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MC_DATA", "fixture");
    const { shellSource } = await import("./source");
    expect((await shellSource()).userId).toBeNull();
  });

  it("never serves fixtures in a production build, even with MC_DATA=fixture and the cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MC_DATA", "fixture");
    jar.set(FIXTURE_SESSION_COOKIE, FIXTURE_SESSION_VALUE);
    const { shellSource } = await import("./source");
    expect(await shellSource()).toEqual({ port: liveShell, userId: null });
  });

  it("serves live reads when the live source is selected", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MC_DATA", "live");
    const { shellSource } = await import("./source");
    expect((await shellSource()).port).toBe(liveShell);
  });
});
