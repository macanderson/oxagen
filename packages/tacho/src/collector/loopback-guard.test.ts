import { describe, expect, it } from "vitest";
import {
  guardLoopbackRequest,
  isAllowedHostHeader,
  isAllowedOrigin,
} from "./loopback-guard";

const PORT = 45231;

describe("Host header", () => {
  it("accepts the loopback names a real client dials", () => {
    for (const host of [
      `127.0.0.1:${PORT}`,
      `localhost:${PORT}`,
      `[::1]:${PORT}`,
      "127.0.0.1",
      "localhost",
      `LOCALHOST:${PORT}`,
      `127.0.0.53:${PORT}`,
    ]) {
      expect(isAllowedHostHeader(host, PORT), host).toBe(true);
    }
  });

  it("refuses a rebound request, which is the attack this exists for", () => {
    // The page asked for evil.example, whose second DNS answer is 127.0.0.1.
    // The packets arrive here; the Host header does not lie.
    for (const host of [
      `evil.example:${PORT}`,
      `oxagen.sh:${PORT}`,
      `localhost.evil.example:${PORT}`,
      `127.0.0.1.evil.example:${PORT}`,
      `notlocalhost:${PORT}`,
    ]) {
      expect(isAllowedHostHeader(host, PORT), host).toBe(false);
    }
  });

  it("refuses a loopback name on somebody else's port", () => {
    expect(isAllowedHostHeader(`127.0.0.1:${PORT + 1}`, PORT)).toBe(false);
    expect(isAllowedHostHeader("localhost:80", PORT)).toBe(false);
  });

  it("refuses a missing or malformed Host", () => {
    expect(isAllowedHostHeader(undefined, PORT)).toBe(false);
    expect(isAllowedHostHeader("", PORT)).toBe(false);
    expect(isAllowedHostHeader("127.0.0.1:not-a-port", PORT)).toBe(false);
    expect(isAllowedHostHeader("[::1", PORT)).toBe(false);
  });

  it("takes any loopback port when the listener has none of its own", () => {
    expect(isAllowedHostHeader("localhost:80", undefined)).toBe(true);
    expect(isAllowedHostHeader(`evil.example:${PORT}`, undefined)).toBe(false);
  });

  it("does not treat a non-loopback IP as loopback", () => {
    expect(isAllowedHostHeader(`10.0.0.1:${PORT}`, PORT)).toBe(false);
    expect(isAllowedHostHeader(`192.168.1.5:${PORT}`, PORT)).toBe(false);
    expect(isAllowedHostHeader(`0.0.0.0:${PORT}`, PORT)).toBe(false);
  });
});

describe("Origin header", () => {
  it("allows an absent Origin, which is what a native MCP client sends", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("")).toBe(true);
  });

  it("allows a loopback origin", () => {
    expect(isAllowedOrigin(`http://127.0.0.1:${PORT}`)).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
  });

  it("refuses any other origin", () => {
    for (const origin of [
      "https://evil.example",
      "https://app.oxagen.sh",
      "http://localhost.evil.example",
      "file://",
      "chrome-extension://abcdef",
    ]) {
      expect(isAllowedOrigin(origin), origin).toBe(false);
    }
  });

  it('refuses the literal "null" a sandboxed frame sends', () => {
    expect(isAllowedOrigin("null")).toBe(false);
  });

  it("refuses an unparseable origin rather than guessing", () => {
    expect(isAllowedOrigin("not a url")).toBe(false);
    expect(isAllowedOrigin("://")).toBe(false);
  });
});

describe("the guard as one call", () => {
  it("passes a native client on loopback", () => {
    expect(guardLoopbackRequest({ host: `127.0.0.1:${PORT}` }, PORT)).toEqual({
      ok: true,
    });
  });

  it("names which header failed", () => {
    expect(
      guardLoopbackRequest({ host: `evil.example:${PORT}` }, PORT),
    ).toEqual({ ok: false, reason: "host" });
    expect(
      guardLoopbackRequest(
        { host: `127.0.0.1:${PORT}`, origin: "https://evil.example" },
        PORT,
      ),
    ).toEqual({ ok: false, reason: "origin" });
  });

  it("checks Host before Origin, so a rebound request reads as one", () => {
    // Both are wrong; the report names the transport-level failure, which is
    // the one that says "this request was never for us".
    expect(
      guardLoopbackRequest(
        { host: "evil.example", origin: "https://evil.example" },
        PORT,
      ).reason,
    ).toBe("host");
  });
});
