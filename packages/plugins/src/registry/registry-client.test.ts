import { describe, expect, it, vi, afterEach } from "vitest";
import { listServers, getServerVersion } from "./registry-client";

const BASE = "https://registry.example.com";

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("registry-client", () => {
  it("lists servers and returns the next cursor", async () => {
    mockFetchOnce({
      servers: [
        {
          server: { name: "io.x/a", description: "d", version: "1.0.0" },
          _meta: { isLatest: true },
        },
      ],
      metadata: { nextCursor: "cur-2", count: 1 },
    });
    const res = await listServers(BASE, { limit: 50 });
    expect(res.servers).toHaveLength(1);
    expect(res.servers[0]?.server.name).toBe("io.x/a");
    expect(res.nextCursor).toBe("cur-2");
  });

  it("passes cursor/search/updatedSince as query params", async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ servers: [] }),
      text: async () => "{}",
    }));
    vi.stubGlobal("fetch", fetchMock);
    await listServers(BASE, {
      cursor: "c1",
      search: "git",
      updatedSince: "2026-01-01T00:00:00Z",
    });
    const calledUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("cursor=c1");
    expect(calledUrl).toContain("search=git");
    expect(calledUrl).toContain("updated_since=2026-01-01");
  });

  it("clamps limit to 100 — the MCP Registry API returns 422 for limit > 100", async () => {
    const fetchMock = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ servers: [] }),
      text: async () => "{}",
    }));
    vi.stubGlobal("fetch", fetchMock);
    await listServers(BASE, { limit: 200, search: "supabase" });
    const calledUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("limit=100");
    expect(calledUrl).not.toContain("limit=200");
  });

  it("throws on a non-ok response", async () => {
    mockFetchOnce({ error: "boom" }, false);
    await expect(listServers(BASE, {})).rejects.toThrow(
      /registry list failed/i,
    );
  });

  it("fetches a single server version", async () => {
    mockFetchOnce({
      server: { name: "io.x/a", description: "d", version: "2.0.0" },
      _meta: { isLatest: true },
    });
    const res = await getServerVersion(BASE, "io.x/a", "latest");
    expect(res.server.version).toBe("2.0.0");
  });

  // ── Null-field tolerance ──────────────────────────────────────────────────────
  // The live MCP Registry (registry.modelcontextprotocol.io) returns `null` for
  // icons/packages/remotes on servers that haven't declared them. The schema
  // must accept `null`, not just `undefined`, or the whole registry fetch fails.

  it("parses a server with null packages and null remotes without throwing", async () => {
    mockFetchOnce({
      servers: [
        {
          server: {
            name: "io.x/nullish",
            description: "A server with null array fields",
            version: "1.0.0",
            packages: null,
            remotes: null,
          },
        },
      ],
    });
    const res = await listServers(BASE, {});
    expect(res.servers).toHaveLength(1);
    const sd = res.servers[0]!.server;
    expect(sd.packages).toBeNull();
    expect(sd.remotes).toBeNull();
  });

  it("parses a server with null icons without throwing", async () => {
    mockFetchOnce({
      servers: [
        {
          server: {
            name: "io.x/no-icons",
            description: "A server that has no icons",
            version: "1.2.0",
            icons: null,
          },
        },
      ],
    });
    const res = await listServers(BASE, {});
    expect(res.servers).toHaveLength(1);
    expect(res.servers[0]!.server.icons).toBeNull();
  });

  it("parses an icon with a non-URL src (Lucide icon name) without throwing", async () => {
    mockFetchOnce({
      servers: [
        {
          server: {
            name: "io.x/lucide-icon",
            description: "Server with a Lucide icon name as src",
            version: "1.0.0",
            icons: [{ src: "video", color: "#f59e0b" }],
          },
        },
      ],
    });
    const res = await listServers(BASE, {});
    const icon = res.servers[0]!.server.icons?.[0];
    expect(icon?.src).toBe("video");
    expect(icon?.color).toBe("#f59e0b");
  });

  it("parses an icon with a hex color field", async () => {
    mockFetchOnce({
      servers: [
        {
          server: {
            name: "io.x/colored",
            description: "Server with colored icon",
            version: "1.0.0",
            icons: [{ src: "https://example.com/icon.png", color: "#6366f1" }],
          },
        },
      ],
    });
    const res = await listServers(BASE, {});
    const icon = res.servers[0]!.server.icons?.[0];
    expect(icon?.color).toBe("#6366f1");
  });

  it("parses a server whose repository omits url/source without dropping the page", async () => {
    // The live MCP Registry returns records whose `repository` object is present
    // but omits `url`/`source`. When those were required, a SINGLE such server
    // threw a ZodError that rejected the ENTIRE /v0.1/servers page (catalog
    // browse/sync returned 0 results). They are now nullish.
    mockFetchOnce({
      servers: [
        {
          server: {
            name: "io.x/partial-repo",
            description: "A server with a repository missing url/source",
            version: "1.0.0",
            repository: { id: "abc123" },
          },
        },
        {
          server: {
            name: "io.x/ok",
            description: "Fully-formed",
            version: "1.0.0",
          },
        },
      ],
    });
    const res = await listServers(BASE, {});
    // Both servers survive — the partial repository must not nuke the batch.
    expect(res.servers).toHaveLength(2);
    expect(res.servers[0]!.server.repository?.url).toBeUndefined();
    expect(res.servers[0]!.server.repository?.source).toBeUndefined();
  });

  it("parses a server whose repository has null url/source", async () => {
    mockFetchOnce({
      servers: [
        {
          server: {
            name: "io.x/null-repo",
            description: "repository with explicit null url/source",
            version: "1.0.0",
            repository: { url: null, source: null },
          },
        },
      ],
    });
    const res = await listServers(BASE, {});
    expect(res.servers).toHaveLength(1);
    expect(res.servers[0]!.server.repository?.url).toBeNull();
  });

  it("throws a descriptive error (not a ZodError) when listServers response is malformed", async () => {
    // A response with a server missing required `name` field should fail safeParse
    // and produce a descriptive thrown error (not a raw ZodError crash).
    mockFetchOnce({
      servers: [
        {
          server: {
            // missing: name, description, version
            title: "Broken Server",
          },
        },
      ],
    });
    await expect(listServers(BASE, {})).rejects.toThrow(/failed validation/i);
  });

  it("throws a descriptive error when getServerVersion response is malformed", async () => {
    mockFetchOnce({
      server: {
        // missing required fields
        title: "Broken",
      },
    });
    await expect(getServerVersion(BASE, "io.x/a", "1.0.0")).rejects.toThrow(
      /failed validation/i,
    );
  });
});
