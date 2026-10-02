import { describe, expect, it, vi } from "vitest";
import { searchSteering, type Delivery } from "@oxagen/steering-bundle";
import { createSteeringSearchHandler, steeringScope } from "./steering.search";
import { fixtureDelivery, SCOPE, steeringCtx } from "./steering.test-support";

const delivery = await fixtureDelivery();

describe("search_steering", () => {
  it("searches the versions the caller's workspace reads", async () => {
    const published = vi.fn(() => Promise.resolve(delivery));
    const handler = createSteeringSearchHandler({ published });
    const output = await handler({ query: "refund" }, steeringCtx());
    expect(published).toHaveBeenCalledWith(SCOPE);
    expect(output).toEqual(searchSteering(delivery, { query: "refund" }));
    expect(output.workspace_version).toBe(21);
    expect(output.organization_version).toBe(4);
    expect(output.hits.map((hit) => hit.lineage)).toContain("a-intel.domain.refund");
  });

  it("applies the input's filters and limit", async () => {
    const handler = createSteeringSearchHandler({ published: () => Promise.resolve(delivery) });
    const output = await handler({ kind: "skill", limit: 2 }, steeringCtx());
    expect(output.total).toBe(3);
    expect(output.hits.map((hit) => hit.lineage)).toEqual([
      "a-intel.brand.voice",
      "a-intel.design.house-ui",
    ]);
  });

  it("answers no hits and no versions before anything publishes", async () => {
    const nothing: Delivery = { workspace: null, organization: null };
    const handler = createSteeringSearchHandler({ published: () => Promise.resolve(nothing) });
    expect(await handler({ query: "refund" }, steeringCtx())).toEqual({
      workspace_version: null,
      organization_version: null,
      total: 0,
      hits: [],
    });
  });

  it("refuses input the tool does not take, before it reads a version", async () => {
    const published = vi.fn(() => Promise.resolve(delivery));
    const handler = createSteeringSearchHandler({ published });
    await expect(handler({ query: "refund", scope: "all" }, steeringCtx())).rejects.toThrow();
    expect(published).not.toHaveBeenCalled();
  });

  it("searches the versions a run was delivered when a run calls it", async () => {
    const published = vi.fn(() => Promise.resolve(delivery));
    const handler = createSteeringSearchHandler({ published });
    await handler({ query: "refund" }, steeringCtx("run_1"));
    expect(published).toHaveBeenCalledWith({ ...SCOPE, runId: "run_1" });
  });

  it("scopes a read to the caller's organization and workspace", () => {
    expect(steeringScope(steeringCtx())).toEqual(SCOPE);
  });

  it("scopes a read from a run to that run", () => {
    expect(steeringScope(steeringCtx("run_1"))).toEqual({ ...SCOPE, runId: "run_1" });
  });
});
