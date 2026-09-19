import path from "node:path";
import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import { TIME_ZONE_COOKIE } from "@/shared/time-zone-cookie";
import { loadCatalogs } from "./load-catalogs";

const { cookieGet, cookies } = vi.hoisted(() => {
  const cookieGet = vi.fn<(name: string) => { value: string } | undefined>();
  const cookies = vi.fn(() => Promise.resolve({ get: cookieGet }));
  return { cookieGet, cookies };
});

// getRequestConfig only wraps the factory; unwrap it so the factory runs here.
vi.mock("next-intl/server", () => ({
  getRequestConfig: <T>(factory: T) => factory,
}));

vi.mock("next/headers", () => ({
  cookies,
}));

/** What Next hands the factory; the config reads no request locale. */
const params = { requestLocale: Promise.resolve(undefined) };

const messagesDir = path.join(process.cwd(), "messages");

beforeEach(() => {
  cookieGet.mockReset();
  cookieGet.mockReturnValue(undefined);
  cookies.mockReset();
  cookies.mockImplementation(() => Promise.resolve({ get: cookieGet }));
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

  it("takes the zone from the tz cookie when the value is usable", async () => {
    cookieGet.mockImplementation((name) =>
      name === TIME_ZONE_COOKIE ? { value: "Asia/Tokyo" } : undefined,
    );
    const { default: factory } = await import("./request");
    const config = await factory(params);
    expect(config.timeZone).toBe("Asia/Tokyo");
  });

  it("falls back to Pacific time when the cookie is missing (negative)", async () => {
    const { default: factory } = await import("./request");
    const config = await factory(params);
    expect(config.timeZone).toBe(DEFAULT_TIME_ZONE);
  });

  it("falls back to Pacific time when the cookie is not a usable zone (negative)", async () => {
    cookieGet.mockImplementation((name) =>
      name === TIME_ZONE_COOKIE ? { value: "not a zone" } : undefined,
    );
    const { default: factory } = await import("./request");
    const config = await factory(params);
    expect(config.timeZone).toBe(DEFAULT_TIME_ZONE);
  });

  it("falls back to Pacific time when the cookie store is unavailable (negative)", async () => {
    cookies.mockRejectedValueOnce(new Error("prerender"));
    const { default: factory } = await import("./request");
    const config = await factory(params);
    expect(config.timeZone).toBe(DEFAULT_TIME_ZONE);
  });
});
