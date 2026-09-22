/**
 * The guard every outbound URL a CUSTOMER supplied must pass before this
 * process connects to it carrying a secret.
 *
 * Two surfaces hand us a URL an authenticated org admin typed and then attach
 * credentials to a request against it: registering an MCP server
 * (`agent.mcp.register`, bearer/header auth) and bringing a model key for an
 * OpenAI-compatible endpoint (ADR-053 §2, the `Authorization` header). Without
 * this guard either one points the server at an internal-only host — loopback,
 * RFC1918, link-local, and above all `169.254.169.254`, the cloud metadata
 * service — and reads back whatever the instance role can see, or uses us as a
 * probe of the private network.
 *
 * It lives here, in the package all three of `@oxagen/agent`, `@oxagen/ai` and
 * `@oxagen/handlers` already depend on, because the alternative is a second
 * copy: this logic is subtle enough (see `normalizeIPv4`) that two copies
 * means one of them is eventually wrong, and it would be the newer one.
 *
 * What this guard is NOT: it does not re-check after DNS resolves, so a name
 * that resolves to a private address at connect time still gets through
 * (a DNS-rebinding window). Closing that needs a pinned-IP dialer, which is a
 * transport change rather than a validation one. This rejects the direct
 * forms, which is what an admin-typed URL actually does.
 */

/** A URL was refused before any connection was attempted. */
export class UnsafeOutboundUrlError extends Error {
  override readonly name = "UnsafeOutboundUrlError";
  readonly code = "unsafe_outbound_url" as const;
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Replace the userinfo of every address in `text`, so a password somebody
 * typed into a URL does not travel on into a log line, an error message, or a
 * settings page.
 *
 * `assertPublicHttpUrl` refuses such an address, which is the real fix, and
 * this is the belt to that braces: the refusal itself quotes what it refused,
 * the vendor probe reports a transport error whose text is Node's ("Request
 * cannot be constructed from a URL that includes credentials: …", with the
 * whole URL in it), and an address stored before that guard existed is still
 * read back by every surface. Each of those is a place a secret can arrive
 * with no one having decided to print it.
 *
 * Works on a string rather than on a parsed URL because the strings it has to
 * clean are not always parseable — the guard's own "invalid URL" refusal is
 * the case in point. The whole userinfo goes, not just the password: a bare
 * `https://sk-live-…@host/v1` is a key in the username field.
 */
export function redactUrlCredentials(text: string): string {
  return text.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#\s]*@/g,
    (_match, scheme: string) => `${scheme}***@`,
  );
}

export interface AssertPublicHttpUrlOptions {
  /**
   * Prefixed to every refusal so the message names the thing being refused —
   * "Refusing to register MCP server", "Refusing to store model credential".
   * A bare range complaint does not tell an operator which form to fix.
   */
  readonly refusing: string;
  /**
   * When true, `http:` is refused as well as the non-HTTP schemes. A URL that
   * carries an API key in a header must be `https:`; the MCP registration
   * predates this guard and still admits `http:`, so it is opt-in rather than
   * the default.
   */
  readonly requireTls?: boolean;
}

/**
 * Throw unless `raw` is an http(s) URL whose host is not a literal in a
 * non-routable range. Returns the parsed URL so a caller that needs it does
 * not parse twice.
 */
