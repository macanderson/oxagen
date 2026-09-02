// @vitest-environment jsdom
/**
 * swarm-session-store.test.ts — unit tests for the sessionStorage-backed
 * client-side swarm tracker (contract-gap workaround — see the module doc).
 *
 * sessionStorage is stubbed with an in-memory Storage implementation — same
 * pattern used for localStorage in conversation-nav.test.tsx — both because
 * jsdom's built-in sessionStorage can be flaky/undefined under some Node
 * versions and so the tests are deterministic and isolated per test.
 *
 * Covers:
 *   - Initial mount is empty when sessionStorage has nothing for the key.
 *   - addSwarm persists to sessionStorage under the org+workspace-scoped key
 *     and prepends (newest first).
 *   - addSwarm with an existing swarmId replaces (dedupes) rather than
 *     duplicating.
 *   - updateSwarm patches the matching record by swarmId and persists.
 *   - refresh() re-reads sessionStorage, picking up writes made by another
 *     hook instance under the same key (the launch dialog vs the table).
 *   - Two different org/workspace scopes never see each other's swarms (key
 *     isolation).
 *   - Corrupt JSON in storage is swallowed — readStore falls back to [].
 *   - A storage write failure (setItem throws) doesn't crash addSwarm/
 *     updateSwarm — it's best-effort persistence only.
 */
import { renderHook, act, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  useSwarmSessionStore,
  type SwarmSessionRecord,
} from "./swarm-session-store";

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

function record(
  overrides: Partial<SwarmSessionRecord> = {},
): SwarmSessionRecord {
  return {
    swarmId: "s1",
    dispatchId: "d1",
    topic: "AI safety funding",
    depth: "medium",
    maxParallel: 5,
    targetLabel: "Topic",
    status: "running",
    completedTasks: 0,
    totalTasks: 8,
    launchedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useSwarmSessionStore — mount", () => {
  it("starts empty when sessionStorage has nothing for this org+workspace", async () => {
    const { result } = renderHook(() => useSwarmSessionStore("acme", "main"));
    // Effect-driven read runs after mount.
    await act(async () => {});
    expect(result.current.swarms).toEqual([]);
  });
});

describe("useSwarmSessionStore — addSwarm", () => {
  it("adds a swarm, persists it, and prepends (newest first)", async () => {
    const { result } = renderHook(() => useSwarmSessionStore("acme", "main"));
    await act(async () => {});

    act(() => result.current.addSwarm(record({ swarmId: "s1" })));
    act(() => result.current.addSwarm(record({ swarmId: "s2" })));

    expect(result.current.swarms.map((s) => s.swarmId)).toEqual(["s2", "s1"]);
    expect(
      sessionStorage.getItem("oxagen:workflows:swarms:acme:main"),
    ).toContain("s2");
  });

  it("replaces (dedupes) an existing swarmId instead of duplicating", async () => {
    const { result } = renderHook(() => useSwarmSessionStore("acme", "main"));
    await act(async () => {});

    act(() =>
      result.current.addSwarm(record({ swarmId: "s1", status: "running" })),
    );
    act(() =>
      result.current.addSwarm(record({ swarmId: "s1", status: "complete" })),
    );

    expect(result.current.swarms).toHaveLength(1);
    expect(result.current.swarms[0]?.status).toBe("complete");
  });
});

describe("useSwarmSessionStore — updateSwarm", () => {
  it("patches the matching record by swarmId and persists the patch", async () => {
    const { result } = renderHook(() => useSwarmSessionStore("acme", "main"));
    await act(async () => {});

    act(() =>
      result.current.addSwarm(record({ swarmId: "s1", completedTasks: 0 })),
    );
    act(() =>
      result.current.updateSwarm("s1", {
        completedTasks: 3,
        status: "complete",
      }),
    );

    expect(result.current.swarms[0]).toMatchObject({
      swarmId: "s1",
      completedTasks: 3,
      status: "complete",
    });
    const persisted = JSON.parse(
      sessionStorage.getItem("oxagen:workflows:swarms:acme:main") ?? "[]",
    ) as SwarmSessionRecord[];
    expect(persisted[0]?.completedTasks).toBe(3);
  });

  it("is a no-op for an unknown swarmId", async () => {
    const { result } = renderHook(() => useSwarmSessionStore("acme", "main"));
    await act(async () => {});
    act(() => result.current.addSwarm(record({ swarmId: "s1" })));
    act(() =>
      result.current.updateSwarm("does-not-exist", { completedTasks: 99 }),
    );
    expect(result.current.swarms).toHaveLength(1);
    expect(result.current.swarms[0]?.completedTasks).toBe(0);
  });
});

describe("useSwarmSessionStore — refresh", () => {
  it("re-reads sessionStorage, picking up a write made by another hook instance", async () => {
    const writer = renderHook(() => useSwarmSessionStore("acme", "main"));
    await act(async () => {});
    act(() => writer.result.current.addSwarm(record({ swarmId: "s1" })));

    const reader = renderHook(() => useSwarmSessionStore("acme", "main"));
    await act(async () => {});
    // The reader mounted after the write, so its own mount-effect already
    // picked it up — clear and re-add via the writer to prove refresh() (not
    // just mount) re-syncs.
    act(() => writer.result.current.addSwarm(record({ swarmId: "s2" })));
    act(() => reader.result.current.refresh());

    expect(reader.result.current.swarms.map((s) => s.swarmId).sort()).toEqual([
      "s1",
      "s2",
    ]);
  });
});

describe("useSwarmSessionStore — key isolation", () => {
  it("two different org/workspace scopes never see each other's swarms", async () => {
    const a = renderHook(() => useSwarmSessionStore("acme", "main"));
    const b = renderHook(() => useSwarmSessionStore("acme", "staging"));
    await act(async () => {});

    act(() => a.result.current.addSwarm(record({ swarmId: "s1" })));

    expect(a.result.current.swarms).toHaveLength(1);
    expect(b.result.current.swarms).toHaveLength(0);
  });
});

describe("useSwarmSessionStore — storage failure resilience", () => {
  it("swallows corrupt JSON in storage and falls back to an empty list", async () => {
    sessionStorage.setItem("oxagen:workflows:swarms:acme:main", "{ not json");
    const { result } = renderHook(() => useSwarmSessionStore("acme", "main"));
    await act(async () => {});
    expect(result.current.swarms).toEqual([]);
  });

  it("swallows a non-array JSON value in storage and falls back to an empty list", async () => {
    sessionStorage.setItem(
      "oxagen:workflows:swarms:acme:main",
      JSON.stringify({ not: "an array" }),
    );
    const { result } = renderHook(() => useSwarmSessionStore("acme", "main"));
    await act(async () => {});
    expect(result.current.swarms).toEqual([]);
  });

  it("doesn't crash addSwarm when sessionStorage.setItem throws (best-effort persistence)", async () => {
    vi.stubGlobal("sessionStorage", {
      ...createMemoryStorage(),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    const { result } = renderHook(() => useSwarmSessionStore("acme", "main"));
    await act(async () => {});
    expect(() => {
      act(() => result.current.addSwarm(record()));
    }).not.toThrow();
    expect(result.current.swarms).toHaveLength(1);
  });
});
