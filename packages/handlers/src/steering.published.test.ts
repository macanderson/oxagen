import { describe, expect, it, vi } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import type { Delivery } from "@oxagen/steering-bundle";
import { runVersionsUnrecorded, steeringToolsPublished } from "./steering.published";
import { fixtureDelivery, SCOPE } from "./steering.test-support";
import type { TachoPublished } from "./tacho.published";

const delivery = await fixtureDelivery();

function port(overrides: Partial<TachoPublished> = {}): TachoPublished {
  return {
    published: vi.fn(() => Promise.resolve(delivery)),
    readAsset: vi.fn(() => Promise.resolve("body")),
    ...overrides,
  };
}

const FILE = { path: "steering/brand/voice/words.md", blob: "a".repeat(40) };

describe("steeringToolsPublished", () => {
  it("reads the version published now for a call from outside a run", async () => {
    const host = port();
    const reads = steeringToolsPublished(host);
    await expect(reads.published(SCOPE)).resolves.toBe(delivery);
    expect(host.published).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
      runId: null,
    });
  });

  it("answers no versions when nothing has published", async () => {
    const nothing: Delivery = { workspace: null, organization: null };
    const reads = steeringToolsPublished(port({ published: () => Promise.resolve(nothing) }));
    await expect(reads.published(SCOPE)).resolves.toEqual(nothing);
  });

  it("refuses a call from a run before it reads anything", async () => {
    const host = port();
    const reads = steeringToolsPublished(host);
    const call = reads.published({ ...SCOPE, runId: "run_1" });
    await expect(call).rejects.toBeInstanceOf(HandlerError);
    await expect(call).rejects.toMatchObject({
      code: "not_found",
      reason: "steering_run_versions_unrecorded",
    });
    expect(host.published).not.toHaveBeenCalled();
  });

  it("names the run in the refusal", () => {
    expect(runVersionsUnrecorded("run_1").message).toContain("run run_1");
  });

  it("reads a file as the port returns it", async () => {
    const host = port();
    const reads = steeringToolsPublished(host);
    const bundle = delivery.workspace;
    if (bundle === null) throw new Error("the fixture has a workspace version");
    await expect(reads.readFile("workspace", bundle, FILE)).resolves.toBe("body");
    expect(host.readAsset).toHaveBeenCalledWith("workspace", bundle, FILE);
  });

  it("decodes a file the port returns as bytes", async () => {
    const bytes = new TextEncoder().encode("Use the house voice.");
    const reads = steeringToolsPublished(port({ readAsset: () => Promise.resolve(bytes) }));
    const bundle = delivery.workspace;
    if (bundle === null) throw new Error("the fixture has a workspace version");
    await expect(reads.readFile("workspace", bundle, FILE)).resolves.toBe("Use the house voice.");
  });
});
