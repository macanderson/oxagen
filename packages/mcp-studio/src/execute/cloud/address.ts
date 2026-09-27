// address.ts: the addresses the cloud network refuses (mcp-studio-spec,
// Network paths).
//
// A call on the cloud network goes straight from Oxagen to the upstream, so
// a host that resolves to a private, loopback, or link-local address would
// reach Oxagen's own network. The cloud Transport resolves the host once,
// refuses the call when any address it resolves to is not public, and dials
// the address it checked, so a second lookup cannot move the call to another
// address. A private host is reached through a relay.
//
// IPv4 refuses every special-purpose range in the IANA registry. IPv6 allows
// only global unicast (2000::/3) outside its special-purpose ranges, and an
// address that carries an IPv4 address (IPv4-mapped, NAT64, and 6to4) is
// judged by the IPv4 address it carries.
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { TransportError } from "../transport";
import { messageOf } from "../util";

type Range<T> = readonly [base: T, bits: number, what: string];

const IPV4_RANGES: ReadonlyArray<Range<string>> = [
  ["0.0.0.0", 8, "a this-network address"],
  ["10.0.0.0", 8, "a private address"],
  ["100.64.0.0", 10, "a shared address"],
  ["127.0.0.0", 8, "a loopback address"],
  ["169.254.0.0", 16, "a link-local address"],
  ["172.16.0.0", 12, "a private address"],
  ["192.0.0.0", 24, "a protocol assignment address"],
  ["192.0.2.0", 24, "a documentation address"],
  ["192.88.99.0", 24, "a 6to4 relay address"],
  ["192.168.0.0", 16, "a private address"],
  ["198.18.0.0", 15, "a benchmarking address"],
  ["198.51.100.0", 24, "a documentation address"],
  ["203.0.113.0", 24, "a documentation address"],
  ["224.0.0.0", 4, "a multicast address"],
  ["255.255.255.255", 32, "the broadcast address"],
  ["240.0.0.0", 4, "a reserved address"],
];

const IPV6_RANGES: ReadonlyArray<Range<string>> = [
  ["::", 128, "the unspecified address"],
  ["::1", 128, "a loopback address"],
  ["64:ff9b:1::", 48, "a local NAT64 address"],
  ["100::", 64, "a discard address"],
  ["2001:db8::", 32, "a documentation address"],
  ["2001::", 23, "a protocol assignment address"],
  ["3fff::", 20, "a documentation address"],
  ["fc00::", 7, "a unique local address"],
  ["fe80::", 10, "a link-local address"],
  ["fec0::", 10, "a site-local address"],
  ["ff00::", 8, "a multicast address"],
];

/** A 32-bit IPv4 address as an unsigned number. */
function ipv4Value(address: string): number {
  return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

/**
 * A 128-bit IPv6 address as a bigint. It takes any form isIP accepts: a zone
 * id, a :: run of zero groups, and a dotted IPv4 tail.
 */
function ipv6Value(address: string): bigint {
  const zone = address.indexOf("%");
  let text = zone === -1 ? address : address.slice(0, zone);
  if (text.includes(".")) {
    const colon = text.lastIndexOf(":");
    const tail = ipv4Value(text.slice(colon + 1));
    text = `${text.slice(0, colon + 1)}${(tail >>> 16).toString(16)}:${(tail & 0xffff).toString(16)}`;
  }
  const groups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  // split always returns at least one part.
  const [head, tail] = text.split("::") as [string, string | undefined];
  const front = groups(head);
  const back = tail === undefined ? [] : groups(tail);
  const zeros = tail === undefined ? [] : Array.from({ length: 8 - front.length - back.length }, () => "0");
  return [...front, ...zeros, ...back].reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
}

const IPV4_TABLE = IPV4_RANGES.map(([base, bits, what]): Range<number> => [ipv4Value(base), bits, what]);
const IPV6_TABLE = IPV6_RANGES.map(([base, bits, what]): Range<bigint> => [ipv6Value(base), bits, what]);

function inIPv4Range(value: number, [base, bits]: Range<number>): boolean {
  const shift = 32 - bits;
  return value >>> shift === base >>> shift;
}

function inIPv6Range(value: bigint, [base, bits]: Range<bigint>): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === base >> shift;
}

