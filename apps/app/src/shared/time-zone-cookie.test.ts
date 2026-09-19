import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";
import { describe, expect, it } from "vitest";
import {
  isTimeZone,
  readTimeZoneCookie,
  resolveTimeZoneCookie,
  TIME_ZONE_COOKIE,
  timeZoneCookieOptions,
  timeZoneCookieString,
} from "./time-zone-cookie";

describe("isTimeZone", () => {
  it("accepts IANA names this runtime can format in", () => {
    expect(isTimeZone("America/Los_Angeles")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Europe/London")).toBe(true);
  });

  it("rejects garbage and empty strings (negative)", () => {
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone("not a zone")).toBe(false);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe("resolveTimeZoneCookie", () => {
  it("returns a usable value unchanged", () => {
    expect(resolveTimeZoneCookie("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("falls back to Pacific time for missing or unusable values (negative)", () => {
    expect(resolveTimeZoneCookie(undefined)).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZoneCookie(null)).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZoneCookie("not a zone")).toBe(DEFAULT_TIME_ZONE);
  });
});

describe("readTimeZoneCookie", () => {
  it("reads the tz cookie among others and decodes it", () => {
    expect(readTimeZoneCookie("a=1; tz=Europe%2FLondon; b=2")).toBe(
      "Europe/London",
    );
  });

  it("falls back when the cookie is absent (negative)", () => {
    expect(readTimeZoneCookie("theme=dark")).toBe(DEFAULT_TIME_ZONE);
    expect(readTimeZoneCookie("")).toBe(DEFAULT_TIME_ZONE);
  });
});

describe("timeZoneCookieString", () => {
  it("writes a year-long, lax cookie, secure only over https", () => {
    expect(timeZoneCookieString("Europe/London", false)).toBe(
      `${TIME_ZONE_COOKIE}=Europe%2FLondon; Path=/; Max-Age=31536000; SameSite=Lax`,
    );
    expect(timeZoneCookieString("UTC", true)).toMatch(/; Secure$/);
  });
});

describe("timeZoneCookieOptions", () => {
  it("matches the string form for cookies().set", () => {
    expect(timeZoneCookieOptions(false)).toEqual({
      path: "/",
      maxAge: 31536000,
      sameSite: "lax",
      secure: false,
    });
    expect(timeZoneCookieOptions(true).secure).toBe(true);
  });
});
