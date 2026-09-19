import path from "node:path";
import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import { loadCatalogs } from "./load-catalogs";

// Every request read this config could make is recorded, so the case below can
// assert it makes none. The root layout awaits `getTranslations`, so this
// factory runs for every route including the static ones, and one `cookies()`
// or `headers()` call in here stops the whole app prerendering.
const { cookies, headers } = vi.hoisted(() => ({
  cookies: vi.fn(() => Promise.resolve({ get: () => undefined })),
  headers: vi.fn(() => Promise.resolve({ get: () => null })),
}));

// getRequestConfig only wraps the factory; unwrap it so the factory runs here.
vi.mock("next-intl/server", () => ({
  getRequestConfig: <T>(factory: T) => factory,
}));

vi.mock("next/headers", () => ({ cookies, headers }));

/** What Next hands the factory; the config reads no request locale. */
const params = { requestLocale: Promise.resolve(undefined) };

const messagesDir = path.join(process.cwd(), "messages");

beforeEach(() => {
  cookies.mockClear();
  headers.mockClear();
});

describe("i18n request config", () => {
  it("serves English with every catalog under messages/ merged", async () => {
    const { default: factory } = await import("./request");
    const config = await factory(params);

    expect(config.locale).toBe("en");
    expect(config.messages).toEqual(loadCatalogs(messagesDir));
    // en.json is always part of the merge, whatever page catalogs exist.
    expect(config.messages).toMatchObject(en);
  });

  it("reads the directory once per process outside development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { default: factory } = await import("./request");
    const first = await factory(params);
    const second = await factory(params);
    expect(second.messages).toBe(first.messages);
  });

  it("re-reads the directory in development so a new catalog shows on refresh", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { default: factory } = await import("./request");
    const first = (await factory(params)).messages;
    const second = (await factory(params)).messages;
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it("serves Pacific time, the same default the store and the shell fall back to", async () => {
    const { default: factory } = await import("./request");
    expect((await factory(params)).timeZone).toBe(DEFAULT_TIME_ZONE);
  });

  // This is the case that earns the file. The viewer's own zone arrives
  // through <ViewerClock>, inside the <Suspense> in [org]/layout.tsx, and it
  // cannot arrive through here. The root layout awaits `getTranslations`, so
  // this factory runs while every static route prerenders; under Cache
  // Components a request read outside <Suspense> aborts that prerender rather
  // than throwing, so a try/catch around it catches nothing and the build
  // fails on the first static route (`/_not-found`), which is what happened.
  it("reads nothing off the request, so every static route can still prerender", async () => {
    const { default: factory } = await import("./request");
    const config = await factory(params);

    expect(cookies).not.toHaveBeenCalled();
    expect(headers).not.toHaveBeenCalled();
    // And it answers fully without them.
    expect(config.locale).toBe("en");
    expect(config.timeZone).toBe(DEFAULT_TIME_ZONE);
    expect(config.messages).toBeTruthy();
  });
});
