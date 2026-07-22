import { describe, expect, it } from "vitest";
import { modelCapabilityList } from "./model.capability.list";
import { getCapability } from "../registry";

describe("model.capability.list capability", () => {
  it("is registered read-only and unscoped with the expected surfaces", () => {
    const cap = getCapability("list_model_capabilities");
    expect(cap).toBeDefined();
    expect(cap?.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(cap?.sensitivity).toBe("low");
    // The posture matrix is static platform metadata, not tenant rows — it
    // describes the provider surface, so it carries no workspace scope.
    expect(cap?.scoped).toBe(false);
  });

  it("accepts an empty input (the full matrix)", () => {
    const parsed = modelCapabilityList.input.parse({});
    expect(parsed.vendor).toBeUndefined();
    expect(parsed.model).toBeUndefined();
  });

  it("accepts a vendor filter", () => {
    expect(
      modelCapabilityList.input.parse({ vendor: "anthropic" }).vendor,
    ).toBe("anthropic");
  });

  it("accepts a gateway model id filter", () => {
    expect(
      modelCapabilityList.input.parse({ model: "anthropic/claude-sonnet-5" })
        .model,
    ).toBe("anthropic/claude-sonnet-5");
  });

  it("parses an opt-in cache row carrying its wire mechanism and witness", () => {
    const parsed = modelCapabilityList.output.parse({
      vendors: [
        {
          vendor: "anthropic",
          label: "Anthropic",
          models: ["anthropic/claude-sonnet-5"],
          cache: {
            kind: "opt-in",
            mechanism:
              "providerOptions.anthropic.cacheControl = {type: 'ephemeral'}",
            witness:
              "prepends the system prompt as an Anthropic-cacheable system message",
          },
          reasoning: {
            kind: "controllable",
            mechanism: "thinking {type: adaptive} + outputConfig.effort",
            witness:
              "sets adaptive thinking + output_config.effort and locks temperature",
          },
          structuredOutput: {
            kind: "native",
            mechanism: "zod schema handed to generateObject",
            witness:
              "calls generateObject with default temperature 0 and the schema",
          },
          attachments: {
            kind: "supported",
            kinds: ["image"],
            mechanism: "Claude accepts image parts",
            witness: "distinguishes vision (image input) from image generation",
          },
        },
      ],
      unknownFilter: null,
    });
    expect(parsed.vendors[0]?.cache.kind).toBe("opt-in");
    expect(parsed.unknownFilter).toBeNull();
  });

  it("parses an implicit cache row carrying its telemetry field", () => {
    const parsed = modelCapabilityList.output.parse({
      vendors: [
        {
          vendor: "deepseek",
          label: "DeepSeek",
          models: ["deepseek/deepseek-v3.2"],
          cache: {
            kind: "implicit",
            telemetry:
              "top-level prompt_cache_hit_tokens, normalized to cacheReadTokens",
            witness: "forwards prompt-cache reads",
          },
          reasoning: {
            kind: "unsupported",
            note: "no request-level effort control",
          },
          structuredOutput: {
            kind: "emulated",
            mechanism:
              "JSON-object response format, schema validated on return",
            witness: "returns an object that satisfies the zod schema",
          },
          attachments: { kind: "text-only", note: "no vision capability" },
        },
      ],
      unknownFilter: null,
    });
    const cache = parsed.vendors[0]?.cache;
    expect(cache?.kind).toBe("implicit");
    if (cache?.kind !== "implicit") throw new Error("unreachable");
    expect(cache.telemetry).toContain("prompt_cache_hit_tokens");
  });

  it("parses an all-n/a row for an image-only vendor", () => {
    const parsed = modelCapabilityList.output.parse({
      vendors: [
        {
          vendor: "bfl",
          label: "Black Forest Labs",
          models: ["bfl/flux-2-max"],
          cache: {
            kind: "not-applicable",
            reason: "no prompt prefix to cache",
          },
          reasoning: { kind: "not-applicable", reason: "no reasoning phase" },
          structuredOutput: {
            kind: "not-applicable",
            reason: "returns image bytes",
          },
          attachments: {
            kind: "not-applicable",
            reason: "not on the chat path",
          },
        },
      ],
      unknownFilter: null,
    });
    expect(parsed.vendors[0]?.attachments.kind).toBe("not-applicable");
  });

  it("carries the unmatched filter back so an unknown provider reads as unknown", () => {
    // The distinction that matters: "no posture declared" must never be
    // indistinguishable from "matrix is empty but everything is fine".
    const parsed = modelCapabilityList.output.parse({
      vendors: [],
      unknownFilter: "some-byok-provider",
    });
    expect(parsed.vendors).toHaveLength(0);
    expect(parsed.unknownFilter).toBe("some-byok-provider");
  });

  it("rejects a cache row whose kind is not one of the declared postures", () => {
    expect(() =>
      modelCapabilityList.output.parse({
        vendors: [
          {
            vendor: "anthropic",
            label: "Anthropic",
            models: [],
            cache: { kind: "probably-fine" },
            reasoning: { kind: "not-applicable", reason: "x" },
            structuredOutput: { kind: "not-applicable", reason: "x" },
            attachments: { kind: "not-applicable", reason: "x" },
          },
        ],
        unknownFilter: null,
      }),
    ).toThrow();
  });

  it("rejects an opt-in cache row with no witness (a claim with no proof)", () => {
    expect(() =>
      modelCapabilityList.output.parse({
        vendors: [
          {
            vendor: "anthropic",
            label: "Anthropic",
            models: [],
            cache: { kind: "opt-in", mechanism: "cacheControl" },
            reasoning: { kind: "not-applicable", reason: "x" },
            structuredOutput: { kind: "not-applicable", reason: "x" },
            attachments: { kind: "not-applicable", reason: "x" },
          },
        ],
        unknownFilter: null,
      }),
    ).toThrow();
  });
});