const IPV4_MAPPED: Range<bigint> = [ipv6Value("::ffff:0:0"), 96, "an IPv4-mapped address"];
const NAT64: Range<bigint> = [ipv6Value("64:ff9b::"), 96, "a NAT64 address"];
const SIX_TO_FOUR: Range<bigint> = [ipv6Value("2002::"), 16, "a 6to4 address"];
const GLOBAL_UNICAST: Range<bigint> = [ipv6Value("2000::"), 3, "a global unicast address"];

/** The IPv4 address an IPv6 address carries: IPv4-mapped, NAT64, or 6to4. */
function carriedIPv4(value: bigint): number | undefined {
  if (inIPv6Range(value, IPV4_MAPPED) || inIPv6Range(value, NAT64)) return Number(value & 0xffffffffn);
  if (inIPv6Range(value, SIX_TO_FOUR)) return Number((value >> 80n) & 0xffffffffn);
  return undefined;
}

function refusedIPv4(value: number): string | undefined {
  return IPV4_TABLE.find((range) => inIPv4Range(value, range))?.[2];
}

function refusedIPv6(value: bigint): string | undefined {
  const carried = carriedIPv4(value);
  if (carried !== undefined) return refusedIPv4(carried);
  const special = IPV6_TABLE.find((range) => inIPv6Range(value, range));
  if (special !== undefined) return special[2];
  return inIPv6Range(value, GLOBAL_UNICAST) ? undefined : "an address outside the global unicast range";
}

/**
 * Why the cloud network refuses an address, such as "a loopback address".
 * Undefined for a public address.
 */
export function refusedAddress(address: string): string | undefined {
  switch (isIP(address)) {
    case 4:
      return refusedIPv4(ipv4Value(address));
    case 6:
      return refusedIPv6(ipv6Value(address));
    default:
      return "not an IP address";
  }
}

/** Every address a host resolves to, in the order the resolver returns them. */
export type AddressLookup = (host: string) => Promise<readonly LookupAddress[]>;

const systemLookup: AddressLookup = (host) => lookup(host, { all: true, order: "verbatim" });

function stopReason(signal: AbortSignal): TransportError {
  const reason: unknown = signal.reason;
  if (reason instanceof TransportError) return reason;
  return new TransportError("not_sent", "The call was cancelled before it was sent.", false);
}

/**
 * The promise's result, or a rejection when the signal aborts first. The
 * rejection is the signal's reason when that is a TransportError, and a
 * not_sent TransportError otherwise.
 */
export async function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The caller stops waiting, so a later rejection must not go unhandled.
    promise.catch(() => undefined);
    throw stopReason(signal);
  }
  const listening = new AbortController();
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(stopReason(signal)), { once: true, signal: listening.signal });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    listening.abort();
  }
}

function refusal(message: string): TransportError {
  return new TransportError(
    "refused_address",
    `${message}, and the cloud network sends only to public addresses. Reach a private host through a relay.`,
    false,
  );
}

/**
 * The address to dial for a host on the cloud network. It refuses the call
 * with a refused_address TransportError when the host is, or resolves to,
 * an address that is not public. One refused address refuses the host, so
 * a host cannot pass by listing a public address first. A host that does
 * not resolve is a not_sent TransportError.
 */
export async function resolvePublicAddress(
  host: string,
  signal: AbortSignal,
  find: AddressLookup = systemLookup,
): Promise<string> {
  if (isIP(host) !== 0) {
    const what = refusedAddress(host);
    if (what !== undefined) throw refusal(`${host} is ${what}`);
    return host;
  }
  let addresses: readonly LookupAddress[];
  try {
    addresses = await unlessAborted(find(host), signal);
  } catch (error) {
    if (error instanceof TransportError) throw error;
    throw new TransportError("not_sent", `${host} did not resolve: ${messageOf(error)}`, false);
  }
  const first = addresses[0];
  if (first === undefined) throw new TransportError("not_sent", `${host} did not resolve to any address.`, false);
  for (const { address } of addresses) {
    const what = refusedAddress(address);
    if (what !== undefined) throw refusal(`${host} resolves to ${address}, ${what}`);
  }
  return first.address;
}
