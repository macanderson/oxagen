/**
 * withToolProjection binds MCP Studio's project() into S5's publish() (M13,
 * #4478). These tests run the real publish() over the fixture steering repo,
 * with project() replaced by a spy, so they show which bundle and which
 * folders the registry receives.
 */
import { NotBuiltError } from "@oxagen/mcp-studio";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import {
  memoryVersionStore,
  publish,
  treeFromFiles,
  type BundleIdentity,
  type PublishDeps,
} from "@oxagen/steering-bundle";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  warmSearch: vi.fn(),
}));

vi.mock("./project", () => ({ project: mocks.project }));
vi.mock("./search-warm", () => ({ warmSearch: mocks.warmSearch }));

import { withToolProjection } from "./publish-deps";

const IDENTITY: BundleIdentity = {
  repository: "github.com/a-intel/oxagen-core-platform",
  scope: "workspace",
  organization: "a-intel",
  workspace: "core-platform",
};
const COMMIT = "b5518188b20ddf02f905fadeaa50d9976abdcc90";
const NOW = new Date("2026-09-27T08:00:00Z");

/** The server folders under tools/servers/ in the fixture repo. */
const FIXTURE_FOLDERS = ["billing", "stripe"];

function deps(store = memoryVersionStore()): PublishDeps {
  return withToolProjection({
    store,
    health: async () => "healthy",
    head: async () => COMMIT,
    tree: async () => treeFromFiles(fixtureRepo()),
    tag: async () => undefined,
    // MCP Studio's compile() is not built yet, so no server compiles.
    compiler: () => {
      throw new NotBuiltError("compile");
    },
    now: () => NOW,
  });
}

describe("withToolProjection", () => {
  beforeEach(() => {
    mocks.project.mockReset();
    mocks.project.mockResolvedValue(null);
    mocks.warmSearch.mockReset();
    mocks.warmSearch.mockResolvedValue(undefined);
  });

  it("makes publish() project the bundle it just built", async () => {
    const result = await publish(deps(), IDENTITY, COMMIT);

    if (result.status !== "published") throw new Error(`The publish ended ${result.status}.`);
    expect(mocks.project).toHaveBeenCalledTimes(1);
    expect(mocks.project).toHaveBeenCalledWith(result.bundle, {
      folders: FIXTURE_FOLDERS,
      now: NOW,
    });
    expect(result.bundle.commit).toBe(COMMIT);
    expect(result.warnings.filter((w) => w.startsWith("The tool registry"))).toEqual([]);
  });

  it("embeds the search entries of the bundle it projected, after the projection", async () => {
    const order: string[] = [];
    mocks.project.mockImplementation(() => {
      order.push("project");
      return Promise.resolve(null);
    });
    mocks.warmSearch.mockImplementation(() => {
      order.push("warm");
      return Promise.resolve();
    });

    const result = await publish(deps(), IDENTITY, COMMIT);

    if (result.status !== "published") throw new Error(`The publish ended ${result.status}.`);
    expect(mocks.warmSearch).toHaveBeenCalledTimes(1);
    expect(mocks.warmSearch).toHaveBeenCalledWith(result.bundle);
    expect(order).toEqual(["project", "warm"]);
  });

  it("embeds nothing when the projection fails", async () => {
    mocks.project.mockRejectedValueOnce(new Error("connection reset"));

    await expect(publish(deps(), IDENTITY, COMMIT)).rejects.toThrow("connection reset");
    expect(mocks.warmSearch).not.toHaveBeenCalled();
  });

  it("publishes nothing when the projection fails", async () => {
    const store = memoryVersionStore();
    mocks.project.mockRejectedValueOnce(new Error("connection reset"));

    await expect(publish(deps(store), IDENTITY, COMMIT)).rejects.toThrow("connection reset");
    expect(store.published.size).toBe(0);
    expect(store.versions.size).toBe(0);
  });

  it("keeps every other dependency the publisher passed", () => {
    const store = memoryVersionStore();
    const built = deps(store);

    expect(built.store).toBe(store);
    expect(built.now()).toBe(NOW);
    expect(built.project).toBeTypeOf("function");
  });
});
