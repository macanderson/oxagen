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

const gatewayMandateTools = vi.fn(() => undefined as string[] | undefined);
vi.mock("@oxagen/iam/machine-key-scope", () => ({
  gatewayMandateTools: () => gatewayMandateTools(),
}));

const { unsignedBundle } = await import("./tacho-host");
const { OBSERVED_ONLY } = await import("./tacho-session-policy");
type TachoSessionPolicy = import("./tacho-session-policy").TachoSessionPolicy;
const { policyBundleSchema } = await import("@oxagen/oxagen/tacho/schemas");
const {
  BUNDLE_FEATURE_GATEWAY_TOOLS,
  BUNDLE_FEATURE_MODEL_ALLOWLIST,
  BUNDLE_FEATURE_MODEL_PRICES,
} = await import("@oxagen/tacho");
const { PROVIDER_RATE_CARD } = await import("@oxagen/billing");

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

function bundle(
  bundleFeatures: string[] = CURRENT,
  sessionPolicy: TachoSessionPolicy = OBSERVED_ONLY,
) {
  return unsignedBundle(
    host(bundleFeatures),
    { org: 1, workspace: 1 },
    { mode: "digest_only", classes: [] },
    null,
    sessionPolicy,
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
  // The uninitialised registry: no mandate to state. Cases that are about a
  // mandate set their own.
  gatewayMandateTools.mockReturnValue(undefined);
});

