import { describe, expect, it, vi } from "vitest";
import { createMcpOAuthFetch } from "./mcp-oauth-fetch";

describe("createMcpOAuthFetch", () => {
  it("refuses a private address before any request is made", async () => {
    const impl = vi.fn();
    const guarded = createMcpOAuthFetch(impl as unknown as typeof fetch);
    await expect(
      guarded("http://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow(/Refusing an MCP authorization request/);
    expect(impl).not.toHaveBeenCalled();
  });

  it("follows a redirect itself, so a hop to a private host is refused", async () => {
    const impl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://10.0.0.5/token" },
        }),
    );
    const guarded = createMcpOAuthFetch(impl as unknown as typeof fetch);
    await expect(guarded("https://auth.example.com/start")).rejects.toThrow(
      /Refusing an MCP authorization request/,
    );
    expect(impl).toHaveBeenCalledTimes(1);
    const init = (impl.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
  });

  it("follows a public redirect and returns the final response", async () => {
    const impl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: "/moved" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const guarded = createMcpOAuthFetch(impl as unknown as typeof fetch);
    const res = await guarded("https://a.example.com/x");
    expect(await res.text()).toBe("ok");
    expect(String((impl.mock.calls[1] as unknown[])[0])).toBe(
      "https://a.example.com/moved",
    );
  });

  it("stops a redirect loop", async () => {
    const impl = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "/again" } }),
    );
    const guarded = createMcpOAuthFetch(impl as unknown as typeof fetch);
    await expect(guarded("https://a.example.com/x")).rejects.toThrow(
      /too many redirects/,
    );
  });

  it("passes a manual redirect through untouched", async () => {
    const impl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "/elsewhere" },
        }),
    );
    const guarded = createMcpOAuthFetch(impl as unknown as typeof fetch);
    const res = await guarded("https://a.example.com/x", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(impl).toHaveBeenCalledTimes(1);
  });
});
