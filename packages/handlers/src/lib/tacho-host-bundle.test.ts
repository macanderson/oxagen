import { evaluatePreToolUse } from "@oxagen/tacho/host";
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
import { generateKeyPairSync } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { bundleSignerFromPem, verifyBundle } from "./tacho-bundle-signing";

const policyRead = vi.hoisted(() => vi.fn());
vi.mock("./tacho-session-policy", () => ({
  readTachoSessionPolicyIn: policyRead,
}));

const selectAgentDaySpend = vi.hoisted(() => vi.fn());
vi.mock("@oxagen/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/telemetry")>()),
  selectAgentDaySpend,
}));

const gatewayMandateTools = vi.fn(() => undefined as string[] | undefined);
vi.mock("@oxagen/iam/machine-key-scope", () => ({
  gatewayMandateTools: () => gatewayMandateTools(),
}));

// The clause's reads have their own suite (tacho-unbound-repo.test.ts). Here
// the question is who asks for it and where it lands.
const resolveUnboundRepo = vi.hoisted(() => vi.fn());
vi.mock("./tacho-unbound-repo", () => ({ resolveUnboundRepo }));

const { agentDaySpend, resolveHostMandate, signBundle, unsignedBundle } =
  await import("./tacho-host");
const { policyBundleSchema } = await import("@oxagen/oxagen/tacho/schemas");
const {
  BUNDLE_FEATURE_CONTAINMENT,
  BUNDLE_FEATURE_DAILY_BUDGET,
  BUNDLE_FEATURE_GATEWAY_TOOLS,
  BUNDLE_FEATURE_MODEL_ALLOWLIST,
  BUNDLE_FEATURE_INDEPENDENT_MODELS,
  BUNDLE_FEATURE_MODEL_PRICES,
  BUNDLE_FEATURE_STEERING_MANIFEST,
  BUNDLE_FEATURE_UNBOUND_REPO,
} = await import("@oxagen/tacho");
const { assembleWorkspaceSteering } = await import("./tacho-steering");
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

const NO_MANDATE = {
  permissions: { allow: [], deny: [], ask: [] },
  budget: { mode: "observed" as const },
};

/** One must record and one may record: text for the first, a manifest naming both. */
const STEERING = assembleWorkspaceSteering("org", "ws", [
  {
    slug: "no-force-push",
    kind: "constraint",
    force: "must",
    constraintEffect: "forbid",
    statement: "Never force-push.",
    activatedAt: "2026-09-16T00:00:00.000Z",
  },
  {
    slug: "prefer-small-prs",
    kind: "preference",
    force: "may",
    constraintEffect: null,
    statement: "Prefer small pull requests.",
    activatedAt: "2026-09-15T00:00:00.000Z",
  },
]);

function bundle(bundleFeatures: string[] = CURRENT) {
  return unsignedBundle(
    host(bundleFeatures),
    { org: 1, workspace: 1 },
    { mode: "digest_only", classes: [] },
    STEERING,
    NO_MANDATE,
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
});