export function assertPublicHttpUrl(
  raw: string,
  options: AssertPublicHttpUrlOptions,
): URL {
  const refuse = (reason: string): never => {
    throw new UnsafeOutboundUrlError(`${options.refusing}: ${reason}`);
  };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Quoted so the operator can see what was read, redacted because an
    // address that fails to parse can still carry a password —
    // `https://user:pass@exa mple.com/v1` throws here — and this message is
    // returned as the field's `invalid_input` reason and logged with it.
    return refuse(`invalid URL "${redactUrlCredentials(raw)}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return refuse(`scheme "${parsed.protocol}" is not allowed`);
  }
  if (options.requireTls === true && parsed.protocol !== "https:") {
    return refuse("the URL must use https");
  }

  // Userinfo is a credential in the URL, and the URL is stored in the clear
  // and returned by every read: `https://user:pass@host/v1` would put a
  // secret into `base_url` and hand it back as part of the redacted view.
  // Node's fetch refuses such a URL anyway, so nothing is lost by refusing it
  // here, where the message says what to remove. The check is on the parsed
  // fields rather than on the raw string, because `@` is legal in a path or
  // a query and only the authority's userinfo carries a secret.
  if (parsed.username !== "" || parsed.password !== "") {
    return refuse(
      "the URL must not carry a username or password; send the credential in the request, not in the URL",
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "metadata.google.internal") {
    return refuse(`hostname "${host}" is not allowed`);
  }

  if (host.startsWith("[")) {
    const ipv6 = host.slice(1, -1);
    if (isPrivateIPv6(ipv6)) {
      return refuse(`IPv6 address "${ipv6}" is in a non-routable range`);
    }
    return parsed;
  }

  // Normalize BEFORE the range check: "127.0.0.1" is only the canonical
  // spelling. `http://2130706433/`, `http://0x7f.1/` and `http://0177.0.0.1/`
  // all reach loopback because the resolver accepts the legacy inet_aton
  // forms, so a dotted-quad-only regex would wave every one of them through.
  const ipv4 = normalizeIPv4(host);
  if (ipv4 && isPrivateIPv4(ipv4)) {
    return refuse(`IPv4 address "${host}" is in a non-routable range`);
  }
  return parsed;
}

/**
 * A `fetch` that does not follow redirects, for every request this process
 * makes to a customer-supplied endpoint with a secret in the header.
 *
 * `assertPublicHttpUrl` checks the URL an admin typed. `fetch` follows a
 * redirect by default, and the redirect target is a URL nobody checked: a
 * public endpoint answering `/models` with `302 Location: http://10.0.0.5/`
 * would walk the request, key and all, straight past the guard. So the
 * request is sent with `redirect: "manual"` and a 3xx answer is refused as
 * the guard would refuse the URL itself, naming the `Location` so the
 * operator can give the final URL instead. The runtime model client and the
 * credential probe both use this, because a policy enforced in one of them
 * is a policy the other one bypasses.
 */
export function fetchWithoutRedirects(
  options: Pick<AssertPublicHttpUrlOptions, "refusing">,
): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      // The `Location` is written by the endpoint, not by us, so it is
      // redacted like any other address this process prints: a redirect to
      // `https://user:pass@…` would otherwise put someone's credential in the
      // refusal an operator reads and a log keeps.
      const location = response.headers.get("location");
      throw new UnsafeOutboundUrlError(
        `${options.refusing}: the endpoint answered ${response.status}${
          location ? ` redirecting to "${redactUrlCredentials(location)}"` : ""
        }; redirects are not followed, give the final URL instead`,
      );
    }
    return response;
  };
}

/**
 * Canonicalize a hostname that is an IPv4 literal in any of the four inet_aton
 * forms (a, a.b, a.b.c, a.b.c.d) with decimal / octal (0…) / hex (0x…) parts,
 * to dotted-quad. Returns null when the host is not an IPv4 literal at all
 * (a real DNS name), which the caller treats as "not a literal to range-check".
 */
function normalizeIPv4(host: string): string | null {
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part, 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part, 8);
    else if (/^\d+$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    nums.push(value);
  }
  // The LAST part absorbs the remaining low-order bytes (inet_aton semantics):
  // "127.1" is 127.0.0.1, "2130706433" is 127.0.0.1.
  const last = nums.pop() as number;
  const maxLast = 2 ** (8 * (4 - nums.length));
  if (last >= maxLast) return null;
  if (nums.some((n) => n > 255)) return null;
  const octets = [...nums, ...Array<number>(4 - nums.length).fill(0)];
  for (let i = 3; i >= nums.length; i--) {
    octets[i] = (last >>> (8 * (3 - i))) & 0xff;
  }
  return octets.join(".");
}

