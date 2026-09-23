/**
 * The harness enum is a ratchet: `WRAPPED_HARNESSES` and `CONNECTED_HARNESSES`
 * carry literal types so a per-tier lookup table is total for its tier, which
 * means they are written out rather than derived. This file is what keeps them
 * honest — a harness added to the enum without being classified fails here
 * rather than quietly reading as wrapped, which would have the product claim
 * a step record for an app that produces none (ADR-078 §2).
 */
import { describe, expect, it } from "vitest";
import { MODEL_PROXY_ROUTES } from "./collector/model-routes";
import {
  BROKERABLE_HARNESS_PROVIDER,
  BROKERABLE_HARNESSES,
  CONNECTED_HARNESSES,
  defaultHarnessForProvider,
  HARNESS_BINARY,
  isBrokerableHarness,
  isConnectedHarness,
  isModelRoutedHarness,
  isWrappedHarness,
  MODEL_GATEWAY_PROVIDERS,
  MODEL_HARNESS_ROUTES,
  MODEL_ROUTED_HARNESSES,
  TACHO_ENFORCEMENT_TIER_ATTR,
  TACHO_GATEWAY_TIER,
  TACHO_HARNESS_LABELS,
  TACHO_HARNESS_TIERS,
  TACHO_TIER_SUMMARY,
  tachoHarnessSchema,
  WRAPPED_HARNESSES,
} from "./wire";

const ALL = tachoHarnessSchema.options;

describe("every harness is classified, exactly once", () => {
  it("the two lists partition the enum", () => {
    expect([...WRAPPED_HARNESSES, ...CONNECTED_HARNESSES].sort()).toEqual(
      [...ALL].sort(),
    );
  });

  it("no harness is in both lists", () => {
    for (const harness of WRAPPED_HARNESSES) {
      expect(CONNECTED_HARNESSES).not.toContain(harness);
    }
  });

  it("the lists agree with the tier map", () => {
    for (const harness of WRAPPED_HARNESSES)
      expect(TACHO_HARNESS_TIERS[harness]).toBe("harness");
    for (const harness of CONNECTED_HARNESSES)
      expect(TACHO_HARNESS_TIERS[harness]).toBe("gateway");
  });

  it("every harness has a label and a tier", () => {
    for (const harness of ALL) {
      expect(TACHO_HARNESS_LABELS[harness]).toBeTruthy();
      expect(TACHO_HARNESS_TIERS[harness]).toBeTruthy();
    }
  });

  it("the predicates agree with the lists", () => {
    for (const harness of ALL) {
      expect(isWrappedHarness(harness)).toBe(
        TACHO_HARNESS_TIERS[harness] === "harness",
      );
      expect(isConnectedHarness(harness)).toBe(
        TACHO_HARNESS_TIERS[harness] === "gateway",
      );
    }
    expect(isWrappedHarness("not-a-harness")).toBe(false);
    expect(isConnectedHarness("not-a-harness")).toBe(false);
  });
});

describe("the tier summaries are the honesty rule in one line each", () => {
  it("the wrapped summary says the record is what the agent reported", () => {
    // ADR-078 §2 / tacho spec §2: harness tier is client_attested, and no
    // surface may say "prevented" where the record says "observed".
    expect(TACHO_TIER_SUMMARY.harness).toContain("every action");
    expect(TACHO_TIER_SUMMARY.harness).toContain("does not run the process");
  });

  it("the connected summary names what it does not record", () => {
    expect(TACHO_TIER_SUMMARY.gateway).toContain("refuses");
    expect(TACHO_TIER_SUMMARY.gateway).toContain("does not record");
  });

  it("neither summary ranks the tiers against the other", () => {
    for (const summary of Object.values(TACHO_TIER_SUMMARY)) {
      expect(summary.toLowerCase()).not.toContain("full coverage");
      expect(summary.toLowerCase()).not.toContain("partial");
      expect(summary.toLowerCase()).not.toContain("better");
      expect(summary.toLowerCase()).not.toContain("limited");
    }
  });
});

describe("the gateway enforcement attribute is a wire spelling", () => {
  // The daemon writes this attribute onto a connected app's tool-call event;
  // the control plane's ingest reads it to file the call under the `gateway`
  // tier. Both now take the spelling from the same constant, so a rename is a
  // type error rather than a silent mismatch. What a shared constant does NOT
  // stop is changing its VALUE, which is a protocol break: hosts in the field
  // go on emitting the old spelling, and a control plane looking for a new one
  // would file every one of their gateway calls as `observe` — the exact
  // silence discussion_r4034318913 was about. Pinning the literal here makes
  // that change deliberate.
  it("is the spelling already deployed hosts emit", () => {
    expect(TACHO_ENFORCEMENT_TIER_ATTR).toBe("oxagen.enforcement_tier");
    expect(TACHO_GATEWAY_TIER).toBe("gateway");
  });
});

describe("the model route table is the one place a harness reaches the gateway", () => {
  it("names only wrapped harnesses, each once, with a binary to launch", () => {
    const harnesses = MODEL_HARNESS_ROUTES.map((row) => row.harness);
    expect(new Set(harnesses).size).toBe(harnesses.length);
    for (const harness of harnesses) {
      expect(isWrappedHarness(harness)).toBe(true);
      expect(HARNESS_BINARY[harness]).toBeTruthy();
    }
    for (const harness of WRAPPED_HARNESSES)
      expect(HARNESS_BINARY[harness]).toBeTruthy();
    expect(HARNESS_BINARY.cursor).toBe("cursor-agent");
  });

  it("answers every prefix the proxy routes, and only known providers", () => {
    for (const row of MODEL_HARNESS_ROUTES) {
      expect(MODEL_PROXY_ROUTES).toContain(row.prefix);
      expect(MODEL_GATEWAY_PROVIDERS).toContain(row.provider);
      expect(row.baseUrlFile).toMatch(/\.(json|toml)$/);
    }
  });

  it("derives the lists, the predicates and the provider map from the rows", () => {
    expect(MODEL_ROUTED_HARNESSES).toEqual(["claude-code", "codex", "stella"]);
    expect(BROKERABLE_HARNESSES).toEqual(["claude-code", "codex"]);
    expect(BROKERABLE_HARNESS_PROVIDER).toEqual({
      "claude-code": "anthropic",
      codex: "openai",
    });
    for (const harness of tachoHarnessSchema.options) {
      expect(isModelRoutedHarness(harness)).toBe(
        MODEL_HARNESS_ROUTES.some((row) => row.harness === harness),
      );
      expect(isBrokerableHarness(harness)).toBe(
        MODEL_HARNESS_ROUTES.some(
          (row) => row.harness === harness && row.brokerable,
        ),
      );
    }
    expect(isModelRoutedHarness("not-a-harness")).toBe(false);
    expect(isBrokerableHarness("stella")).toBe(false);
  });

  it("files a bare provider prefix under that provider's brokerable harness", () => {
    // One brokerable harness per provider, so a call that names no harness
    // has exactly one place to land.
    for (const provider of MODEL_GATEWAY_PROVIDERS) {
      const harness = defaultHarnessForProvider(provider);
      expect(BROKERABLE_HARNESS_PROVIDER[harness]).toBe(provider);
      expect(
        MODEL_HARNESS_ROUTES.filter(
          (row) => row.brokerable && row.provider === provider,
        ),
      ).toHaveLength(1);
    }
  });
});
