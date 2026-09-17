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
const { BUNDLE_FEATURE_GATEWAY_TOOLS } = await import("@oxagen/tacho");

const NOW = new Date("2026-09-17T09:30:00.000Z");

/** A host row, advertising whichever bundle features the case is about. */
function host(
  bundleFeatures: string[] = [],
): Parameters<typeof unsignedBundle>[0] {
  return {
    publicId: "tch_0123456789abcdefghjkmn",
    status: "active",
    mode: "observe",
    bundleVersionServed: 2,
    bundleFeatures,
  } as Parameters<typeof unsignedBundle>[0];
}

/** A host new enough to parse every field this control plane emits. */
const CURRENT = [BUNDLE_FEATURE_GATEWAY_TOOLS];

function bundle(bundleFeatures: string[] = CURRENT) {
  return unsignedBundle(
    host(bundleFeatures),
    { org: 1, workspace: 1 },
    { mode: "digest_only", classes: [] },
    NOW,
  );
}

/** What goes on the wire: the signature the signer would add. */
function served(bundleFeatures: string[] = CURRENT) {
  return {
    ...bundle(bundleFeatures),
    signature: { key_id: "k1", alg: "ed25519", sig: "sig" },
  };
}

/**
 * `policyBundleSchema` as a host deployed before `gateway_tools` holds it —
 * the same strict object, minus the field.
 *
 * This stand-in is the point of the test. Asserting only that the key is
 * absent proves nothing about an old parser: the field could be absent and
 * some *other* new field present, and the old host would still refuse the
 * mandate. So the assertion is that this schema parses what we serve, and the
 * first case below proves the stand-in is strict — a lenient one would pass
 * every test here for the wrong reason.
 */
const previousPolicyBundleSchema = policyBundleSchema
  .omit({ gateway_tools: true })
  .strict();

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
    const parsed = policyBundleSchema.parse(served());
    expect(parsed.gateway_tools).toEqual(["get_run"]);
  });
});

describe("a host that cannot parse the field is not sent it", () => {
  /**
   * The compatibility direction. The control plane ships before the fleet
   * upgrades, so every bundle it signs is read by parsers that predate every
   * field it has learned to emit.
   */
  it("holds a stand-in for the parser a deployed host still has", () => {
    // Strict, and without the field: exactly what refuses the new mandate.
    gatewayMandateTools.mockReturnValue(["get_run"]);
    expect(() => previousPolicyBundleSchema.parse(served())).toThrow();
  });

  it("omits the field entirely for a host that advertises nothing", () => {
    gatewayMandateTools.mockReturnValue(["get_run", "query_ontology"]);
    // Not an empty array, not null: absent. An empty array would be read as a
    // mandate permitting nothing and take the machine's toolbelt to zero.
    expect(served([])).not.toHaveProperty("gateway_tools");
  });

  it("serves that host a bundle its own parser accepts", () => {
    // The assertion the finding is actually about: the old daemon's
    // `bundleResponseSchema.parse` and the old CLI's enrollment parse both
    // run this schema, and both must succeed or the host is stranded on a
    // stale mandate and a new host cannot enroll at all.
    gatewayMandateTools.mockReturnValue(["get_run", "query_ontology"]);
    expect(() => previousPolicyBundleSchema.parse(served([]))).not.toThrow();
  });

  it("serves the list to a host that advertises the field", () => {
    gatewayMandateTools.mockReturnValue(["get_run", "query_ontology"]);
    expect(served(CURRENT).gateway_tools).toEqual([
      "get_run",
      "query_ontology",
    ]);
    expect(() => policyBundleSchema.parse(served(CURRENT))).not.toThrow();
  });

  it("ignores a feature name it does not know", () => {
    // A host advertising something else has not advertised this.
    gatewayMandateTools.mockReturnValue(["get_run"]);
    expect(served(["some_later_field"])).not.toHaveProperty("gateway_tools");
  });

  it("keeps the etag stable per host, so neither end refetches forever", () => {
    // `controlEnvelope` publishes this etag on every ingest and command poll,
    // and the daemon refetches whenever it differs from the bundle it holds
    // (`daemon.ts`: `if (control.bundle_etag !== host.bundle.etag)`). A gate
    // that answered differently on the two paths would loop forever, which is
    // why it reads a persisted per-host fact and not the request.
    gatewayMandateTools.mockReturnValue(["get_run"]);
    expect(bundle([]).etag).toBe(bundle([]).etag);
    expect(bundle(CURRENT).etag).toBe(bundle(CURRENT).etag);
    expect(bundle([]).etag).not.toBe(bundle(CURRENT).etag);
  });
});