/**
 * True for every IPv4 block the IANA special-purpose registry (RFC 6890) says
 * is not globally reachable, not just loopback, RFC 1918 and link-local.
 * The extra blocks matter because a deployment CAN route them to internal
 * services: `100.64.0.0/10` is what a cloud's NAT and service mesh sit on,
 * `198.18.0.0/15` is the benchmarking range some VPCs reuse, and multicast or
 * the reserved class E block reach something only from inside a network.
 * An admin-typed endpoint in any of them is a request to have this process
 * dial an internal host with a customer key in the header.
 */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".").map((s) => {
    const n = Number.parseInt(s, 10);
    return Number.isNaN(n) ? -1 : n;
  });
  if (parts.length !== 4 || parts.some((p) => p < 0 || p > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 — "this network"
    a === 10 || // 10.0.0.0/8 — RFC 1918
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 — shared address space (CGNAT)
    a === 127 || // 127.0.0.0/8 — loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 — link-local (incl. 169.254.169.254 IMDS)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 — RFC 1918
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 — IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 — TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 — deprecated 6to4 relay anycast
    (a === 192 && b === 168) || // 192.168.0.0/16 — RFC 1918
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 — benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 — TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 — TEST-NET-3
    a >= 224 // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
  );
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, or null when it is not
 * one. Handles `::` compression and a trailing dotted-quad.
 *
 * Why expand at all, rather than pattern-match: the WHATWG URL parser has
 * ALREADY rewritten the literal by the time `parsed.hostname` is read, and it
 * rewrites an embedded IPv4 into hex. `https://[::ffff:169.254.169.254]/`
 * arrives here as `::ffff:a9fe:a9fe`. The previous version of this function
 * matched only the dotted-decimal spelling — which the parser never produces —
 * so every IPv4-mapped and IPv4-compatible address passed as a public IPv6
 * host, including loopback and the metadata address. Its comment described
 * the intent; the regex could not reach it. Working on the numeric value makes
 * the spelling irrelevant, which is the only durable answer to a parser that
 * normalises.
 */
function expandIPv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  // A trailing dotted-quad (still possible if a caller passes an unparsed
  // literal) becomes two hex groups so the rest of this is uniform.
  const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (quad) {
    const b = quad.slice(1).map(Number);
    if (b.some((n) => n > 255)) return null;
    const hi = ((b[0]! << 8) | b[1]!).toString(16);
    const lo = ((b[2]! << 8) | b[3]!).toString(16);
    text = `${text.slice(0, quad.index)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

/** The IPv4 address in the low 32 bits of an expanded IPv6, as dotted-quad. */
function embeddedIPv4(groups: number[]): string {
  const hi = groups[6]!;
  const lo = groups[7]!;
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

function isPrivateIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  // Not a parseable IPv6 literal. The URL parser would not have produced one,
  // so refusing is the safe answer to input this function does not understand.
  if (!g) return true;

  const zeroTo = (n: number) => g.slice(0, n).every((x) => x === 0);

  if (zeroTo(7) && g[7] === 1) return true; // ::1 loopback
  if (zeroTo(8)) return true; // :: unspecified
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated, still routed by some stacks)
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // 2001:db8::/32 documentation
  if ((g[0]! & 0xfff0) === 0x3ff0) return true; // 3fff::/20 documentation (RFC 9637)
  if (g[0] === 0x5f00) return true; // 5f00::/16 segment-routing SIDs (RFC 9602)
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return true; // 100::/64 discard-only

  // 6to4 (`2002:a.b.c.d::/48`) carries an IPv4 address in its high bits and
  // reaches it through a relay. Range-check the embedded IPv4 the same way
  // the low-bits forms below are checked.
  if (g[0] === 0x2002) {
    return isPrivateIPv4(
      [g[1]! >> 8, g[1]! & 0xff, g[2]! >> 8, g[2]! & 0xff].join("."),
    );
  }

  // `2001::/23`, the IETF protocol-assignments block. The IANA special-purpose
  // registry marks the block itself as not globally reachable and lists four
  // exceptions inside it that are: the PCP and TURN anycast addresses
  // (`2001:1::1`, `2001:1::2`), AMT (`2001:3::/32`) and AS112 (`2001:4:112::/48`).
  // Teredo (`2001::/32`) reaches the IPv4 server in groups 2–3, so it is
  // range-checked like 6to4. Everything else in the block — benchmarking
  // (`2001:2::/48`), the ORCHID ranges, DRIP, and whatever the registry adds
  // next — is refused, because listing the refusals one prefix at a time is
  // how the last two rounds of this function each missed one.
  if (g[0] === 0x2001 && (g[1]! & 0xfe00) === 0) {
    if (g[1] === 0) {
      return isPrivateIPv4(
        [g[2]! >> 8, g[2]! & 0xff, g[3]! >> 8, g[3]! & 0xff].join("."),
      );
    }
    const anycast =
      g[1] === 1 &&
      g.slice(2, 7).every((x) => x === 0) &&
      (g[7] === 1 || g[7] === 2);
    const amt = g[1] === 3;
    const as112 = g[1] === 4 && g[2] === 0x112;
    return !(anycast || amt || as112);
  }

  // Addresses that carry an IPv4 address in their low 32 bits and that the OS
  // or the network delivers TO that IPv4 address. Range-check the embedded
  // address; treating the whole literal as a public IPv6 host is the bypass.
  //   ::ffff:a.b.c.d      IPv4-mapped (dual-stack sockets dial the IPv4)
  //   ::a.b.c.d           IPv4-compatible (deprecated, still routed)
  //   64:ff9b::a.b.c.d    NAT64 well-known prefix (reaches the IPv4 via NAT64)
  const mapped = zeroTo(5) && g[5] === 0xffff;
  const compatible = zeroTo(6);
  const nat64 =
    g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
  // RFC 8215's local-use translation prefix, `64:ff9b:1::/48`. Unlike the
  // well-known /96 above, its embedded IPv4 sits at a deployment-chosen
  // offset, so it cannot be decoded here; and the RFC says the prefix must
  // not be routed globally, so nothing public lives under it. Refused whole.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  if (mapped || compatible || nat64) {
    return isPrivateIPv4(embeddedIPv4(g));
  }
  return false;
}
