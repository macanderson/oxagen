/**
 * catalog-sync.test.ts
 *
 * Unit tests for catalog-sync.ts — covers syncRegistry (paging, upsert, meta
 * extraction, cursor handling, error paths) and syncAllRegistries (multi-registry
 * fan-out, failure isolation, fullSync flag, org/workspace filter forwarding).
 *
 * Mocks:
 *  - @oxagen/database:        withSystemDb is replaced; real schema kept via importOriginal
 *  - @oxagen/plugins/registry: listServers, deriveTransportTypes, deriveAuthKind
 *
 * Real drizzle-orm (eq, and, sql) runs normally — the fake tx ignores WHERE/SET
 * expressions so it never hits a real DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Capture state ─────────────────────────────────────────────────────────────

interface InsertCapture {
  values: unknown[];
}
interface UpdateCapture {
  set: Record<string, unknown>;
}

const state = {
  inserts: [] as InsertCapture[],
  updates: [] as UpdateCapture[],
  /** Queue of arrays returned by each withSystemDb select call. */
  selectQueue: [] as unknown[][],
};

function resetState() {
  state.inserts = [];
  state.updates = [];
  state.selectQueue = [];
}

// ── Fake tx factory ───────────────────────────────────────────────────────────

function makeTx() {
  return {
    insert: (_table: unknown) => ({
      values: (vals: unknown[]) => {
        state.inserts.push({ values: vals });
        return {
          onConflictDoUpdate: (_opts: unknown) => Promise.resolve(),
        };
      },
    }),
    update: (_table: unknown) => ({
      set: (s: Record<string, unknown>) => {
        state.updates.push({ set: s });
        return {
          where: (_cond: unknown) => Promise.resolve(),
        };
      },
    }),
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => {
          // Pop the next pre-seeded result from the queue
          const result = state.selectQueue.shift() ?? [];
          return Promise.resolve(result);
        },
      }),
    }),
  };
}

// ── DB mock ───────────────────────────────────────────────────────────────────

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real, // keep real schema + drizzle helpers
    withSystemDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
  };
});

// ── Registry client mock ──────────────────────────────────────────────────────

const listServersMock = vi.fn();

