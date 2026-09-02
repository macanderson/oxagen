import { describe, it, expect, vi, beforeEach } from "vitest";

// Controllable credential for the default (non-injected) resolveKey path.
// Mocked so a real AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY on this machine
// (shell, ~/.config/oxagen/config.json, or the repo .env.local) never leaks
// into the assertions. credentialSupportsModel stays real — it is pure.
const envState: {
  credential: { source: "gateway" | "anthropic"; key: string } | null;
} = { credential: null };
vi.mock("../../agent/env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent/env.js")>();
  return { ...actual, resolveAiCredential: () => envState.credential };
});

import {
  AnthropicProvider,
  GatewayCloudProvider,
  MissingCredentialError,
  OfflineError,
  OpenAiProvider,
} from "../providers/cloud.js";
import type { CloudProviderDeps } from "../providers/cloud.js";
import type { CloudModelEntry, CompletionRequest } from "../types.js";

const HAIKU: CloudModelEntry = {
  slug: "anthropic/claude-haiku-4.5",
  vendor: "anthropic",
  contextWindow: 200000,
  tools: true,
};

const REQ: CompletionRequest = {
  messages: [{ role: "user", content: "write a function" }],
  maxOutputTokens: 100,
};

function provider(over: CloudProviderDeps = {}) {
  return new AnthropicProvider("haiku", HAIKU, {
    resolveKey: () => "gw-key",
    generate: vi.fn(async () => ({
      text: "here you go",
      usage: { inputTokens: 12, outputTokens: 5 },
    })),
    ...over,
  });
}

describe("GatewayCloudProvider", () => {
  it("reports id, kind, and capabilities", () => {
    const p = provider();
    expect(p.id()).toBe("haiku");
    expect(p.kind()).toBe("cloud");
    const caps = p.capabilities();
    expect(caps.vendor).toBe("anthropic");
    expect(caps.offline).toBe(false);
    expect(caps.contextWindow).toBe(200000);
  });

  it("exposes the concrete gateway slug via slug() (what the coordinator seam hands the engine)", () => {
    expect(provider().slug()).toBe(HAIKU.slug);
  });

  it("is available only when a credential resolves", async () => {
    expect(await provider().isAvailable()).toBe(true);
    expect(await provider({ resolveKey: () => null }).isAvailable()).toBe(
      false,
    );
  });

  it("ensureReady throws MissingCredentialError with no key", async () => {
    await expect(
      provider({ resolveKey: () => null }).ensureReady(),
    ).rejects.toBeInstanceOf(MissingCredentialError);
  });

  it("completes and prices the usage on the gateway slug", async () => {
    const res = await provider().complete(REQ);
    expect(res.text).toBe("here you go");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(res.model).toBe(HAIKU.slug);
    expect(res.kind).toBe("cloud");
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it("estimates usage when the model returns none", async () => {
    const p = provider({
      generate: vi.fn(async () => ({ text: "hello world", usage: {} })),
    });
    const res = await p.complete(REQ);
    expect(res.usage.inputTokens).toBeGreaterThan(0);
    expect(res.usage.outputTokens).toBeGreaterThan(0);
  });

  it("maps network failures to a clear OfflineError", async () => {
    const p = provider({
      generate: vi.fn(async () => {
        throw Object.assign(new Error("fetch failed"), { code: "ENOTFOUND" });
      }),
    });
    await expect(p.complete(REQ)).rejects.toBeInstanceOf(OfflineError);
  });

  it("rethrows non-network errors unchanged", async () => {
    const p = provider({
      generate: vi.fn(async () => {
        throw new Error("400 bad request: invalid model");
      }),
    });
    await expect(p.complete(REQ)).rejects.toThrow(/bad request/);
  });

  it("estimateCost is cheap and needs no network", () => {
    const est = provider().estimateCost(REQ);
    expect(est.tokens).toBeGreaterThan(0);
    expect(est.usd).toBeGreaterThan(0);
  });
});

describe("default credential resolution (no injected resolveKey)", () => {
  beforeEach(() => {
    envState.credential = null;
  });

  it("with only an Anthropic credential, anthropic slugs are available and other vendors are not", async () => {
    envState.credential = { source: "anthropic", key: "sk-ant-test" };
    const anthropicProvider = new AnthropicProvider("haiku", HAIKU, {
      generate: vi.fn(async () => ({ text: "x", usage: {} })),
    });
    const openaiProvider = new OpenAiProvider(
      "judge",
      {
        slug: "openai/gpt-5-codex",
        vendor: "openai",
        contextWindow: 400000,
        tools: true,
      },
      { generate: vi.fn(async () => ({ text: "x", usage: {} })) },
    );
    expect(await anthropicProvider.isAvailable()).toBe(true);
    expect(await openaiProvider.isAvailable()).toBe(false);
    await expect(openaiProvider.ensureReady()).rejects.toBeInstanceOf(
      MissingCredentialError,
    );
  });

  it("with a gateway credential, every vendor is available", async () => {
    envState.credential = { source: "gateway", key: "vck_test" };
    const openaiProvider = new OpenAiProvider(
      "judge",
      {
        slug: "openai/gpt-5-codex",
        vendor: "openai",
        contextWindow: 400000,
        tools: true,
      },
      { generate: vi.fn(async () => ({ text: "x", usage: {} })) },
    );
    expect(await openaiProvider.isAvailable()).toBe(true);
  });
});

describe("vendor subclasses", () => {
  it("expose the concrete anthropic and openai providers", () => {
    expect(
      new AnthropicProvider("haiku", HAIKU, { resolveKey: () => "k" }),
    ).toBeInstanceOf(GatewayCloudProvider);
    const openai = new OpenAiProvider(
      "judge",
      {
        slug: "openai/gpt-5-codex",
        vendor: "openai",
        contextWindow: 400000,
        tools: true,
      },
      { resolveKey: () => "k" },
    );
    expect(openai.capabilities().vendor).toBe("openai");
  });
});
