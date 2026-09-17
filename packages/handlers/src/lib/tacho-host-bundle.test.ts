/**
 * What the policy bundle has to carry for the local MCP gateway to serve a
 * connected app honestly (ADR-078 §4).
 *
 * The gateway key's mandate is a rule over the capability registry — an `mcp`
 * capability that does not mutate and is not high-sensitivity — and only the
 * control plane can evaluate it. `@oxagen/tacho` takes no `@oxagen/*` runtime
 * dependency, so the collector cannot read a capability's surfaces, mutation
 * or sensitivity, and a second copy of the rule living there is the drift that
 * constraint exists to prevent. Without the rule's answer on the wire the
 * gateway forwarded `tools/list` unchanged: the app was shown tools that
 * enforcement could only refuse once one was selected, and a declared
 * `tool_ceiling` counted forbidden tools toward the limit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMandateTools = vi.fn(() => [] as string[]);
vi.mock("@oxagen/iam/machine-key-scope", () => ({
  gatewayMandateTools: () => gatewayMandateTools(),
}));

const { unsignedBundle } = await import("./tacho-host");
const { policyBundleSchema } = await import("@oxagen/oxagen/tacho/schemas");

const NOW = new Date("2026-09-17T09:30:00.000Z");

function host(): Parameters<typeof unsignedBundle>[0] {
  return {
    publicId: "tch_0123456789abcdefghjkmn",
    status: "active",
    mode: "observe",
    bundleVersionServed: 2,
  } as Parameters<typeof unsignedBundle>[0];
}

function bundle() {
  return unsignedBundle(
    host(),
    { org: 1, workspace: 1 },
    { mode: "digest_only", classes: [] },
    NOW,
  );
}

beforeEach(() => {
  gatewayMandateTools.mockReset();
  gatewayMandateTools.mockReturnValue([]);
});

describe("the gateway mandate on the bundle", () => {
  it("signs the tools the mandate permits into the bundle", () => {
    gatewayMandateTools.mockReturnValue(["get_run", "query_ontology"]);
    expect(bundle().gateway_tools).toEqual(["get_run", "query_ontology"]);
  });

  it("omits the field when the registry answers nothing", () => {
    // Absent means *not told*, and the gateway then serves what it is given.
    // An empty list means *permits nothing*, and the gateway serves nothing —
    // the right answer when it is a decision, the wrong one when it is a
    // runtime that has not imported its contracts.
    expect(bundle()).not.toHaveProperty("gateway_tools");
  });

  it("changes the etag when the mandate changes, so a host refetches", () => {
    gatewayMandateTools.mockReturnValue(["get_run"]);
    const narrow = bundle().etag;
    gatewayMandateTools.mockReturnValue(["get_run", "query_ontology"]);
    expect(bundle().etag).not.toBe(narrow);
  });

  it("produces a bundle the host's strict schema accepts", () => {
    // The schema is `.strict()`, so a field the host does not name fails the
    // whole mandate. Parsing here is what proves the two ends agree.
    gatewayMandateTools.mockReturnValue(["get_run"]);
    const parsed = policyBundleSchema.parse({
      ...bundle(),
      signature: { key_id: "k1", alg: "ed25519", sig: "sig" },
    });
    expect(parsed.gateway_tools).toEqual(["get_run"]);
  });
});