vi.mock("@oxagen/plugins/registry", () => ({
  listServers: listServersMock,
  deriveTransportTypes: vi.fn().mockReturnValue(["sse"]),
  deriveAuthKind: vi.fn().mockReturnValue("none"),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeServerEntry(
  name: string,
  version = "1.0.0",
  meta?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    server: {
      name,
      version,
      title: `${name} Title`,
      description: `${name} description`,
      icons: [],
      packages: [],
      remotes: [],
      repository: { url: `https://github.com/org/${name}` },
      websiteUrl: `https://${name}.io`,
    },
    _meta: meta ?? null,
  };
}

function makeNamespacedMeta(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    "io.modelcontextprotocol.registry/official": {
      status: "active",
      isLatest: true,
      publishedAt: "2024-01-15T00:00:00Z",
      updatedAt: "2024-06-01T00:00:00Z",
      ...overrides,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetState();
  vi.clearAllMocks();
});

describe("syncRegistry — basic paging", () => {
  it("syncs a single page and updates the registry state", async () => {
    const { syncRegistry } = await import("./catalog-sync");

    listServersMock.mockResolvedValueOnce({
      servers: [makeServerEntry("test-server")],
      nextCursor: undefined,
    });

    const result = await syncRegistry({
      registryId: "reg-1",
      baseUrl: "https://registry.example.com",
    });

    expect(result.registryId).toBe("reg-1");
    expect(result.pagesProcessed).toBe(1);
    expect(result.entriesUpserted).toBe(1);
    expect(result.finalCursor).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // One insert (page upsert) + one update (registry state)
    expect(state.inserts).toHaveLength(1);
    expect(state.updates).toHaveLength(1);

    const stored = state.inserts[0]!.values as unknown[];
    expect(stored).toHaveLength(1);
    const row = stored[0] as Record<string, unknown>;
    expect(row.registryId).toBe("reg-1");
    expect(row.name).toBe("test-server");
    expect(row.version).toBe("1.0.0");
    expect(row.syncedAt).toBeInstanceOf(Date);
  });

  it("pages through multiple pages and accumulates counts", async () => {
    const { syncRegistry } = await import("./catalog-sync");

    listServersMock
      .mockResolvedValueOnce({
        servers: [makeServerEntry("server-a"), makeServerEntry("server-b")],
        nextCursor: "cursor-abc",
      })
      .mockResolvedValueOnce({
        servers: [makeServerEntry("server-c")],
        nextCursor: undefined,
      });

    const result = await syncRegistry({
      registryId: "reg-multi",
      baseUrl: "https://registry.example.com",
    });

    expect(result.pagesProcessed).toBe(2);
    expect(result.entriesUpserted).toBe(3);
    expect(result.finalCursor).toBeNull();
    // Two page inserts + one registry state update
    expect(state.inserts).toHaveLength(2);
    expect(state.updates).toHaveLength(1);

    // Second call was made with the cursor
    expect(listServersMock).toHaveBeenCalledTimes(2);
    expect(listServersMock.mock.calls[1]?.[1]).toMatchObject({
      cursor: "cursor-abc",
    });
  });

  it("stops after an empty first page (0 servers) and still updates state", async () => {
    const { syncRegistry } = await import("./catalog-sync");

    listServersMock.mockResolvedValueOnce({
      servers: [],
      nextCursor: undefined,
    });

    const result = await syncRegistry({
      registryId: "reg-empty",
      baseUrl: "https://r.io",
    });

    expect(result.pagesProcessed).toBe(1);
    expect(result.entriesUpserted).toBe(0);
    // No page inserts, but registry state IS still updated
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set.lastSyncedAt).toBeInstanceOf(Date);
  });

  it("respects maxPages — stops after the configured limit", async () => {
    const { syncRegistry } = await import("./catalog-sync");

    // All pages return a server + a next cursor so pagination would continue forever
    listServersMock.mockResolvedValue({
      servers: [makeServerEntry("server-x")],
      nextCursor: "next",
    });

    const result = await syncRegistry({
      registryId: "reg-limit",
      baseUrl: "https://r.io",
      maxPages: 3,
    });

    expect(result.pagesProcessed).toBe(3);
    expect(listServersMock).toHaveBeenCalledTimes(3);
    // finalCursor should hold the last known cursor
    expect(result.finalCursor).toBe("next");
  });

  it("resumes from a stored cursor for incremental sync", async () => {
    const { syncRegistry } = await import("./catalog-sync");

    listServersMock.mockResolvedValueOnce({
      servers: [],
      nextCursor: undefined,
    });

    await syncRegistry({
      registryId: "reg-incr",
      baseUrl: "https://r.io",
      cursor: "stored-cursor",
    });

    expect(listServersMock).toHaveBeenCalledWith("https://r.io", {
      limit: 100,
      cursor: "stored-cursor",
    });
  });

  it("propagates listServers errors and re-throws", async () => {
    const { syncRegistry } = await import("./catalog-sync");

    listServersMock.mockRejectedValueOnce(new Error("network timeout"));

    await expect(
      syncRegistry({ registryId: "reg-err", baseUrl: "https://r.io" }),
    ).rejects.toThrow("network timeout");
  });
});

describe("syncRegistry — meta extraction", () => {
  it("extracts isLatest and dates from the namespaced _meta key", async () => {
    const { syncRegistry } = await import("./catalog-sync");

    listServersMock.mockResolvedValueOnce({
      servers: [
        makeServerEntry(
          "ns-server",
          "2.0.0",
          makeNamespacedMeta({ isLatest: true }),
        ),
      ],
      nextCursor: undefined,
    });

    await syncRegistry({ registryId: "r1", baseUrl: "https://r.io" });

    const row = (state.inserts[0]!.values as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(row.isLatest).toBe(true);
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(row.upstreamUpdatedAt).toBeInstanceOf(Date);
  });

  it("falls back to flat _meta structure when no namespaced key is present", async () => {
    const { syncRegistry } = await import("./catalog-sync");

    const flatMeta = { status: "deprecated", isLatest: false };
    listServersMock.mockResolvedValueOnce({
      servers: [makeServerEntry("flat-server", "1.0.0", flatMeta)],
      nextCursor: undefined,
    });

    await syncRegistry({ registryId: "r2", baseUrl: "https://r.io" });

    const row = (state.inserts[0]!.values as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(row.status).toBe("deprecated");
    expect(row.isLatest).toBe(false);
  });

  it("returns defaults when _meta is null", async () => {
    const { syncRegistry } = await import("./catalog-sync");

    listServersMock.mockResolvedValueOnce({
      servers: [makeServerEntry("no-meta-server", "1.0.0", undefined)],
      nextCursor: undefined,
    });

    await syncRegistry({ registryId: "r3", baseUrl: "https://r.io" });

    const row = (state.inserts[0]!.values as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(row.status).toBe("active");
    expect(row.isLatest).toBe(false);
    expect(row.publishedAt).toBeNull();
    expect(row.upstreamUpdatedAt).toBeNull();
  });

  it("sets null for publishedAt when the date string is invalid", async () => {
    const { syncRegistry } = await import("./catalog-sync");

    listServersMock.mockResolvedValueOnce({
      servers: [
        makeServerEntry(
          "bad-date",
          "1.0.0",
          makeNamespacedMeta({ publishedAt: "not-a-date", updatedAt: null }),
        ),
      ],
      nextCursor: undefined,
    });

    await syncRegistry({ registryId: "r4", baseUrl: "https://r.io" });

    const row = (state.inserts[0]!.values as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(row.publishedAt).toBeNull();
  });

  it("sets repositoryUrl and websiteUrl from server fields", async () => {
    const { syncRegistry } = await import("./catalog-sync");

    listServersMock.mockResolvedValueOnce({
      servers: [makeServerEntry("rich-server")],
      nextCursor: undefined,
    });

    await syncRegistry({ registryId: "r5", baseUrl: "https://r.io" });

    const row = (state.inserts[0]!.values as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(row.repositoryUrl).toBe("https://github.com/org/rich-server");
    expect(row.websiteUrl).toBe("https://rich-server.io");
  });

  it("handles missing repository and websiteUrl gracefully (null)", async () => {
    const { syncRegistry } = await import("./catalog-sync");

    const entry = {
      server: {
        name: "minimal",
        version: "1.0.0",
        description: "desc",
        title: null,
        icons: [],
        packages: [],
        remotes: [],
        // no repository, no websiteUrl
      },
      _meta: null,
    };

    listServersMock.mockResolvedValueOnce({
      servers: [entry],
      nextCursor: undefined,
    });

    await syncRegistry({ registryId: "r6", baseUrl: "https://r.io" });

    const row = (state.inserts[0]!.values as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(row.repositoryUrl).toBeNull();
    expect(row.websiteUrl).toBeNull();
    expect(row.title).toBeNull();
  });
});

describe("syncAllRegistries", () => {
  it("returns empty result when there are no enabled registries", async () => {
    const { syncAllRegistries } = await import("./catalog-sync");

    // The select query returns no registries
    state.selectQueue.push([]);

    const result = await syncAllRegistries({});

    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("syncs all enabled registries and reports succeeded count", async () => {
    const { syncAllRegistries } = await import("./catalog-sync");

    // The initial select returns 2 registries
    state.selectQueue.push([
      { id: "reg-a", baseUrl: "https://a.io", lastSyncedCursor: null },
      { id: "reg-b", baseUrl: "https://b.io", lastSyncedCursor: "cursor-b" },
    ]);

    // Each syncRegistry call pages once and stops
    listServersMock.mockResolvedValue({ servers: [], nextCursor: undefined });

    const result = await syncAllRegistries({});

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results.map((r) => r.registryId)).toEqual(["reg-a", "reg-b"]);
  });

  it("isolates a failing registry — others still succeed", async () => {
    const { syncAllRegistries } = await import("./catalog-sync");

    state.selectQueue.push([
      { id: "reg-ok", baseUrl: "https://ok.io", lastSyncedCursor: null },
      { id: "reg-fail", baseUrl: "https://fail.io", lastSyncedCursor: null },
    ]);

    listServersMock
      .mockResolvedValueOnce({ servers: [], nextCursor: undefined }) // reg-ok
      .mockRejectedValueOnce(new Error("upstream 503")); // reg-fail

    const result = await syncAllRegistries({});

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0]!.registryId).toBe("reg-ok");
    expect(result.errors[0]!.registryId).toBe("reg-fail");
    expect(result.errors[0]!.error).toContain("upstream 503");
  });

  it("fullSync=true passes null cursor regardless of stored cursor", async () => {
    const { syncAllRegistries } = await import("./catalog-sync");

    state.selectQueue.push([
      {
        id: "reg-full",
        baseUrl: "https://r.io",
        lastSyncedCursor: "old-cursor",
      },
    ]);

    listServersMock.mockResolvedValue({ servers: [], nextCursor: undefined });

    await syncAllRegistries({ fullSync: true });

    // The first listServers call should NOT receive the stored cursor
    expect(listServersMock).toHaveBeenCalledWith("https://r.io", {
      limit: 100,
      cursor: undefined,
    });
  });

  it("incremental sync (fullSync=false) passes the stored cursor", async () => {
    const { syncAllRegistries } = await import("./catalog-sync");

    state.selectQueue.push([
      {
        id: "reg-incr",
        baseUrl: "https://r.io",
        lastSyncedCursor: "stored-cursor",
      },
    ]);

    listServersMock.mockResolvedValue({ servers: [], nextCursor: undefined });

    await syncAllRegistries({ fullSync: false });

    expect(listServersMock).toHaveBeenCalledWith("https://r.io", {
      limit: 100,
      cursor: "stored-cursor",
    });
  });

  it("SyncResult from each registry contains correct metadata", async () => {
    const { syncAllRegistries } = await import("./catalog-sync");

    state.selectQueue.push([
      { id: "reg-z", baseUrl: "https://z.io", lastSyncedCursor: null },
    ]);

    listServersMock.mockResolvedValueOnce({
      servers: [makeServerEntry("s1"), makeServerEntry("s2")],
      nextCursor: undefined,
    });

    const result = await syncAllRegistries({});

    const syncResult = result.results[0]!;
    expect(syncResult.registryId).toBe("reg-z");
    expect(syncResult.pagesProcessed).toBe(1);
    expect(syncResult.entriesUpserted).toBe(2);
    expect(syncResult.durationMs).toBeGreaterThanOrEqual(0);
    expect(syncResult.finalCursor).toBeNull();
  });

  it("passes orgId filter — builds conditions including org id", async () => {
    const { syncAllRegistries } = await import("./catalog-sync");

    // The select for registries returns an empty list; we just want to confirm
    // the orgId branch runs without error.
    state.selectQueue.push([]);

    const result = await syncAllRegistries({ orgId: "org-specific" });

    expect(result.total).toBe(0);
  });

  it("passes workspaceId filter — builds conditions including workspace id", async () => {
    const { syncAllRegistries } = await import("./catalog-sync");

    state.selectQueue.push([]);

    const result = await syncAllRegistries({ workspaceId: "ws-specific" });

    expect(result.total).toBe(0);
  });

  it("passes both orgId and workspaceId together", async () => {
    const { syncAllRegistries } = await import("./catalog-sync");

    state.selectQueue.push([
      {
        id: "reg-scoped",
        baseUrl: "https://scoped.io",
        lastSyncedCursor: null,
      },
    ]);

    listServersMock.mockResolvedValueOnce({
      servers: [],
      nextCursor: undefined,
    });

    const result = await syncAllRegistries({
      orgId: "org-1",
      workspaceId: "ws-1",
    });

    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
  });

  it("catches a non-Error throw and converts it via String()", async () => {
    const { syncAllRegistries } = await import("./catalog-sync");

    state.selectQueue.push([
      { id: "reg-str-err", baseUrl: "https://r.io", lastSyncedCursor: null },
    ]);

    // Throw a plain string (not an Error instance) to exercise String(err)
    listServersMock.mockRejectedValueOnce("plain string error");

    const result = await syncAllRegistries({});

    expect(result.failed).toBe(1);
    expect(result.errors[0]!.error).toBe("plain string error");
  });
});
