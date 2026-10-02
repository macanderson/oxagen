import { describe, expect, it, vi } from "vitest";

const { apiPostOrThrow } = vi.hoisted(() => ({ apiPostOrThrow: vi.fn() }));
vi.mock("../api.js", () => ({ apiPostOrThrow }));

import {
  ago,
  dismissWorkspaceMemories,
  getWorkspaceMemory,
  listWorkspaceMemories,
  promoteWorkspaceMemories,
} from "../workspace-memory-client.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const before = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("ago", () => {
  it.each([
    [null, "Never"],
    [before(20_000), "Just now"],
    [before(5 * 60_000), "5m ago"],
    [before(3 * 3_600_000), "3h ago"],
    [before(47 * 3_600_000), "47h ago"],
    [before(3 * 86_400_000), "3d ago"],
    // A host clock ahead of this one reads as just now.
    [new Date(NOW.getTime() + 60_000).toISOString(), "Just now"],
  ])("%s reads %s", (iso, expected) => {
    expect(ago(iso, NOW)).toBe(expected);
  });
});

describe("the workspace memory routes", () => {
  it("leaves unset list filters out of the body", async () => {
    apiPostOrThrow.mockResolvedValue({});
    await listWorkspaceMemories({ harness: "codex", agent: undefined, limit: 5 });
    expect(apiPostOrThrow).toHaveBeenCalledWith("context/steering/memories/list", {
      harness: "codex",
      limit: 5,
    });
  });

  it("posts each call to its own route", async () => {
    apiPostOrThrow.mockResolvedValue({});
    await getWorkspaceMemory("mem_1");
    await promoteWorkspaceMemories({ drafts: [{ memory_ids: ["mem_1"] }], same_text: true });
    await dismissWorkspaceMemories({ memory_ids: ["mem_1"], restore: true });
    expect(apiPostOrThrow.mock.calls.map(([path]) => path)).toEqual([
      "context/steering/memories/get",
      "context/steering/memories/promote",
      "context/steering/memories/dismiss",
    ]);
    expect(apiPostOrThrow).toHaveBeenCalledWith("context/steering/memories/get", {
      memory_id: "mem_1",
    });
  });
});
