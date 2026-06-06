import { describe, expect, it, vi } from "vitest";
import { syncRegistry, type SyncPersistence, type SyncDeps } from "./sync-service";
import type { ServerResponse } from "./types";

const REG = { id: "reg-1", baseUrl: "https://r", lastSyncedAt: null as Date | null };

function resp(name: string, version: string, isLatest: boolean): ServerResponse {
  return { server: { name, description: "d", version }, _meta: { isLatest, status: "active" } };
}

function fakePersistence() {
  const upserts: Array<{ name: string; version: string; isLatest: boolean }> = [];
  const markedNotLatest: string[] = [];
  let checkpoint: { cursor: string | undefined; at: Date } | null = null;
  const p: SyncPersistence = {
    getRegistry: async () => REG,
    markOthersNotLatest: async (_regId, name) => {
      markedNotLatest.push(name);
    },
    upsertCatalogRow: async (row) => {
      upserts.push({ name: row.name, version: row.version, isLatest: row.isLatest });
      return "cat-" + row.name;
    },
    getReadmeFreshness: async () => null,
    setReadme: async () => {},
    updateCheckpoint: async (_regId, cursor, at) => {
      checkpoint = { cursor, at };
    },
  };
  return {
    p,
    upserts,
    markedNotLatest,
    get checkpoint() {
      return checkpoint;
    },
  };
}

describe("syncRegistry", () => {
  it("paginates until nextCursor is absent and upserts every server", async () => {
    const f = fakePersistence();
    const pages = [
      { servers: [resp("io.x/a", "1.0.0", true)], nextCursor: "c2" },
      { servers: [resp("io.x/b", "2.0.0", true)], nextCursor: undefined },
    ];
    let call = 0;
    const deps: SyncDeps = {
      listServers: vi.fn(async () => pages[call++]!),
      fetchAndRenderReadme: vi.fn(async () => "<p>x</p>"),
      now: () => 1_000,
    };
    const result = await syncRegistry("reg-1", { mode: "full" }, f.p, deps);
    expect(result.upserted).toBe(2);
    expect(f.upserts.map((u) => u.name)).toEqual(["io.x/a", "io.x/b"]);
    expect(deps.listServers).toHaveBeenCalledTimes(2);
  });

  it("marks prior latest false before upserting a new latest version", async () => {
    const f = fakePersistence();
    const deps: SyncDeps = {
      listServers: vi.fn(async () => ({ servers: [resp("io.x/a", "3.0.0", true)], nextCursor: undefined })),
      fetchAndRenderReadme: vi.fn(async () => null),
      now: () => 1_000,
    };
    await syncRegistry("reg-1", { mode: "incremental" }, f.p, deps);
    expect(f.markedNotLatest).toContain("io.x/a");
  });

  it("passes updated_since on incremental sync when lastSyncedAt is set", async () => {
    const f = fakePersistence();
    f.p.getRegistry = async () => ({ ...REG, lastSyncedAt: new Date("2026-01-01T00:00:00Z") });
    const listServers = vi.fn(
      async (_baseUrl: string, _opts: { cursor?: string; limit?: number; updatedSince?: string }) => ({
        servers: [],
        nextCursor: undefined,
      }),
    );
    await syncRegistry("reg-1", { mode: "incremental" }, f.p, {
      listServers,
      fetchAndRenderReadme: vi.fn(),
      now: () => 1,
    });
    expect(listServers.mock.calls[0]?.[1].updatedSince).toBe("2026-01-01T00:00:00.000Z");
  });

  it("checkpoints after the run", async () => {
    const f = fakePersistence();
    const deps: SyncDeps = {
      listServers: vi.fn(async () => ({ servers: [], nextCursor: undefined })),
      fetchAndRenderReadme: vi.fn(),
      now: () => 42,
    };
    await syncRegistry("reg-1", { mode: "full" }, f.p, deps);
    expect(f.checkpoint).not.toBeNull();
    expect(f.checkpoint!.at).toBeInstanceOf(Date);
  });
});
