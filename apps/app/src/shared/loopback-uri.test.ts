import { describe, expect, it } from "vitest";
import { parseLoopbackUri } from "./loopback-uri";

describe("parseLoopbackUri", () => {
  it.each([
    "http://127.0.0.1:53682/callback",
    "http://[::1]:53682/callback",
    "http://127.0.0.1:1/",
  ])("accepts %s", (raw) => {
    expect(parseLoopbackUri(raw)).toBe(raw);
  });

  it.each([
    ["a non-loopback host", "http://evil.example:53682/callback"],
    ["a name that resolves anywhere", "http://localhost:53682/callback"],
    ["a loopback-looking subdomain", "http://127.0.0.1.evil.example:5/cb"],
    ["https", "https://127.0.0.1:53682/callback"],
    ["another scheme", "javascript://127.0.0.1:53682/%0aalert(1)"],
    ["a missing port", "http://127.0.0.1/callback"],
    ["port zero", "http://127.0.0.1:0/callback"],
    ["path traversal", "http://127.0.0.1:53682/a/../callback"],
    [
      "encoded traversal the parser rewrites",
      "http://127.0.0.1:53682/a/%2e%2e/cb",
    ],
    ["a backslash", "http://127.0.0.1:53682\\@evil.example/cb"],
    ["userinfo", "http://user:pass@127.0.0.1:53682/callback"],
    [
      "an attacker host behind userinfo",
      "http://127.0.0.1:53682@evil.example/",
    ],
    ["a query", "http://127.0.0.1:53682/callback?code=stolen"],
    ["a fragment", "http://127.0.0.1:53682/callback#x"],
    ["no path", "http://127.0.0.1:53682"],
    ["a relative path", "/callback"],
    ["an empty string", ""],
  ])("refuses %s (negative)", (_label, raw) => {
    expect(parseLoopbackUri(raw)).toBeNull();
  });
});
