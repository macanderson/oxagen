import { describe, expect, it, vi } from "vitest";
import { resolveEndpointRedirects } from "./resolve-endpoint";

/** Builds a fetchFn that answers each URL with a canned status/location. */
function fetchStub(
  routes: Record<string, { status: number; location?: string }>,
) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    const route = routes[url];
    if (!route) return new Response(null, { status: 404 });
    return new Response(null, {
      status: route.status,
      headers: route.location ? { location: route.location } : {},
    });
  });
}

describe("resolveEndpointRedirects", () => {
  it("returns the original URL when the endpoint does not redirect", async () => {
    const fetchFn = fetchStub({
      "https://mcp.example.com/mcp": { status: 405 },
    });
    await expect(
      resolveEndpointRedirects("https://mcp.example.com/mcp", { fetchFn }),
    ).resolves.toBe("https://mcp.example.com/mcp");
  });

  it("follows a cross-origin 301 to the real MCP endpoint", async () => {
    // The production case: registry published sh.inference.ac, which 301s to
    // the actual endpoint on a different host.
    const fetchFn = fetchStub({
      "https://sh.inference.ac/": {
        status: 301,
        location: "https://api.inference.sh/mcp",
      },
      "https://api.inference.sh/mcp": { status: 401 },
    });
    await expect(
      resolveEndpointRedirects("https://sh.inference.ac", { fetchFn }),
    ).resolves.toBe("https://api.inference.sh/mcp");
  });

  it("resolves relative redirect targets against the current URL", async () => {
    const fetchFn = fetchStub({
      "https://mcp.example.com/": { status: 308, location: "/mcp" },
      "https://mcp.example.com/mcp": { status: 200 },
    });
    await expect(
      resolveEndpointRedirects("https://mcp.example.com/", { fetchFn }),
    ).resolves.toBe("https://mcp.example.com/mcp");
  });

  it("stops at maxHops on a redirect loop", async () => {
    const fetchFn = fetchStub({
      "https://a.example.com/": {
        status: 301,
        location: "https://b.example.com/",
      },
      "https://b.example.com/": {
        status: 301,
        location: "https://a.example.com/",
      },
    });
    const out = await resolveEndpointRedirects("https://a.example.com/", {
      fetchFn,
      maxHops: 3,
    });
    // Lands on whichever URL the hop budget ran out at — never hangs.
    expect(["https://a.example.com/", "https://b.example.com/"]).toContain(out);
  });

  it("refuses to follow a redirect onto plain http (non-localhost)", async () => {
    const fetchFn = fetchStub({
      "https://mcp.example.com/": {
        status: 301,
        location: "http://insecure.example.com/mcp",
      },
    });
    await expect(
      resolveEndpointRedirects("https://mcp.example.com/", { fetchFn }),
    ).resolves.toBe("https://mcp.example.com/");
  });

  it("allows http on localhost (dev stacks)", async () => {
    const fetchFn = fetchStub({
      "http://localhost:4100/": {
        status: 307,
        location: "http://localhost:4100/mcp",
      },
      "http://localhost:4100/mcp": { status: 401 },
    });
    await expect(
      resolveEndpointRedirects("http://localhost:4100/", { fetchFn }),
    ).resolves.toBe("http://localhost:4100/mcp");
  });

  it("returns the last good URL when fetch throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      resolveEndpointRedirects("https://mcp.example.com/mcp", { fetchFn }),
    ).resolves.toBe("https://mcp.example.com/mcp");
  });

  it("returns the input untouched when it is not a valid URL", async () => {
    const fetchFn = fetchStub({});
    await expect(
      resolveEndpointRedirects("::garbage::", { fetchFn }),
    ).resolves.toBe("::garbage::");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("ignores a 3xx with no Location header", async () => {
    const fetchFn = fetchStub({ "https://mcp.example.com/": { status: 301 } });
    await expect(
      resolveEndpointRedirects("https://mcp.example.com/", { fetchFn }),
    ).resolves.toBe("https://mcp.example.com/");
  });
});
