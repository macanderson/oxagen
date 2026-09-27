import type { LookupAddress } from "node:dns";
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { TransportError } from "../transport";
import { refusedAddress, resolvePublicAddress, unlessAborted, type AddressLookup } from "./address";

const REFUSAL_TAIL = ", and the cloud network sends only to public addresses. Reach a private host through a relay.";

function lookupOf(...addresses: string[]): AddressLookup {
  return (_host: string) =>
    Promise.resolve(addresses.map((address): LookupAddress => ({ address, family: address.includes(":") ? 6 : 4 })));
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

describe("refusedAddress", () => {
  it.each([
    ["0.1.2.3", "a this-network address"],
    ["10.20.30.40", "a private address"],
    ["100.64.0.1", "a shared address"],
    ["100.127.255.254", "a shared address"],
    ["127.0.0.1", "a loopback address"],
    ["127.255.255.255", "a loopback address"],
    ["169.254.169.254", "a link-local address"],
    ["172.16.0.1", "a private address"],
    ["172.31.255.255", "a private address"],
    ["192.0.0.8", "a protocol assignment address"],
    ["192.0.2.1", "a documentation address"],
    ["192.88.99.1", "a 6to4 relay address"],
    ["192.168.1.1", "a private address"],
    ["198.18.0.1", "a benchmarking address"],
    ["198.19.255.255", "a benchmarking address"],
    ["198.51.100.7", "a documentation address"],
    ["203.0.113.9", "a documentation address"],
    ["224.0.0.1", "a multicast address"],
    ["239.255.255.250", "a multicast address"],
    ["240.0.0.1", "a reserved address"],
    ["255.255.255.255", "the broadcast address"],
  ])("refuses the IPv4 address %s as %s", (address, what) => {
    expect(refusedAddress(address)).toBe(what);
  });

  it.each(["8.8.8.8", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "1.1.1.1"])(
    "allows the public IPv4 address %s",
    (address) => {
      expect(refusedAddress(address)).toBeUndefined();
    },
  );

  it.each([
    ["::", "the unspecified address"],
    ["::1", "a loopback address"],
    ["64:ff9b:1::a00:1", "a local NAT64 address"],
    ["100::1", "a discard address"],
    ["2001:db8::1", "a documentation address"],
    ["2001:0:4136:e378::1", "a protocol assignment address"],
    ["3fff:fff::1", "a documentation address"],
    ["fc00::1", "a unique local address"],
    ["fd12:3456:789a::1", "a unique local address"],
    ["fe80::1", "a link-local address"],
    ["fe80::1%eth0", "a link-local address"],
    ["fec0::1", "a site-local address"],
    ["ff02::1", "a multicast address"],
    ["::2", "an address outside the global unicast range"],
    ["4000::1", "an address outside the global unicast range"],
  ])("refuses the IPv6 address %s as %s", (address, what) => {
    expect(refusedAddress(address)).toBe(what);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860:0:0:0:0:8888", "2a00:1450:4001:80b::200e", "2001:200::1"])(
    "allows the public IPv6 address %s",
    (address) => {
      expect(refusedAddress(address)).toBeUndefined();
    },
  );

  it.each([
    ["::ffff:127.0.0.1", "a loopback address"],
    ["::ffff:7f00:1", "a loopback address"],
    ["::ffff:169.254.169.254", "a link-local address"],
    ["64:ff9b::a00:1", "a private address"],
    ["64:ff9b::192.168.0.1", "a private address"],
    ["2002:a00:1::", "a private address"],
    ["2002:7f00:1:1::1", "a loopback address"],
  ])("judges %s by the IPv4 address it carries", (address, what) => {
    expect(refusedAddress(address)).toBe(what);
  });

  it.each(["::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])(
    "allows %s, which carries a public IPv4 address",
    (address) => {
      expect(refusedAddress(address)).toBeUndefined();
    },
  );

  it("refuses text that is not an IP address", () => {
    expect(refusedAddress("api.example.com")).toBe("not an IP address");
    expect(refusedAddress("")).toBe("not an IP address");
  });
});

describe("unlessAborted", () => {
  it("returns the promise's result when the signal stays quiet", async () => {
    await expect(unlessAborted(Promise.resolve("done"), new AbortController().signal)).resolves.toBe("done");
  });

  it("passes the promise's own rejection through", async () => {
    await expect(unlessAborted(Promise.reject(new Error("lookup failed")), new AbortController().signal)).rejects.toThrow(
      "lookup failed",
    );
  });

  it("refuses at once when the signal has already aborted, and keeps the promise's rejection handled", async () => {
    const controller = new AbortController();
    controller.abort();
    let fail: (error: Error) => void = () => undefined;
    const pending = new Promise<string>((_resolve, reject) => {
      fail = reject;
    });
    const result = unlessAborted(pending, controller.signal);
    await expect(result).rejects.toMatchObject({
      code: "not_sent",
      sent: false,
      message: "The call was cancelled before it was sent.",
    });
    // A later rejection of the abandoned promise must not surface as unhandled.
    fail(new Error("too late"));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it("rejects with the signal's reason when that is a TransportError", async () => {
    const controller = new AbortController();
    const result = unlessAborted(never<string>(), controller.signal);
    const reason = new TransportError("timeout", "The call passed its 50 ms deadline before it was sent.", false);
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
  });

  it("rejects with not_sent when the signal aborts for another reason", async () => {
    const controller = new AbortController();
    const result = unlessAborted(never<string>(), controller.signal);
    controller.abort(new Error("stop"));
    await expect(result).rejects.toMatchObject({ code: "not_sent", sent: false });
  });

  it("stops listening once the promise settles", async () => {
    const controller = new AbortController();
    const result = unlessAborted(Promise.resolve(1), controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    await result;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("resolvePublicAddress", () => {
  const quiet = (): AbortSignal => new AbortController().signal;

  it("returns a public IP literal without a lookup", async () => {
    const find = vi.fn(lookupOf("10.0.0.1"));
    await expect(resolvePublicAddress("93.184.216.34", quiet(), find)).resolves.toBe("93.184.216.34");
    expect(find).not.toHaveBeenCalled();
  });

  it.each([
    ["127.0.0.1", "127.0.0.1 is a loopback address"],
    ["169.254.169.254", "169.254.169.254 is a link-local address"],
    ["10.1.2.3", "10.1.2.3 is a private address"],
  ])("refuses the IP literal %s", async (host, start) => {
    const find = vi.fn(lookupOf("93.184.216.34"));
    await expect(resolvePublicAddress(host, quiet(), find)).rejects.toMatchObject({
      name: "TransportError",
      code: "refused_address",
      sent: false,
      message: `${start}${REFUSAL_TAIL}`,
    });
    expect(find).not.toHaveBeenCalled();
  });

  it("returns the first address a public host resolves to", async () => {
    const find = vi.fn(lookupOf("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"));
    await expect(resolvePublicAddress("api.example.com", quiet(), find)).resolves.toBe("93.184.216.34");
    expect(find).toHaveBeenCalledWith("api.example.com");
  });

  it("refuses a host when any address it resolves to is not public", async () => {
    await expect(
      resolvePublicAddress("api.example.com", quiet(), lookupOf("93.184.216.34", "10.0.0.1")),
    ).rejects.toMatchObject({
      code: "refused_address",
      sent: false,
      message: `api.example.com resolves to 10.0.0.1, a private address${REFUSAL_TAIL}`,
    });
  });

  it("refuses a host that resolves to an IPv6 loopback address", async () => {
    await expect(resolvePublicAddress("rebind.example.com", quiet(), lookupOf("::1"))).rejects.toMatchObject({
      code: "refused_address",
      message: `rebind.example.com resolves to ::1, a loopback address${REFUSAL_TAIL}`,
    });
  });

  it("reports a host that resolves to no address as not sent", async () => {
    await expect(resolvePublicAddress("empty.example.com", quiet(), lookupOf())).rejects.toMatchObject({
      code: "not_sent",
      sent: false,
      message: "empty.example.com did not resolve to any address.",
    });
  });

  it("reports a failed lookup as not sent, with the resolver's message", async () => {
    const find: AddressLookup = () => Promise.reject(new Error("getaddrinfo ENOTFOUND missing.example.com"));
    await expect(resolvePublicAddress("missing.example.com", quiet(), find)).rejects.toMatchObject({
      code: "not_sent",
      sent: false,
      message: "missing.example.com did not resolve: getaddrinfo ENOTFOUND missing.example.com",
    });
  });

  it("passes a lookup's TransportError through", async () => {
    const refusal = new TransportError("refused_host", "The resolver refuses this host.", false);
    await expect(resolvePublicAddress("api.example.com", quiet(), () => Promise.reject(refusal))).rejects.toBe(refusal);
  });

  it("refuses at once when the signal has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(resolvePublicAddress("api.example.com", controller.signal, () => never())).rejects.toMatchObject({
      code: "not_sent",
      message: "The call was cancelled before it was sent.",
    });
  });

  it("stops waiting for the lookup when the signal aborts", async () => {
    const controller = new AbortController();
    const result = resolvePublicAddress("slow.example.com", controller.signal, () => never());
    const reason = new TransportError("timeout", "The call passed its 30000 ms deadline before it was sent.", false);
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
  });

  it("asks the system resolver by default, and refuses localhost", async () => {
    await expect(resolvePublicAddress("localhost", quiet())).rejects.toMatchObject({
      code: "refused_address",
      sent: false,
      message: expect.stringMatching(/^localhost resolves to \S+, a loopback address, and the cloud network/),
    });
  });
});