describe("the steering manifest on the bundle", () => {
  it("signs the text for every host, and the manifest only for a host that can parse it", () => {
    const plain = bundle([]);
    expect(plain.context.system).toBe(STEERING.text);
    expect(plain.context).not.toHaveProperty("manifest");
    // A host deployed before the field parses what it is served.
    expect(() => policyBundleSchema.parse(served([]))).not.toThrow();

    const current = bundle([BUNDLE_FEATURE_STEERING_MANIFEST]);
    expect(current.context.system).toBe(STEERING.text);
    expect(current.context.manifest).toEqual(STEERING.manifest);
    expect(current.context.manifest?.items.map((i) => i.outcome)).toEqual([
      "included",
      "cut",
    ]);
    expect(() =>
      policyBundleSchema.parse(served([BUNDLE_FEATURE_STEERING_MANIFEST])),
    ).not.toThrow();
  });

  it("moves the etag with the manifest, so a host that gains the field refetches once", () => {
    expect(bundle([BUNDLE_FEATURE_STEERING_MANIFEST]).etag).not.toBe(
      bundle([]).etag,
    );
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
  it("does not send independently armed lists to a legacy host", () => {
    const mandate = { ...NO_MANDATE, models: { allow: null, deny: ["*"] } };
    for (const features of [[], [BUNDLE_FEATURE_MODEL_ALLOWLIST]]) {
      expect(
        unsignedBundle(
          host(features),
          { org: 1, workspace: 1 },
          { mode: "digest_only", classes: [] },
          STEERING,
          mandate,
          NOW,
        ),
      ).not.toHaveProperty("models");
    }
  });

  it.each(["observed", "enforced"] as const)(
    "resolves model mode %s independently of the agent budget",
    async (mode) => {
      policyRead.mockResolvedValue({
        mode,
        modelAllow: ["claude-*"],
        modelDeny: ["claude-old"],
        sessionLimitUsd: 99,
      });
      const current = {
        ...host([BUNDLE_FEATURE_INDEPENDENT_MODELS]),
        agentId: null,
        agentPrincipalId: null,
      };
      const tx = {
        query: { workspaces: { findFirst: async () => undefined } },
      } as unknown as Parameters<typeof resolveHostMandate>[0];
      const mandate = await resolveHostMandate(
        tx,
        { orgId: "o", workspaceId: "w" },
        current,
      );
      expect(policyRead).toHaveBeenCalledWith(tx, "w");
      const result = unsignedBundle(
        current,
        { org: 1, workspace: 1 },
        { mode: "digest_only", classes: [] },
        STEERING,
        mandate,
        NOW,
      );
      expect(result.budget).toEqual({ mode: "observed" });
      expect(result.models).toEqual(
        mode === "enforced"
          ? { allow: ["claude-*"], deny: ["claude-old"] }
          : undefined,
      );
      const withBudget = unsignedBundle(
        current,
        { org: 1, workspace: 1 },
        { mode: "digest_only", classes: [] },
        STEERING,
        { ...mandate, budget: { mode: "enforced", session_limit_usd: 2 } },
        NOW,
      );
      expect(withBudget.models).toEqual(result.models);
    },
  );

  it("refuses the field on a host schema that predates it", () => {
    // The gate still has to work when the clause arrives: the host's bundle
    // schema is `.strict()`, so an older daemon rejects the whole mandate
    // over the one field rather than ignoring it.
    const older = policyBundleSchema.omit({ models: true }).strict();
    expect(() =>
      older.parse({
        ...bundle(CURRENT),
        models: { allow: null, deny: [] },
        signature: { key_id: "k", alg: "ed25519", sig: "s" },
      }),
    ).toThrow();
  });
});

describe("the active definition budget on the signed bundle", () => {
  function budgetTransaction(
    definitionSource: string,
    activeVersionId: string | null = "version-active",
  ) {
    const findVersion = vi.fn(async (args: unknown) => {
      const { columns } = args as { columns: Record<string, boolean> };
      const row: Record<string, unknown> = { config: {}, definitionSource };
      return Object.fromEntries(
        Object.keys(columns).map((key) => [key, row[key]]),
      );
    });
    const tx = {
      query: {
        agents: { findFirst: vi.fn(async () => ({ activeVersionId })) },
        agentVersions: { findFirst: findVersion },
        workspaces: { findFirst: vi.fn(async () => undefined) },
      },
    } as unknown as Parameters<typeof resolveHostMandate>[0];
    return { tx, findVersion };
  }

  const ctx = { orgId: "org-1", workspaceId: "workspace-1" };
  const governedHost = () => ({
    ...host(),
    agentId: "agent-1",
    agentPrincipalId: null,
  });

  it("signs the editor's TOML budget from the selected active version", async () => {
    // The form writes this inline table. The commit handler preserves config
    // and stores the text as definitionSource; publishing selects this row.
    const { tx, findVersion } = budgetTransaction(
      'schema = "agent-definition/v0.1"\nslug = "review"\nbudget = { per_run_micros = 2500000 }\n[instructions]\nbody = "Review."\n',
    );
    const mandate = await resolveHostMandate(tx, ctx, governedHost());
    const lookup = findVersion.mock.calls[0]?.[0] as { where: SQL };
    expect(new PgDialect().sqlToQuery(lookup.where).params).toEqual([
      "version-active",
    ]);
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = bundleSignerFromPem(
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    const signed = signBundle(
      signer,
      unsignedBundle(
        governedHost(),
        { org: 1, workspace: 1 },
        { mode: "digest_only", classes: [] },
        STEERING,
        mandate,
        NOW,
      ),
    );
    expect(policyBundleSchema.parse(signed).budget).toEqual({
      mode: "enforced",
      session_limit_usd: 2.5,
    });
    expect(verifyBundle(signed, signer.publicKeyPem)).toBe(true);
    expect(
      verifyBundle(
        { ...signed, budget: { mode: "observed" } },
        signer.publicKeyPem,
      ),
    ).toBe(false);
  });

  it.each([
    "[budget",
    "budget = { per_run_micros = nan }",
    "budget = { per_run_micros = 1.5 }",
  ])(
    "signs a suspension for an invalid persisted definition: %s",
    async (source) => {
      const { tx } = budgetTransaction(source);
      const mandate = await resolveHostMandate(tx, ctx, governedHost());
      const { privateKey } = generateKeyPairSync("ed25519");
      const signer = bundleSignerFromPem(
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      );
      const signed = signBundle(
        signer,
        unsignedBundle(
          governedHost(),
          { org: 1, workspace: 1 },
          { mode: "digest_only", classes: [] },
          STEERING,
          mandate,
          NOW,
        ),
      );
      expect(policyBundleSchema.parse(signed).host_status).toBe("suspended");
      expect(verifyBundle(signed, signer.publicKeyPem)).toBe(true);
      expect(
        verifyBundle({ ...signed, host_status: "active" }, signer.publicKeyPem),
      ).toBe(false);
      expect(governedHost().status).toBe("active");
      expect(
        evaluatePreToolUse({
          bundle: signed,
          bundleVerified: true,
          hostStatus: signed.host_status,
          session: {},
          controlReachable: true,
          now: NOW.getTime(),
          toolName: "Bash",
          toolInput: { command: "git push" },
        }).decision,
      ).toBe("deny");
    },
  );

  it("does not arm an unpublished definition when there is no active version", async () => {
    const { tx, findVersion } = budgetTransaction(
      "budget = { per_run_micros = 2500000 }",
      null,
    );
    expect((await resolveHostMandate(tx, ctx, governedHost())).budget).toEqual({
      mode: "observed",
    });
    expect(findVersion).not.toHaveBeenCalled();
  });

  it("keeps a daily-only declaration observed for a host that does not enforce a day (negative)", async () => {
    const { tx } = budgetTransaction("budget = { per_day_micros = 20000000 }");
    expect((await resolveHostMandate(tx, ctx, governedHost())).budget).toEqual({
      mode: "observed",
    });
  });

  it("signs a daily-only declaration, enforced, to a host that advertises daily_budget (ADR-160)", async () => {
    const { tx } = budgetTransaction("budget = { per_day_micros = 20000000 }");
    const dailyHost = {
      ...governedHost(),
      bundleFeatures: [BUNDLE_FEATURE_DAILY_BUDGET],
    };
    const mandate = await resolveHostMandate(tx, ctx, dailyHost);
    expect(mandate.budget).toEqual({ mode: "enforced", daily_limit_usd: 20 });
    const signed = unsignedBundle(
      dailyHost,
      { org: 1, workspace: 1 },
      { mode: "digest_only", classes: [] },
      STEERING,
      mandate,
      NOW,
    );
    expect(signed.budget).toEqual({ mode: "enforced", daily_limit_usd: 20 });
  });

  it("signs both ceilings side by side, and never a zero day", async () => {
    const dailyHost = {
      ...governedHost(),
      bundleFeatures: [BUNDLE_FEATURE_DAILY_BUDGET],
    };
    const both = budgetTransaction(
      "budget = { per_run_micros = 2500000, per_day_micros = 20000000 }",
    );
    expect((await resolveHostMandate(both.tx, ctx, dailyHost)).budget).toEqual({
      mode: "enforced",
      session_limit_usd: 2.5,
      daily_limit_usd: 20,
    });
    const zero = budgetTransaction("budget = { per_day_micros = 0 }");
    expect((await resolveHostMandate(zero.tx, ctx, dailyHost)).budget).toEqual({
      mode: "observed",
    });
  });

  it("reads a containment requirement from the active definition", async () => {
    const { tx } = budgetTransaction(
      'slug = "review"\n[containment]\nrequired = true\n',
    );
    const mandate = await resolveHostMandate(tx, ctx, governedHost());
    expect(mandate.containment).toEqual({ required: true });
    expect(mandate.invalidDefinition).toBeUndefined();
  });

  it("reads required = false as no requirement", async () => {
    const { tx } = budgetTransaction("[containment]\nrequired = false\n");
    expect(
      (await resolveHostMandate(tx, ctx, governedHost())).containment,
    ).toBeUndefined();
  });

  it.each([
    '[containment]\nrequired = "yes"\n',
    '[containment]\nrequired = true\ntier = "gateway"\n',
    'containment = "required"\n',
  ])(
    "suspends governed actions for an invalid containment table: %s",
    async (source) => {
      const { tx } = budgetTransaction(source);
      const mandate = await resolveHostMandate(tx, ctx, governedHost());
      expect(mandate.invalidDefinition).toBe(true);
      expect(mandate.containment).toBeUndefined();
    },
  );
});

describe("a mandate that requires the contained tier (ADR-152)", () => {
  const REQUIRES = { ...NO_MANDATE, containment: { required: true as const } };
  function withMandate(
    features: string[],
    mandate: Parameters<typeof unsignedBundle>[4],
  ) {
    return unsignedBundle(
      host(features),
      { org: 1, workspace: 1 },
      { mode: "digest_only", classes: [] },
      STEERING,
      mandate,
      NOW,
    );
  }

  it("signs the requirement for a host that can read it", () => {
    const result = withMandate(
      [...CURRENT, BUNDLE_FEATURE_CONTAINMENT],
      REQUIRES,
    );
    expect(result.containment).toEqual({ required: true });
    expect(result.host_status).toBe("active");
    expect(
      policyBundleSchema.parse({
        ...result,
        signature: { key_id: "k", alg: "ed25519", sig: "s" },
      }).containment,
    ).toEqual({ required: true });
  });

  it("suspends a host that cannot read it instead of dropping it", () => {
    const result = withMandate(CURRENT, REQUIRES);
    expect(result.containment).toBeUndefined();
    expect(result.host_status).toBe("suspended");
  });

  it("states nothing when the mandate requires nothing", () => {
    const result = withMandate(
      [...CURRENT, BUNDLE_FEATURE_CONTAINMENT],
      NO_MANDATE,
    );
    expect(result).not.toHaveProperty("containment");
    expect(result.host_status).toBe("active");
  });

  it("changes the etag when the requirement changes", () => {
    const features = [...CURRENT, BUNDLE_FEATURE_CONTAINMENT];
    expect(withMandate(features, REQUIRES).etag).not.toBe(
      withMandate(features, NO_MANDATE).etag,
    );
  });
});

describe("the agent's day spend on the control envelope (ADR-160)", () => {
  const NOON = new Date("2026-09-24T12:00:00.000Z");
  const ours = {
    publicId: "tch_ours",
    agentId: "agent-1",
  } as Parameters<typeof agentDaySpend>[1];
  function hostsTransaction(publicIds: string[]) {
    const findMany = vi.fn(async (_args: unknown) =>
      publicIds.map((publicId) => ({ publicId })),
    );
    const tx = {
      query: { tachoHosts: { findMany } },
    } as unknown as Parameters<typeof agentDaySpend>[0];
    return { tx, findMany };
  }

  beforeEach(() => selectAgentDaySpend.mockReset());

  it("splits the agent's UTC day into this host and every other host of the agent", async () => {
    const { tx, findMany } = hostsTransaction([
      "tch_ours",
      "tch_laptop",
      "tch_ci",
    ]);
    selectAgentDaySpend.mockResolvedValueOnce(
      new Map([
        ["tch_ours", 4_000],
        ["tch_laptop", 1_500],
        ["tch_ci", 500],
      ]),
    );
    expect(await agentDaySpend(tx, ours, NOON)).toEqual({
      day: "2026-09-24",
      this_host_usd_micros: 4_000,
      other_hosts_usd_micros: 2_000,
    });
    expect(selectAgentDaySpend).toHaveBeenCalledWith({
      day: "2026-09-24",
      hostEnrollmentIds: ["tch_ours", "tch_laptop", "tch_ci"],
    });
    // Only this agent's hosts: another agent's spend is not this agent's day.
    const lookup = findMany.mock.calls[0]?.[0] as unknown as { where: SQL };
    const where = new PgDialect().sqlToQuery(lookup.where);
    expect(where.sql).toContain('"agent_id"');
    expect(where.params).toEqual(["agent-1"]);
  });

  it("counts zero for this host when only other hosts spent today", async () => {
    const { tx } = hostsTransaction(["tch_ours", "tch_laptop"]);
    selectAgentDaySpend.mockResolvedValueOnce(new Map([["tch_laptop", 900]]));
    expect(await agentDaySpend(tx, ours, NOON)).toEqual({
      day: "2026-09-24",
      this_host_usd_micros: 0,
      other_hosts_usd_micros: 900,
    });
  });

  it("answers nothing for a host with no agent, and asks no store (negative)", async () => {
    const { tx, findMany } = hostsTransaction([]);
    expect(
      await agentDaySpend(
        tx,
        { ...ours, agentId: null } as Parameters<typeof agentDaySpend>[1],
        NOON,
      ),
    ).toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
    expect(selectAgentDaySpend).not.toHaveBeenCalled();
  });

  it("omits the figure rather than failing the poll when ClickHouse cannot answer (negative)", async () => {
    const { tx } = hostsTransaction(["tch_ours"]);
    selectAgentDaySpend.mockRejectedValueOnce(new Error("store degraded"));
    expect(await agentDaySpend(tx, ours, NOON)).toBeUndefined();
  });
});

describe("the unbound repository clause on the bundle (#3941)", () => {
  const CLAUSE = {
    policy: "ask" as const,
    timeout_ms: 30 * 60 * 1000,
    workspace_slug: "payments",
    config_version: "skl_v3",
    bound_remote_digests: [`sha256:${"a".repeat(64)}`],
    link: { skills_pinned: 4, linked_repositories: 2 },
  };
  const WITH_CLAUSE = { ...NO_MANDATE, unboundRepo: CLAUSE };
  const ASKS = [...CURRENT, BUNDLE_FEATURE_UNBOUND_REPO];

  function withMandate(
    features: string[],
    mandate: Parameters<typeof unsignedBundle>[4],
  ) {
    return unsignedBundle(
      host(features),
      { org: 1, workspace: 1 },
      { mode: "digest_only", classes: [] },
      STEERING,
      mandate,
      NOW,
    );
  }
  const signature = { key_id: "k", alg: "ed25519", sig: "s" };

  beforeEach(() => resolveUnboundRepo.mockReset());

  it("signs the clause for a host that advertised it, and the host's schema parses it", () => {
    const result = withMandate(ASKS, WITH_CLAUSE);
    expect(result.unbound_repo).toEqual(CLAUSE);
    expect(
      policyBundleSchema.parse({ ...result, signature }).unbound_repo,
    ).toEqual(CLAUSE);
  });

  it("withholds it from a host that did not, whose strict parser would refuse the whole mandate", () => {
    const older = policyBundleSchema.omit({ unbound_repo: true }).strict();
    const plain = withMandate(CURRENT, WITH_CLAUSE);
    expect(plain).not.toHaveProperty("unbound_repo");
    expect(() => older.parse({ ...plain, signature })).not.toThrow();
    expect(() =>
      older.parse({ ...withMandate(ASKS, WITH_CLAUSE), signature }),
    ).toThrow();
  });

  it("states nothing when the mandate resolved no clause (skills off)", () => {
    expect(withMandate(ASKS, NO_MANDATE)).not.toHaveProperty("unbound_repo");
  });

  it("moves the etag with the clause, so the host refetches when a repository is bound", () => {
    const before = withMandate(ASKS, WITH_CLAUSE).etag;
    expect(withMandate(ASKS, NO_MANDATE).etag).not.toBe(before);
    const bound = {
      ...NO_MANDATE,
      unboundRepo: {
        ...CLAUSE,
        bound_remote_digests: [
          ...CLAUSE.bound_remote_digests,
          `sha256:${"b".repeat(64)}`,
        ],
      },
    };
    expect(withMandate(ASKS, bound).etag).not.toBe(before);
    expect(withMandate(ASKS, WITH_CLAUSE).etag).toBe(before);
  });

  it("resolves the clause only for a host that advertised it, and puts it on the mandate", async () => {
    const tx = {
      query: { workspaces: { findFirst: async () => undefined } },
    } as unknown as Parameters<typeof resolveHostMandate>[0];
    const ctx = { orgId: "o", workspaceId: "w" };
    const plainHost = {
      ...host(CURRENT),
      agentId: null,
      agentPrincipalId: null,
    };
    resolveUnboundRepo.mockResolvedValue(CLAUSE);
    const plain = await resolveHostMandate(tx, ctx, plainHost);
    expect(resolveUnboundRepo).not.toHaveBeenCalled();
    expect(plain).not.toHaveProperty("unboundRepo");

    const asking = { ...host(ASKS), agentId: null, agentPrincipalId: null };
    const mandate = await resolveHostMandate(tx, ctx, asking);
    expect(resolveUnboundRepo).toHaveBeenCalledWith(tx, ctx, true);
    expect(mandate.unboundRepo).toEqual(CLAUSE);
    expect(withMandate(ASKS, mandate).unbound_repo).toEqual(CLAUSE);
  });

  it("leaves the mandate without a clause when the read resolves none (negative)", async () => {
    const tx = {
      query: { workspaces: { findFirst: async () => undefined } },
    } as unknown as Parameters<typeof resolveHostMandate>[0];
    resolveUnboundRepo.mockResolvedValue(undefined);
    const mandate = await resolveHostMandate(
      tx,
      { orgId: "o", workspaceId: "w" },
      { ...host(ASKS), agentId: null, agentPrincipalId: null },
    );
    expect(mandate).not.toHaveProperty("unboundRepo");
  });
});
