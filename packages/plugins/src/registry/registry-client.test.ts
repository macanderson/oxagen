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
        { server: { name: "io.x/a", description: "d", version: "1.0.0" }, _meta: { isLatest: true } },
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
    await listServers(BASE, { cursor: "c1", search: "git", updatedSince: "2026-01-01T00:00:00Z" });
    const calledUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("cursor=c1");
    expect(calledUrl).toContain("search=git");
    expect(calledUrl).toContain("updated_since=2026-01-01");
  });

  it("throws on a non-ok response", async () => {
    mockFetchOnce({ error: "boom" }, false);
    await expect(listServers(BASE, {})).rejects.toThrow(/registry list failed/i);
  });

  it("fetches a single server version", async () => {
    mockFetchOnce({
      server: { name: "io.x/a", description: "d", version: "2.0.0" },
      _meta: { isLatest: true },
    });
    const res = await getServerVersion(BASE, "io.x/a", "latest");
    expect(res.server.version).toBe("2.0.0");
  });
});
