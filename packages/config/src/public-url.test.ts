/**
 * The outbound-URL guard. It moved here from `agent.mcp.register.ts` when a
 * second caller arrived (BYOK endpoints); `agent.mcp.register.test.ts` still
 * exercises it through that handler, and this suite pins it directly — in
 * particular the `requireTls` option, which only the new caller uses.
 */
import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, UnsafeOutboundUrlError } from "./public-url";

const OPTS = { refusing: "Refusing to test" };
const TLS = { ...OPTS, requireTls: true };

describe("assertPublicHttpUrl", () => {
  it("admits a public https endpoint and returns the parsed URL", () => {
    const url = assertPublicHttpUrl("https://api.together.xyz/v1", TLS);
    expect(url.hostname).toBe("api.together.xyz");
  });

  it("refuses the cloud metadata address — the case this guard exists for", () => {
    expect(() =>
      assertPublicHttpUrl("https://169.254.169.254/latest/meta-data/", TLS),
    ).toThrow(UnsafeOutboundUrlError);
  });

  it.each([
    ["decimal", "https://2130706433/"],
    ["hex", "https://0x7f.1/"],
    ["octal", "https://0177.0.0.1/"],
    ["short form", "https://127.1/"],
  ])("refuses loopback spelled in %s inet_aton form", (_form, raw) => {
    // A dotted-quad regex waves every one of these through, and the resolver
    // sends every one of them to 127.0.0.1.
    expect(() => assertPublicHttpUrl(raw, TLS)).toThrow(/non-routable/);
  });

  it.each([
    "https://10.0.0.5/v1",
    "https://172.16.0.1/v1",
    "https://192.168.1.1/v1",
    "https://localhost/v1",
    "https://[::1]/v1",
    "https://[fd00::1]/v1",
    "https://[::ffff:127.0.0.1]/v1",
  ])("refuses the internal endpoint %s", (raw) => {
    expect(() => assertPublicHttpUrl(raw, TLS)).toThrow(UnsafeOutboundUrlError);
  });

  // THE BYPASS. The URL parser rewrites an embedded IPv4 into hex before this
  // guard sees it: `[::ffff:169.254.169.254]` arrives as `::ffff:a9fe:a9fe`.
  // The guard previously matched only the dotted spelling, which the parser
  // never produces, so every one of these reached its IPv4 target — loopback
  // services on the node included. Each case is one the old code admitted.
  it.each([
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped metadata", "https://[::ffff:169.254.169.254]/"],
    ["IPv4-mapped RFC1918", "https://[::ffff:10.0.0.1]/"],
    ["IPv4-mapped, hex-spelled", "https://[::ffff:7f00:1]/"],
    ["IPv4-compatible loopback", "https://[::127.0.0.1]/"],
    ["NAT64 metadata", "https://[64:ff9b::169.254.169.254]/"],
    ["fully expanded mapped", "https://[0:0:0:0:0:ffff:7f00:1]/"],
  ])("refuses %s — the parser-normalised bypass", (_name, raw) => {
    expect(() => assertPublicHttpUrl(raw, TLS)).toThrow(UnsafeOutboundUrlError);
  });

  it.each([
    ["IPv4-mapped public", "https://[::ffff:8.8.8.8]/"],
    ["a public IPv6 host", "https://[2606:4700:4700::1111]/"],
  ])("still admits %s", (_name, raw) => {
    // The fix must not over-refuse: an embedded PUBLIC address is fine.
    expect(() => assertPublicHttpUrl(raw, TLS)).not.toThrow();
  });

  it("refuses http when requireTls is set — a key must not cross the wire in clear", () => {
    expect(() =>
      assertPublicHttpUrl("http://api.together.xyz/v1", TLS),
    ).toThrow(/must use https/);
  });

  it("still admits http without requireTls, which is what MCP registration relies on", () => {
    // MCP registration predates the guard and admits http endpoints; the
    // option is opt-in so moving the guard did not change that behaviour.
    expect(() =>
      assertPublicHttpUrl("http://mcp.example.com/sse", OPTS),
    ).not.toThrow();
  });

  it("refuses a URL that carries a credential in its userinfo", () => {
    // Stored in the clear and returned by every read, so a key typed here
    // would leak through the redacted view (P1 on #3308).
    for (const raw of [
      "https://user:pass@api.example.com/v1",
      "https://sk-live-secret@api.example.com/v1",
      "https://:pass@api.example.com/v1",
    ]) {
      expect(() => assertPublicHttpUrl(raw, TLS)).toThrow(
        /username or password/,
      );
    }
  });

  it("still admits an @ that is not userinfo — in a path or a query", () => {
    expect(() =>
      assertPublicHttpUrl("https://api.example.com/v1/@acme/models", TLS),
    ).not.toThrow();
    expect(() =>
      assertPublicHttpUrl("https://api.example.com/v1?owner=a@b.example", TLS),
    ).not.toThrow();
  });

  it("refuses non-http schemes", () => {
    expect(() => assertPublicHttpUrl("file:///etc/passwd", OPTS)).toThrow(
      /scheme/,
    );
  });

  it("names the thing being refused, so an operator knows which form to fix", () => {
    expect(() =>
      assertPublicHttpUrl("https://127.0.0.1/", {
        refusing: "Refusing to store model credential",
      }),
    ).toThrow(/^Refusing to store model credential: /);
  });

  it("carries a stable code a surface can classify on", () => {
    try {
      assertPublicHttpUrl("https://127.0.0.1/", OPTS);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeOutboundUrlError);
      expect((err as UnsafeOutboundUrlError).code).toBe("unsafe_outbound_url");
    }
  });
});
