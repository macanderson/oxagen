import { describe, expect, it } from "vitest";
import { gatewayModels } from "@oxagen/ai/catalog";
import { modelCapabilityList } from "@oxagen/oxagen/contracts/model.capability.list";
import { modelCapabilityListHandler } from "./model.capability.list";
import type { CapabilityContext } from "@oxagen/oxagen";

// The handler is pure projection over a static registry, so these tests need no
// DB, no tenant scope, and no mocks — which is itself the point: the posture
// matrix is compile-time complete, so there is no I/O that could fail.

const ctx = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
} as unknown as CapabilityContext;

async function run(input: Record<string, unknown>) {
  const out = await modelCapabilityListHandler(input, ctx);
  // Parse through the contract so a drift between handler and schema fails here.
  return modelCapabilityList.output.parse(out);
}

describe("list_model_capabilities handler", () => {
  it("returns every vendor when no filter is supplied", async () => {
    const out = await run({});
    const catalogVendors = [
      ...new Set(gatewayModels.map((m) => m.vendor)),
    ].sort();
    expect(out.vendors.map((v) => v.vendor)).toEqual(catalogVendors);
    expect(out.unknownFilter).toBeNull();
  });

  it("joins each vendor to the catalog models that ship under it", async () => {
    const out = await run({});
    const anthropic = out.vendors.find((v) => v.vendor === "anthropic");
    expect(anthropic?.label).toBe("Anthropic");
    expect(anthropic?.models.length).toBeGreaterThan(0);
    for (const id of anthropic?.models ?? []) {
      expect(id.startsWith("anthropic/")).toBe(true);
    }
  });

  it("filters to one vendor", async () => {
    const out = await run({ vendor: "openai" });
    expect(out.vendors).toHaveLength(1);
    expect(out.vendors[0]?.vendor).toBe("openai");
    expect(out.unknownFilter).toBeNull();
  });

  it("resolves a gateway model id to its vendor's posture", async () => {
    const out = await run({ model: "anthropic/claude-sonnet-5" });
    expect(out.vendors).toHaveLength(1);
    expect(out.vendors[0]?.vendor).toBe("anthropic");
    expect(out.vendors[0]?.cache.kind).toBe("opt-in");
  });

  it("prefers the model filter over the vendor filter", async () => {
    const out = await run({
      vendor: "openai",
      model: "anthropic/claude-sonnet-5",
    });
    expect(out.vendors[0]?.vendor).toBe("anthropic");
  });

  it("reports an unknown vendor as unknown rather than as an empty success", async () => {
    const out = await run({ vendor: "some-byok-provider" });
    expect(out.vendors).toHaveLength(0);
    expect(out.unknownFilter).toBe("some-byok-provider");
  });

  it("reports an unknown model id as unknown", async () => {
    const out = await run({ model: "some-byok-provider/mystery-model" });
    expect(out.vendors).toHaveLength(0);
    expect(out.unknownFilter).toBe("some-byok-provider/mystery-model");
  });

  it("surfaces the Anthropic opt-in cache mechanism and its witness", async () => {
    const out = await run({ vendor: "anthropic" });
    const cache = out.vendors[0]?.cache;
    expect(cache?.kind).toBe("opt-in");
    if (cache?.kind !== "opt-in") throw new Error("unreachable");
    expect(cache.mechanism).toMatch(/cacheControl/);
    expect(cache.witness.length).toBeGreaterThan(0);
  });

  it("surfaces implicit cache telemetry for the vendors that cache automatically", async () => {
    const out = await run({ vendor: "openai" });
    const cache = out.vendors[0]?.cache;
    expect(cache?.kind).toBe("implicit");
    if (cache?.kind !== "implicit") throw new Error("unreachable");
    expect(cache.telemetry).toMatch(/cacheReadTokens|cached_tokens/);
  });

  it("returns an all-n/a row for the image-only vendor", async () => {
    const out = await run({ vendor: "bfl" });
    const row = out.vendors[0];
    expect(row?.cache.kind).toBe("not-applicable");
    expect(row?.reasoning.kind).toBe("not-applicable");
    expect(row?.structuredOutput.kind).toBe("not-applicable");
    expect(row?.attachments.kind).toBe("not-applicable");
  });
});
