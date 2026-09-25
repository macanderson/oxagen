import { describe, expect, it, vi } from "vitest";
import { probeMcpAuth } from "./mcp-auth-probe";

const ENDPOINT = "https://mcp.example.com/mcp";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** A fetch answering the well-known reads with `meta` and the initialize with `init`. */
function server(meta: () => Promise<Response>, init: () => Promise<Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.includes("/.well-known/") ? meta() : init();
  }) as unknown as typeof fetch;
}

const notFound = () => Promise.resolve(new Response("", { status: 404 }));

describe("probeMcpAuth", () => {
  it("reads OAuth from metadata that names an authorization server", async () => {
    const fetchFn = server(
      () =>
        Promise.resolve(
          json({ authorization_servers: ["https://auth.example.com"] }),
        ),
      () => Promise.reject(new Error("not reached")),
    );
    expect(await probeMcpAuth(ENDPOINT, fetchFn)).toBe("oauth");
  });

  it("reads OAuth from a 401 on initialize", async () => {
    const fetchFn = server(notFound, () =>
      Promise.resolve(new Response("", { status: 401 })),
    );
    expect(await probeMcpAuth(ENDPOINT, fetchFn)).toBe("oauth");
  });

  it("reads an open server only from an initialize that succeeds", async () => {
    const fetchFn = server(
      () => Promise.resolve(json({ resource: ENDPOINT })),
      () => Promise.resolve(json({ jsonrpc: "2.0", id: 0, result: {} })),
    );
    expect(await probeMcpAuth(ENDPOINT, fetchFn)).toBe("none");
  });

  it.each<[string, () => Promise<Response>]>([
    ["a timeout", () => Promise.reject(new DOMException("t", "TimeoutError"))],
    ["a 503", () => Promise.resolve(new Response("", { status: 503 }))],
    ["a 404", () => Promise.resolve(new Response("", { status: 404 }))],
  ])("answers unknown, not open, for %s on initialize", async (_case, init) => {
    expect(await probeMcpAuth(ENDPOINT, server(notFound, init))).toBe(
      "unknown",
    );
  });

  it("answers unknown for an endpoint that is not a URL", async () => {
    expect(
      await probeMcpAuth("not a url", vi.fn() as unknown as typeof fetch),
    ).toBe("unknown");
  });
});
