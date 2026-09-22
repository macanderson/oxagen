/**
 * The outbound-URL guard. It moved here from `agent.mcp.register.ts` when a
 * second caller arrived (BYOK endpoints); `agent.mcp.register.test.ts` still
 * exercises it through that handler, and this suite pins it directly — in
 * particular the `requireTls` option, which only the new caller uses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPublicHttpUrl,
  fetchWithoutRedirects,
  redactUrlCredentials,
  UnsafeOutboundUrlError,
} from "./public-url";

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
    ["NAT64 local-use prefix (RFC 8215)", "https://[64:ff9b:1::a9fe:a9fe]/"],
    ["NAT64 local-use prefix, any suffix", "https://[64:ff9b:1:1:2:3:4:5]/"],
    ["fully expanded mapped", "https://[0:0:0:0:0:ffff:7f00:1]/"],
  ])("refuses %s — the parser-normalised bypass", (_name, raw) => {
    expect(() => assertPublicHttpUrl(raw, TLS)).toThrow(UnsafeOutboundUrlError);
  });

  // Beyond loopback, RFC 1918 and link-local: every block the IANA
  // special-purpose registry (RFC 6890) lists as not globally reachable. A
  // deployment can route these to internal services — the shared address
  // space is where a cloud's NAT sits, the benchmarking range is reused by
  // VPCs — so an endpoint in any of them is an internal host with a customer
  // key in the header (P1 on #3308).
  it.each([
    ["shared address space (CGNAT)", "https://100.64.0.1/v1"],
    ["shared address space, top", "https://100.127.255.254/v1"],
    ["IETF protocol assignments", "https://192.0.0.8/v1"],
    ["TEST-NET-1", "https://192.0.2.10/v1"],
    ["6to4 relay anycast", "https://192.88.99.1/v1"],
    ["benchmarking", "https://198.18.0.1/v1"],
    ["benchmarking, second half", "https://198.19.255.1/v1"],
    ["TEST-NET-2", "https://198.51.100.7/v1"],
    ["TEST-NET-3", "https://203.0.113.9/v1"],
    ["multicast", "https://224.0.0.1/v1"],
    ["reserved class E", "https://240.0.0.1/v1"],
    ["broadcast", "https://255.255.255.255/v1"],
    ["IPv4-mapped CGNAT", "https://[::ffff:100.64.0.1]/v1"],
    ["IPv6 site-local", "https://[fec0::1]/v1"],
    ["IPv6 multicast", "https://[ff02::1]/v1"],
    ["IPv6 documentation", "https://[2001:db8::1]/v1"],
    ["IPv6 discard-only", "https://[100::1]/v1"],
    ["6to4 wrapping RFC1918", "https://[2002:a00:1::1]/v1"],
    ["IPv6 benchmarking (2001:2::/48)", "https://[2001:2::1]/v1"],
    ["ORCHIDv2 (2001:20::/28)", "https://[2001:20::1]/v1"],
    ["DRIP (2001:30::/28)", "https://[2001:30::1]/v1"],
    ["IETF block, unassigned (2001:1ff::)", "https://[2001:1ff::1]/v1"],
    ["documentation (3fff::/20)", "https://[3fff::1]/v1"],
    ["documentation, top of /20 (3fff:fff::)", "https://[3fff:fff::1]/v1"],
    ["SRv6 SIDs (5f00::/16)", "https://[5f00::1]/v1"],
    ["Teredo wrapping loopback", "https://[2001:0:7f00:1::1]/v1"],
  ])("refuses the special-use range %s", (_name, raw) => {
    expect(() => assertPublicHttpUrl(raw, TLS)).toThrow(/non-routable/);
  });

  it.each([
    ["the address just below the shared space", "https://100.63.255.255/v1"],
    ["the address just above the shared space", "https://100.128.0.0/v1"],
    ["the address beside the benchmarking range", "https://198.20.0.1/v1"],
    ["6to4 wrapping a public address", "https://[2002:808:808::1]/v1"],
    ["Teredo wrapping a public server", "https://[2001:0:808:808::1]/v1"],
    ["PCP anycast (2001:1::1)", "https://[2001:1::1]/v1"],
    ["TURN anycast (2001:1::2)", "https://[2001:1::2]/v1"],
    ["AMT (2001:3::/32)", "https://[2001:3::1]/v1"],
    ["AS112 (2001:4:112::/48)", "https://[2001:4:112::1]/v1"],
    [
      "the address just past the IETF block (2001:200::)",
      "https://[2001:200::1]/v1",
    ],
    ["the address just past 3fff::/20 (4000::)", "https://[4000::1]/v1"],
  ])("still admits %s — the ranges are exact", (_name, raw) => {
    expect(() => assertPublicHttpUrl(raw, TLS)).not.toThrow();
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

  it("does not repeat a credential back when the address will not parse", () => {
    // `new URL` throws on this one, so the userinfo check below never sees
    // it and the refusal quotes what was read. That message is the field's
    // `invalid_input` reason on every surface and is logged with it, so the
    // password must not be in it (#3314, finding 3).
    let message = "";
    try {
      assertPublicHttpUrl("https://user:hunter2@exa mple.com/v1", TLS);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("invalid URL");
    expect(message).not.toContain("hunter2");
    expect(message).toContain("https://***@");
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

describe("fetchWithoutRedirects", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends every request with redirect: manual", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const response = await fetchWithoutRedirects(OPTS)(
      "https://api.example.com/v1/models",
      { method: "GET" },
    );
    expect(response.status).toBe(200);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
    expect(init?.method).toBe("GET");
  });

  it("refuses a redirect and names where it pointed — the target is a URL nobody checked", async () => {
    // A public endpoint answering 302 to a private host would walk the key
    // past assertPublicHttpUrl, which only saw the URL the admin typed.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://10.0.0.5/v1/models" },
          }),
      ),
    );
    await expect(
      fetchWithoutRedirects({ refusing: "Refusing to test" })(
        "https://api.example.com/v1/models",
      ),
    ).rejects.toThrow(
      /^Refusing to test: the endpoint answered 302 redirecting to "http:\/\/10\.0\.0\.5\/v1\/models"; redirects are not followed/,
    );
  });

  it("redacts a credential the redirect target carried", async () => {
    // The `Location` is the endpoint's text, not ours, and the refusal that
    // quotes it is read by an operator and kept by a log.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://user:hunter2@elsewhere.example/v1" },
          }),
      ),
    );
    let message = "";
    try {
      await fetchWithoutRedirects(OPTS)("https://api.example.com/v1/models");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('redirecting to "https://***@elsewhere.example');
    expect(message).not.toContain("hunter2");
  });

  it("refuses a redirect with no Location header the same way", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 308 })),
    );
    await expect(
      fetchWithoutRedirects(OPTS)("https://api.example.com/v1/models"),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError);
  });
});

describe("redactUrlCredentials", () => {
  it("replaces the whole userinfo, not only the password", () => {
    // A bare username is a key too: `https://sk-live-…@host/v1`.
    expect(
      redactUrlCredentials("https://user:hunter2@api.example.com/v1"),
    ).toBe("https://***@api.example.com/v1");
    expect(
      redactUrlCredentials("https://sk-live-secret@api.example.com/v1"),
    ).toBe("https://***@api.example.com/v1");
  });

  it("cleans an address embedded in a sentence, wherever it sits", () => {
    // What it is actually given: a vendor or transport message written by
    // somebody else. Node's is "Request cannot be constructed from a URL that
    // includes credentials: <the whole URL>".
    const message =
      "Request cannot be constructed from a URL that includes credentials: " +
      "https://user:hunter2@api.example.com/v1/models";
    expect(redactUrlCredentials(message)).toBe(
      "Request cannot be constructed from a URL that includes credentials: " +
        "https://***@api.example.com/v1/models",
    );
  });

  it("leaves an @ that is not userinfo alone", () => {
    for (const text of [
      "https://api.example.com/v1/@acme/models",
      "https://api.example.com/v1?owner=a@b.example",
      "mail me at ops@example.com",
    ]) {
      expect(redactUrlCredentials(text)).toBe(text);
    }
  });

  it("cleans every address in one string", () => {
    expect(
      redactUrlCredentials(
        "from https://a:1@one.example/v1 to https://b:2@two.example/v1",
      ),
    ).toBe("from https://***@one.example/v1 to https://***@two.example/v1");
  });
});