describe("the gateway mandate on the bundle", () => {
  it("signs the tools the mandate permits into the bundle", () => {
    gatewayMandateTools.mockReturnValue(["get_run", "query_ontology"]);
    expect(bundle().gateway_tools).toEqual(["get_run", "query_ontology"]);
  });

  it("omits the field when there is no mandate to state", () => {
    // `undefined` from the rule is an empty registry: a process that has not
    // imported its contracts. Absent means *not told*, and the gateway then
    // serves what it is given — the right answer when nobody decided
    // anything, and the wrong one for the case below.
    gatewayMandateTools.mockReturnValue(undefined);
    expect(bundle()).not.toHaveProperty("gateway_tools");
  });

  it("emits an explicit empty mandate when the permitted set is empty", () => {
    // The fail-open this guards. A populated registry whose capabilities the
    // rule all refuses — a policy change leaving only mutating or
    // high-sensitivity MCP tools — is a decision that permits nothing, and it
    // has to reach the wire as `[]`. Omitting it would say *not told*, and
    // `gatewayToolsOf` answers *not told* by serving the upstream
    // `tools/list` unfiltered: "permits nothing" would become "serve
    // everything", which is the one outcome the field exists to prevent.
    gatewayMandateTools.mockReturnValue([]);
    expect(bundle()).toHaveProperty("gateway_tools", []);
  });

  it("gives the empty mandate its own etag, distinct from having no mandate", () => {
    // The two must be distinguishable end to end, not just in the object we
    // build: a host holding one has to refetch to reach the other. Equal
    // etags would leave a gateway serving an unfiltered list with no poll
    // that could ever tell it otherwise.
    gatewayMandateTools.mockReturnValue([]);
    const empty = bundle().etag;
    gatewayMandateTools.mockReturnValue(undefined);
    expect(bundle().etag).not.toBe(empty);
  });

  it("puts the empty mandate through the host's strict schema", () => {
    // `[]` has to survive the parse on the host, or the mandate that permits
    // nothing never arrives and the gateway keeps the list it had.
    gatewayMandateTools.mockReturnValue([]);
    expect(policyBundleSchema.parse(served()).gateway_tools).toEqual([]);
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

describe("the prices the host's model proxy needs (ADR-094)", () => {
  it("are signed into the bundle for a host that can parse them", () => {
    const prices = served([BUNDLE_FEATURE_MODEL_PRICES]).model_prices ?? [];
    expect(prices.length).toBeGreaterThan(0);
    expect(new Set(prices.map((row) => row.provider))).toEqual(
      new Set(["anthropic", "openai"]),
    );
    // One row, checked against the card it came from, in micro-USD per 1M.
    const [model, rate] = Object.entries(PROVIDER_RATE_CARD).find(
      ([, r]) => r.provider === "anthropic",
    )!;
    expect(prices.find((row) => row.model === model)).toEqual({
      provider: "anthropic",
      model,
      input: Math.round(rate.inputPer1M * 1_000_000),
      output: Math.round(rate.outputPer1M * 1_000_000),
      cache_read: Math.round(rate.cachedInputPer1M * 1_000_000),
      cache_write: Math.round(rate.cacheWritePer1M * 1_000_000),
      cache_write_1h: Math.round(rate.inputPer1M * 2 * 1_000_000),
    });
    expect(prices.map((row) => row.model)).toEqual(
      [...prices.map((row) => row.model)].sort((a, b) => a.localeCompare(b)),
    );
    expect(() =>
      policyBundleSchema.parse(served([BUNDLE_FEATURE_MODEL_PRICES])),
    ).not.toThrow();
  });

  it("are withheld from a host that did not name the field, which would refuse the whole mandate", () => {
    expect(served(CURRENT)).not.toHaveProperty("model_prices");
    expect(served([])).not.toHaveProperty("model_prices");
    const older = policyBundleSchema.omit({ model_prices: true }).strict();
    expect(() => older.parse(served(CURRENT))).not.toThrow();
    expect(() => older.parse(served([BUNDLE_FEATURE_MODEL_PRICES]))).toThrow();
  });

  it("move the etag only when a price does", () => {
    expect(bundle([BUNDLE_FEATURE_MODEL_PRICES]).etag).toBe(
      bundle([BUNDLE_FEATURE_MODEL_PRICES]).etag,
    );
    expect(bundle([BUNDLE_FEATURE_MODEL_PRICES]).etag).not.toBe(
      bundle(CURRENT).etag,
    );
  });
});

describe("the wrapped-session policy on the bundle", () => {
  it("signs the workspace's own mode and ceiling, not a literal", () => {
    // The defect this table was added for: `budget.mode` was the string
    // "observed" in the source, so the proxy's `session_budget_exceeded`
    // branch was real code nothing in production could reach
    // (docs/audits/2026-09-21-model-gateway-arming.md §2).
    expect(bundle(CURRENT).budget).toEqual({ mode: "observed" });
    expect(
      bundle(CURRENT, {
        mode: "enforced",
        sessionLimitUsd: 25,
        modelAllow: null,
        modelDeny: [],
      }).budget,
    ).toEqual({ mode: "enforced", session_limit_usd: 25 });
  });

  it("omits the ceiling rather than sending a null one", () => {
    // `session_limit_usd` is `.optional()`, not nullable, so a workspace with
    // no ceiling has to leave the key out or the host refuses the mandate.
    const armed = bundle(CURRENT, {
      mode: "enforced",
      sessionLimitUsd: null,
      modelAllow: [],
      modelDeny: [],
    });
    expect(armed.budget).toEqual({ mode: "enforced" });
    expect(armed.budget).not.toHaveProperty("session_limit_usd");
  });

  it("sends the model lists only to a host that named the field", () => {
    const policy = {
      mode: "enforced" as const,
      sessionLimitUsd: null,
      modelAllow: ["claude-opus-*"],
      modelDeny: ["gpt-4o"],
    };
    // A host that did not advertise is never told, because the host's schema
    // is strict and would refuse the whole mandate over the one field.
    expect(bundle(CURRENT, policy)).not.toHaveProperty("models");
    expect(bundle([], policy)).not.toHaveProperty("models");
    const told = bundle([BUNDLE_FEATURE_MODEL_ALLOWLIST], policy);
    expect(told.models).toEqual({
      allow: ["claude-opus-*"],
      deny: ["gpt-4o"],
    });
    const older = policyBundleSchema.omit({ models: true }).strict();
    expect(() =>
      older.parse({
        ...told,
        signature: { key_id: "k", alg: "ed25519", sig: "s" },
      }),
    ).toThrow();
  });

  it("keeps a null allowlist apart from an empty one, all the way to the etag", () => {
    // Collapsing the two would make "permit nothing" mean "permit
    // everything" on the host, which is the fail-open `gateway_tools`
    // documents. Asserting the etag as well as the value proves the
    // difference survives into the field the host refetches on.
    const features = [BUNDLE_FEATURE_MODEL_ALLOWLIST];
    const base = {
      mode: "enforced" as const,
      sessionLimitUsd: 1,
      modelDeny: [],
    };
    const none = bundle(features, { ...base, modelAllow: null });
    const nothing = bundle(features, { ...base, modelAllow: [] });
    expect(none.models).toEqual({ allow: null, deny: [] });
    expect(nothing.models).toEqual({ allow: [], deny: [] });
    expect(none.etag).not.toBe(nothing.etag);
  });

  it("moves the etag when the policy moves", () => {
    const observed = bundle(CURRENT);
    const enforced = bundle(CURRENT, {
      mode: "enforced",
      sessionLimitUsd: 5,
      modelAllow: null,
      modelDeny: [],
    });
    expect(enforced.etag).not.toBe(observed.etag);
  });
});
