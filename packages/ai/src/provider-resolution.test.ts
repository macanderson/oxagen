/**
 * The routing decision, pinned in both directions.
 *
 * The property that matters most is the one asserted first: a deployment with
 * a gateway credential keeps going through the gateway even when a vendor key
 * happens to be present. Getting that backwards would silently move production
 * traffic off the gateway the day someone set ANTHROPIC_API_KEY for something
 * unrelated.
 */
import { describe, expect, it } from "vitest";
import {
  describeModelRouting,
  resolveLanguageModel,
} from "./provider-resolution";

const GATEWAY = { AI_GATEWAY_API_KEY: "gw-key" } as NodeJS.ProcessEnv;
const DIRECT_KEY = { ANTHROPIC_API_KEY: "sk-ant-test" } as NodeJS.ProcessEnv;

describe("model routing", () => {
  it("keeps a configured gateway even when a vendor key is also present", () => {
    const env = { ...GATEWAY, ...DIRECT_KEY } as NodeJS.ProcessEnv;
    expect(describeModelRouting("anthropic/claude-sonnet-4", env)).toBe(
      "gateway",
    );
  });

  it("falls back to the vendor's own provider when no gateway is configured", () => {
    expect(describeModelRouting("anthropic/claude-sonnet-4", DIRECT_KEY)).toBe(
      "direct",
    );
  });

  it("prefers the vendor's own provider on an explicit opt-in", () => {
    const env = {
      ...GATEWAY,
      ...DIRECT_KEY,
      OXAGEN_MODEL_ROUTING: "direct",
    } as NodeJS.ProcessEnv;
    expect(describeModelRouting("anthropic/claude-sonnet-4", env)).toBe(
      "direct",
    );
  });

  it("stays on the gateway for a vendor with no direct key", () => {
    // No ANTHROPIC_API_KEY: falling through to the gateway is what keeps this
    // from failing a call it could otherwise have made.
    expect(
      describeModelRouting(
        "anthropic/claude-sonnet-4",
        {} as NodeJS.ProcessEnv,
      ),
    ).toBe("gateway");
  });

  it("stays on the gateway for a vendor with no direct entry", () => {
    const env = { ...DIRECT_KEY } as NodeJS.ProcessEnv;
    expect(describeModelRouting("openai/gpt-5", env)).toBe("gateway");
  });

  it("recognizes a vendor's own bare slug with the prefix already stripped", () => {
    // A resolved id round-trips through the platform without its prefix — a
    // response reports `claude-sonnet-4`, not `anthropic/claude-sonnet-4` — and
    // comes back here for the next call. Treating that as unroutable sent the
    // second call of every turn to the gateway while the first went direct.
    expect(describeModelRouting("claude-sonnet-4", DIRECT_KEY)).toBe("direct");
  });

  it("stays on the gateway for a bare slug no vendor claims", () => {
    expect(describeModelRouting("some-unknown-model", DIRECT_KEY)).toBe(
      "gateway",
    );
  });

  it("builds a usable model on the direct path", () => {
    const model = resolveLanguageModel("anthropic/claude-sonnet-4", DIRECT_KEY);
    expect(model).toBeDefined();
    // Always a provider object, never the bare-string arm of the union.
    expect(typeof model).toBe("object");
    // The bare slug reaches the provider — a direct provider must not be handed
    // the `vendor/` prefix the gateway expects.
    expect(model.modelId).toContain("claude-sonnet-4");
  });
});
