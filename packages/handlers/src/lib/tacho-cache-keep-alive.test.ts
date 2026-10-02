/**
 * The cache keep-alive's answer for one host (lane F32): which agents the
 * control plane turns the keep-alive on for, and where the answer lands on
 * the signed bundle. The host's side, the keep-alives themselves, is
 * `packages/tacho/src/collector/model-proxy-keep-alive.test.ts`.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { BUNDLE_FEATURE_CACHE_KEEP_ALIVE } from "@oxagen/recorder";
import { policyBundleSchema } from "@oxagen/oxagen/tacho/schemas";
import {
  keepAliveSaves,
  parsesCacheKeepAlive,
  resolveCacheKeepAlive,
} from "./tacho-cache-keep-alive";
import { unsignedBundle } from "./tacho-host";
import { assembleWorkspaceSteering } from "./tacho-steering";

const CTX = { orgId: "org-1", workspaceId: "ws-1" };
const AGENT_KEY = "acme.core.cc-laptop";

/** An idle cache finding's evidence: the rewrites against the keep-alive. */
function evidence(measuredMicros: string, counterfactualMicros: string) {
  return {
    calls: 4,
    coveredCalls: 4,
    measuredTokens: 160_000,
    counterfactualTokens: 320_000,
    measuredMicros,
    counterfactualMicros,
    operatorKeys: [],
    runs: [],
    recommendation: { setting: "cache_ttl", value: "5m", current: "5m" },
  };
}

function transaction(options: {
  /** The agent row's setting; undefined for no row. */
  setting?: boolean;
  rows?: Array<{ publicId: string; citedFrames: unknown }>;
}) {
  const findAgent = vi.fn(async (_args: unknown) =>
    options.setting === undefined
      ? undefined
      : { cacheKeepAlive: options.setting },
  );
  const findFindings = vi.fn(async (_args: unknown) => options.rows ?? []);
  return {
    tx: {
      query: {
        agents: { findFirst: findAgent },
        findings: { findMany: findFindings },
      },
    },
    findAgent,
    findFindings,
  };
}

function host(
  bundleFeatures: string[] = [BUNDLE_FEATURE_CACHE_KEEP_ALIVE],
  agentId: string | null = "agent-1",
) {
  return { agentId, agentKey: AGENT_KEY, bundleFeatures };
}

const SAVING = { publicId: "fnd_saving", citedFrames: evidence("900000", "80000") };
const NO_SAVING = {
  publicId: "fnd_no_saving",
  citedFrames: evidence("80000", "90000"),
};

describe("the cache keep-alive's answer", () => {
  it("turns the keep-alive on for an agent whose idle cache finding shows a saving", async () => {
    const { tx, findFindings } = transaction({ setting: true, rows: [SAVING] });
    await expect(resolveCacheKeepAlive(tx, CTX, host())).resolves.toEqual({
      finding_id: "fnd_saving",
    });
    // The agent's idle cache findings in this workspace, open or applied.
    const args = findFindings.mock.calls[0]?.[0] as { where: SQL };
    const params = new PgDialect().sqlToQuery(args.where).params;
    expect(params).toEqual(
      expect.arrayContaining([
        CTX.orgId,
        CTX.workspaceId,
        "idle_cache_rewrites",
        "agent",
        AGENT_KEY,
        "open",
        "applied",
      ]),
    );
    expect(params).not.toContain("dismissed");
  });

  it("leaves it off for an agent whose finding shows no saving (negative)", async () => {
    const { tx } = transaction({ setting: true, rows: [NO_SAVING] });
    await expect(resolveCacheKeepAlive(tx, CTX, host())).resolves.toBe(
      undefined,
    );
  });

  it("leaves it off for an agent with no idle cache finding (negative)", async () => {
    const { tx } = transaction({ setting: true, rows: [] });
    await expect(resolveCacheKeepAlive(tx, CTX, host())).resolves.toBe(
      undefined,
    );
  });

  it("names the newest finding that shows a saving", async () => {
    const { tx } = transaction({ setting: true, rows: [NO_SAVING, SAVING] });
    await expect(resolveCacheKeepAlive(tx, CTX, host())).resolves.toEqual({
      finding_id: "fnd_saving",
    });
  });

  it("leaves it off for an agent the owning team turned off, whatever the finding says (negative)", async () => {
    const { tx, findFindings } = transaction({
      setting: false,
      rows: [SAVING],
    });
    await expect(resolveCacheKeepAlive(tx, CTX, host())).resolves.toBe(
      undefined,
    );
    expect(findFindings).not.toHaveBeenCalled();
  });

  it("lets the finding decide for a host enrolled with no agent row", async () => {
    const { tx, findAgent } = transaction({ rows: [SAVING] });
    await expect(
      resolveCacheKeepAlive(tx, CTX, host(undefined, null)),
    ).resolves.toEqual({ finding_id: "fnd_saving" });
    expect(findAgent).not.toHaveBeenCalled();
  });

  it("asks nothing for a host that cannot parse the field (negative)", async () => {
    const { tx, findAgent, findFindings } = transaction({
      setting: true,
      rows: [SAVING],
    });
    await expect(resolveCacheKeepAlive(tx, CTX, host([]))).resolves.toBe(
      undefined,
    );
    expect(findAgent).not.toHaveBeenCalled();
    expect(findFindings).not.toHaveBeenCalled();
    expect(parsesCacheKeepAlive({ bundleFeatures: null })).toBe(false);
  });

  it.each([
    [evidence("900000", "80000"), true],
    [evidence("80000", "80000"), false],
    [evidence("0", "0"), false],
    [{ measuredMicros: 900000, counterfactualMicros: 1 }, false],
    [null, false],
    ["evidence", false],
  ])("reads a saving off the evidence: %j is %s", (value, saves) => {
    expect(keepAliveSaves(value)).toBe(saves);
  });
});

describe("the cache keep-alive on the signed bundle", () => {
  const steering = assembleWorkspaceSteering("org", "ws", []);
  const mandate = {
    permissions: { allow: [], deny: [], ask: [] },
    budget: { mode: "observed" as const },
    cacheKeepAlive: { finding_id: "fnd_saving" },
  };
  const bundleFor = (bundleFeatures: string[], withKeepAlive = true) =>
    unsignedBundle(
      {
        publicId: "tch_0123456789abcdefghjkmn",
        status: "active",
        mode: "observe",
        bundleVersionServed: 2,
        bundleFeatures,
      } as Parameters<typeof unsignedBundle>[0],
      { org: 1, workspace: 1 },
      { mode: "digest_only", classes: [] },
      steering,
      withKeepAlive
        ? mandate
        : { permissions: mandate.permissions, budget: mandate.budget },
      new Date("2026-10-01T09:30:00.000Z"),
    );

  it("signs the answer to a host that can parse it, and moves the etag", () => {
    const on = bundleFor([BUNDLE_FEATURE_CACHE_KEEP_ALIVE]);
    expect(on.cache_keep_alive).toEqual({ finding_id: "fnd_saving" });
    const parsed = policyBundleSchema.parse({
      ...on,
      signature: { key_id: "k1", alg: "ed25519", sig: "sig" },
    });
    expect(parsed.cache_keep_alive).toEqual({ finding_id: "fnd_saving" });
    const off = bundleFor([BUNDLE_FEATURE_CACHE_KEEP_ALIVE], false);
    expect(off.cache_keep_alive).toBeUndefined();
    expect(off.etag).not.toBe(on.etag);
  });

  it("never sends the field to a host that did not advertise it (negative)", () => {
    expect(bundleFor([]).cache_keep_alive).toBeUndefined();
  });
});
