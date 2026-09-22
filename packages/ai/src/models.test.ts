import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ───────────────────────────────────────────────────────
// vi.hoisted runs before any import resolution — refs are safe inside the
// vi.mock factories below. Three seams: the platform gateway (`gateway`), the
// gateway factory a customer's own gateway key is built on (`createGateway`),
// and the OpenAI-compatible factory that serves OpenRouter — on the platform
// key when OXAGEN_MODEL_PROVIDER says so, or on a customer's key (ADR-053 §2).
const mocks = vi.hoisted(() => {
  const languageModel = vi.fn();
  const platformEmbeddingModel = vi.fn();
  return {
    languageInstance: { modelId: "anthropic/claude-sonnet-5" },
    languageModel,
    platformEmbeddingModel,
    // The one `gateway` object the module under test imports; a test asserts
    // identity against it, so it is built once, here.
    platformGateway: {
      languageModel,
      embeddingModel: platformEmbeddingModel,
    },
    createGateway: vi.fn(),
    createOpenAICompatible: vi.fn(),
    requireEnv: vi.fn(),
  };
});

mocks.languageModel.mockReturnValue(mocks.languageInstance);

const platformGateway = mocks.platformGateway;

vi.mock("@ai-sdk/gateway", () => ({
  gateway: mocks.platformGateway,
  createGateway: mocks.createGateway,
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}));

// requireEnv is mocked to return whatever the current test set; the real schema
// carries only AI_GATEWAY_API_KEY + the OXAGEN_LLM_* tier vars now. It is a
// spy so a test can assert which keys were ASKED for — a customer-funded call
// must never read the platform's OpenRouter key.
let envValues: Record<string, string | undefined> = {};
mocks.requireEnv.mockImplementation(() => envValues);

vi.mock("@oxagen/config/env", () => ({
  requireEnv: mocks.requireEnv,
}));

vi.mock("ai", () => ({
  wrapLanguageModel: (opts: { model: unknown }) => opts.model,
}));

import {
  embeddingProvider,
  modelIdentityFor,
  resetCredentialClientsForTests,
  resolvedTierCatalog,
  resolveModelIdentity,
  selectModel,
  type ModelCredential,
} from "./models";

// ──────────────────────────────────────────────────────────────────

/** One fresh client per build, so a test can tell a reuse from a rebuild. */
function freshClient(tag: string) {
  return {
    tag,
    languageModel: vi.fn((id: string) => ({ modelId: id, client: tag })),
    embeddingModel: vi.fn((id: string) => ({ modelId: id, client: tag })),
  };
}

let clientSeq = 0;

const resetMocks = () => {
  mocks.languageModel.mockClear();
  mocks.languageModel.mockReturnValue(mocks.languageInstance);
  mocks.requireEnv.mockClear();
  mocks.requireEnv.mockImplementation(() => envValues);
  mocks.createGateway.mockReset();
  mocks.createGateway.mockImplementation(() =>
    freshClient(`gateway-${++clientSeq}`),
  );
  mocks.createOpenAICompatible.mockReset();
  mocks.createOpenAICompatible.mockImplementation(() =>
    freshClient(`openrouter-${++clientSeq}`),
  );
  resetCredentialClientsForTests();
};

const TIER_ENV = {
  OXAGEN_LLM_FAST: "anthropic/claude-haiku-4.5",
  OXAGEN_LLM_BALANCED: "anthropic/claude-sonnet-5",
  OXAGEN_LLM_PRECISE: "anthropic/claude-opus-4.8",
};

/** Every key requireEnv was asked for across the test, flattened. */
function envKeysAskedFor(): string[] {
  return mocks.requireEnv.mock.calls.flatMap(
    (call) => (call[0] ?? []) as string[],
  );
}

const OPENROUTER_CREDENTIAL: ModelCredential = {
  provider: "openrouter",
  apiKey: "sk-or-v1-customer",
  digest: "sha256:or-1",
};

const GATEWAY_CREDENTIAL: ModelCredential = {
  provider: "gateway",
  apiKey: "vck_customer",
  digest: "sha256:gw-1",
};

describe("selectModel (@oxagen/ai) — gateway only", () => {
  beforeEach(resetMocks);

  it("routes through the gateway at the balanced tier by default", () => {
    envValues = { ...TIER_ENV };
    const model = selectModel();
    expect(mocks.languageModel).toHaveBeenCalledTimes(1);
    expect(mocks.languageModel).toHaveBeenCalledWith(
      "anthropic/claude-sonnet-5",
    );
    expect(model).toBe(mocks.languageInstance);
  });

  it("resolves the fast tier to its OXAGEN_LLM_FAST gateway id", () => {
    envValues = { ...TIER_ENV };
    selectModel({ tier: "fast" });
    expect(mocks.languageModel).toHaveBeenCalledWith(
      "anthropic/claude-haiku-4.5",
    );
  });

  it("resolves the precise tier to its OXAGEN_LLM_PRECISE gateway id", () => {
    envValues = { ...TIER_ENV };
    selectModel({ tier: "precise" });
    expect(mocks.languageModel).toHaveBeenCalledWith(
      "anthropic/claude-opus-4.8",
    );
  });

  it("an explicit gateway model id wins over a tier", () => {
    envValues = { ...TIER_ENV };
    selectModel({ model: "openai/gpt-5.2", tier: "fast" });
    expect(mocks.languageModel).toHaveBeenCalledWith("openai/gpt-5.2");
  });
});

describe("selectModel — the platform provider switch (no credential)", () => {
  beforeEach(resetMocks);

  it("stays on the gateway and builds no OpenRouter client by default", () => {
    envValues = { ...TIER_ENV, OXAGEN_MODEL_PROVIDER: "gateway" };
    selectModel();
    expect(mocks.createOpenAICompatible).not.toHaveBeenCalled();
    expect(mocks.createGateway).not.toHaveBeenCalled();
    expect(mocks.languageModel).toHaveBeenCalledTimes(1);
  });

  it("OXAGEN_MODEL_PROVIDER=openrouter builds the OpenRouter client on the PLATFORM key", () => {
    envValues = {
      ...TIER_ENV,
      OXAGEN_MODEL_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-platform",
    };
    const model = selectModel({ model: "anthropic/claude-sonnet-4.6" });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledTimes(1);
    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-platform",
      supportsStructuredOutputs: true,
    });
    expect(model).toMatchObject({ modelId: "anthropic/claude-sonnet-4.6" });
    expect(mocks.languageModel).not.toHaveBeenCalled();
  });

  it("refuses the openrouter opt-out with a precise message when its key is missing", () => {
    envValues = { ...TIER_ENV, OXAGEN_MODEL_PROVIDER: "openrouter" };
    expect(() => selectModel()).toThrow(
      "OXAGEN_MODEL_PROVIDER=openrouter requires OPENROUTER_API_KEY",
    );
    expect(mocks.createOpenAICompatible).not.toHaveBeenCalled();
  });
});

describe("selectModel — an organisation's own key (ADR-053 §2)", () => {
  beforeEach(resetMocks);

  it("builds the OpenRouter client on the credential's key and never reads the platform key", () => {
    // The platform is configured for OpenRouter too, on a DIFFERENT key. The
    // customer's key must win and the platform's must not even be asked for.
    envValues = {
      ...TIER_ENV,
      OXAGEN_MODEL_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "sk-or-platform",
    };
    const model = selectModel({
      model: "anthropic/claude-sonnet-4.6",
      credential: OPENROUTER_CREDENTIAL,
    });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledTimes(1);
    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith({
      name: "openrouter",
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-v1-customer",
      supportsStructuredOutputs: true,
    });
    expect(model).toMatchObject({ modelId: "anthropic/claude-sonnet-4.6" });
    expect(mocks.languageModel).not.toHaveBeenCalled();
    expect(mocks.createGateway).not.toHaveBeenCalled();
    expect(envKeysAskedFor()).not.toContain("OPENROUTER_API_KEY");
    expect(envKeysAskedFor()).not.toContain("OXAGEN_MODEL_PROVIDER");
  });

  it("builds a gateway client on a gateway credential, not the platform gateway", () => {
    envValues = { ...TIER_ENV };
    const model = selectModel({ credential: GATEWAY_CREDENTIAL });
    expect(mocks.createGateway).toHaveBeenCalledTimes(1);
    expect(mocks.createGateway).toHaveBeenCalledWith({
      apiKey: "vck_customer",
    });
    // The tier still resolves from env; only the key changes hands.
    expect(model).toMatchObject({ modelId: "anthropic/claude-sonnet-5" });
    expect(mocks.languageModel).not.toHaveBeenCalled();
    expect(mocks.createOpenAICompatible).not.toHaveBeenCalled();
  });

  it("reuses the client for the same provider:digest across turns", () => {
    envValues = { ...TIER_ENV };
    const first = selectModel({ credential: OPENROUTER_CREDENTIAL });
    const second = selectModel({ credential: { ...OPENROUTER_CREDENTIAL } });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledTimes(1);
    expect((second as unknown as { client: string }).client).toBe(
      (first as unknown as { client: string }).client,
    );
  });

  it("a rotated key (new digest) builds a new client rather than reusing the old one", () => {
    envValues = { ...TIER_ENV };
    selectModel({ credential: OPENROUTER_CREDENTIAL });
    selectModel({
      credential: {
        ...OPENROUTER_CREDENTIAL,
        apiKey: "sk-or-v1-rotated",
        digest: "sha256:or-2",
      },
    });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledTimes(2);
    expect(mocks.createOpenAICompatible).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: "sk-or-v1-rotated" }),
    );
  });

  it("caches per provider, so the same digest under two providers is two clients", () => {
    envValues = { ...TIER_ENV };
    selectModel({ credential: { ...OPENROUTER_CREDENTIAL, digest: "same" } });
    selectModel({ credential: { ...GATEWAY_CREDENTIAL, digest: "same" } });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledTimes(1);
    expect(mocks.createGateway).toHaveBeenCalledTimes(1);
  });

  it("resetCredentialClientsForTests forgets every client", () => {
    envValues = { ...TIER_ENV };
    selectModel({ credential: OPENROUTER_CREDENTIAL });
    resetCredentialClientsForTests();
    selectModel({ credential: OPENROUTER_CREDENTIAL });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledTimes(2);
  });

  it("bounds the cache: the entry past the bound clears it rather than growing it", () => {
    envValues = { ...TIER_ENV };
    const BOUND = 256;
    for (let n = 0; n < BOUND; n += 1) {
      selectModel({
        credential: { ...OPENROUTER_CREDENTIAL, digest: `d-${n}` },
      });
    }
    expect(mocks.createOpenAICompatible).toHaveBeenCalledTimes(BOUND);
    // Still cached at the bound.
    selectModel({ credential: { ...OPENROUTER_CREDENTIAL, digest: "d-0" } });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledTimes(BOUND);
    // One past the bound clears the map, so d-0 is rebuilt on its next use.
    selectModel({
      credential: { ...OPENROUTER_CREDENTIAL, digest: `d-${BOUND}` },
    });
    selectModel({ credential: { ...OPENROUTER_CREDENTIAL, digest: "d-0" } });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledTimes(BOUND + 2);
  });
});

describe("embeddingProvider (@oxagen/ai)", () => {
  beforeEach(resetMocks);

  it("serves embeddings from the platform gateway, platform-funded, with no credential", () => {
    const answer = embeddingProvider();
    expect(answer.provider).toBe(platformGateway);
    expect(answer.fundedBy).toBe("platform");
    expect(mocks.createGateway).not.toHaveBeenCalled();
  });

  it("an OpenRouter credential cannot serve embeddings, so the platform gateway answers and is billed", () => {
    const answer = embeddingProvider(OPENROUTER_CREDENTIAL);
    expect(answer.provider).toBe(platformGateway);
    expect(answer.fundedBy).toBe("platform");
    expect(mocks.createGateway).not.toHaveBeenCalled();
    expect(mocks.createOpenAICompatible).not.toHaveBeenCalled();
  });

  it("a gateway credential serves embeddings on the organisation's key, unbilled", () => {
    const answer = embeddingProvider(GATEWAY_CREDENTIAL);
    expect(mocks.createGateway).toHaveBeenCalledTimes(1);
    expect(mocks.createGateway).toHaveBeenCalledWith({
      apiKey: "vck_customer",
    });
    expect(answer.provider).toBe(mocks.createGateway.mock.results[0]?.value);
    expect(answer.provider).not.toBe(platformGateway);
    expect(answer.fundedBy).toBe("org");
  });
});

describe("tier resolution (@oxagen/ai)", () => {
  beforeEach(resetMocks);

  // ADR-043 removed image and video GENERATION, and with it the media tiers
  // and their OXAGEN_LLM_{IMAGE,VIDEO}_* env keys. Text is the only white-
  // labeled tier family left.
  it("joins every tier to its concrete gateway model id — text only", () => {
    envValues = { ...TIER_ENV };
    expect(resolvedTierCatalog()).toEqual({
      text: {
        fast: "anthropic/claude-haiku-4.5",
        balanced: "anthropic/claude-sonnet-5",
        precise: "anthropic/claude-opus-4.8",
      },
    });
  });
});

describe("BYOK beyond the routed vendors (@oxagen/ai)", () => {
  beforeEach(() => {
    resetMocks();
    envValues = {
      OXAGEN_LLM_FAST: "anthropic/claude-haiku-4.5",
      OXAGEN_LLM_BALANCED: "anthropic/claude-sonnet-5",
      OXAGEN_LLM_PRECISE: "anthropic/claude-fable-5",
      OXAGEN_MODEL_PROVIDER: "gateway",
    };
  });

  const compat = (over: Partial<ModelCredential> = {}): ModelCredential => ({
    provider: "openai_compatible",
    apiKey: "sk-together-0123456789",
    digest: "digest-compat",
    baseUrl: "https://api.together.xyz/v1",
    modelMap: { balanced: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
    ...over,
  });

  const idOf = (m: unknown) => (m as { modelId: string }).modelId;

  it("builds an openai_compatible client on the CUSTOMER's endpoint", () => {
    selectModel({ tier: "balanced", credential: compat() });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.together.xyz/v1",
        apiKey: "sk-together-0123456789",
      }),
    );
  });

  it("sends the customer endpoint's requests through a fetch that refuses redirects", () => {
    // The URL was checked when the row was written; a redirect target was
    // not. The probe refuses redirects, and the runtime client must too, or
    // the check holds for the test and not for the turn.
    selectModel({ tier: "balanced", credential: compat() });
    const call = mocks.createOpenAICompatible.mock.calls[0]?.[0] as {
      fetch?: unknown;
    };
    expect(typeof call.fetch).toBe("function");
  });

  it("spells the endpoint for openai and anthropic, so the customer pastes only a key", () => {
    selectModel({
      tier: "balanced",
      credential: {
        provider: "openai",
        apiKey: "sk-openai-0123456789",
        digest: "d-openai",
        modelMap: { balanced: "gpt-5.2" },
      },
    });
    selectModel({
      tier: "balanced",
      credential: {
        provider: "anthropic",
        apiKey: "sk-ant-0123456789",
        digest: "d-anthropic",
        modelMap: { balanced: "claude-sonnet-4-6" },
      },
    });
    const urls = mocks.createOpenAICompatible.mock.calls.map(
      (c) => (c[0] as { baseURL: string }).baseURL,
    );
    expect(urls).toEqual([
      "https://api.openai.com/v1",
      "https://api.anthropic.com/v1",
    ]);
  });

  it("asks a direct-vendor key for the CUSTOMER's model id, not the platform's", () => {
    // `api.openai.com` has no `anthropic/claude-sonnet-5`. Sending it would
    // 404 on the customer's first question.
    expect(idOf(selectModel({ tier: "balanced", credential: compat() }))).toBe(
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    );
  });

  it("runs an unmapped tier on the BALANCED model — never on a platform id the vendor does not know", () => {
    // The engine asks for fast (summarisation) and precise (verdicts), not
    // just the worker tier. Falling through to `anthropic/claude-haiku-4.5`
    // would fail the turn halfway through on a correctly configured key.
    expect(idOf(selectModel({ tier: "fast", credential: compat() }))).toBe(
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    );
    expect(idOf(selectModel({ tier: "precise", credential: compat() }))).toBe(
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    );
  });

  it("uses a tier's own mapping when the customer gave one", () => {
    const model = selectModel({
      tier: "fast",
      credential: compat({
        modelMap: { balanced: "big-model", fast: "small-model" },
      }),
    });
    expect(idOf(model)).toBe("small-model");
  });

  it("leaves a routed key on the platform id — OpenRouter understands it, and a stray map is ignored", () => {
    const model = selectModel({
      tier: "balanced",
      credential: {
        provider: "openrouter",
        apiKey: "sk-or-v1-0123456789",
        digest: "d-or",
        modelMap: { balanced: "should-be-ignored" },
      },
    });
    expect(idOf(model)).toBe("anthropic/claude-sonnet-5");
  });

  describe("an explicit model id on a direct-vendor key (never sent untranslated)", () => {
    // `prepareAssistantTurn` passes the workspace's stored `defaultTextModel`
    // as `selector.model`. That is a gateway id chosen before the key existed;
    // `api.openai.com` answers 404 to it, on every turn, on a key whose
    // balanced mapping was configured exactly as the form asked.
    const openai = (
      modelMap: ModelCredential["modelMap"] = { balanced: "gpt-5.2" },
    ): ModelCredential => ({
      provider: "openai",
      apiKey: "sk-openai-0123456789",
      digest: "d-openai",
      modelMap,
    });

    it("a stored platform tier id runs on the tier's mapping, not on the platform id", () => {
      // The workspace default is the precise tier's gateway id; the key maps
      // precise, so that is what runs.
      const model = selectModel({
        model: "anthropic/claude-fable-5",
        credential: openai({ balanced: "gpt-5.2", precise: "o3-pro" }),
      });
      expect(idOf(model)).toBe("o3-pro");
    });

    it("a stored platform tier id with no mapping of its own falls to balanced", () => {
      const model = selectModel({
        model: "anthropic/claude-haiku-4.5",
        credential: openai(),
      });
      expect(idOf(model)).toBe("gpt-5.2");
    });

    it("one of the customer's own models passes through", () => {
      const model = selectModel({
        model: "o3-pro",
        credential: openai({ balanced: "gpt-5.2", precise: "o3-pro" }),
      });
      expect(idOf(model)).toBe("o3-pro");
    });

    it("a same-vendor gateway id is sent in the vendor's spelling", () => {
      expect(
        idOf(
          selectModel({ model: "openai/gpt-5.2-mini", credential: openai() }),
        ),
      ).toBe("gpt-5.2-mini");
      expect(
        idOf(
          selectModel({
            model: "anthropic/claude-sonnet-4-6",
            credential: {
              provider: "anthropic",
              apiKey: "sk-ant-0123456789",
              digest: "d-anthropic",
              modelMap: { balanced: "claude-opus-4-1" },
            },
          }),
        ),
      ).toBe("claude-sonnet-4-6");
    });

    it("a catalog id from another vendor runs on the selected tier's mapping", () => {
      // An `openai` key cannot reach `anthropic/claude-opus-4.8`. The tier
      // the caller selected (default balanced) is the closest thing the key
      // can serve; the assistant-turn log names what actually ran.
      expect(
        idOf(
          selectModel({
            model: "anthropic/claude-opus-4.8",
            credential: openai(),
          }),
        ),
      ).toBe("gpt-5.2");
      expect(
        idOf(
          selectModel({
            model: "google/gemini-3-pro",
            tier: "fast",
            credential: openai({ balanced: "gpt-5.2", fast: "gpt-5.2-mini" }),
          }),
        ),
      ).toBe("gpt-5.2-mini");
    });

    it("an openai_compatible key never strips a prefix — its namespace is the customer's server's", () => {
      // `explicit/model-id` is not a map value, not a tier id, and the
      // `openai_compatible` arm has no vendor prefix to strip. Balanced runs.
      const model = selectModel({
        model: "openai/gpt-5.2",
        credential: compat(),
      });
      expect(idOf(model)).toBe("meta-llama/Llama-3.3-70B-Instruct-Turbo");
    });

    it("the routed keys and the platform key still send an explicit id untouched", () => {
      expect(
        idOf(
          selectModel({
            model: "openai/gpt-5.2",
            credential: {
              provider: "openrouter",
              apiKey: "sk-or-v1-0123456789",
              digest: "d-or",
            },
          }),
        ),
      ).toBe("openai/gpt-5.2");
      selectModel({ model: "openai/gpt-5.2" });
      expect(mocks.languageModel).toHaveBeenLastCalledWith("openai/gpt-5.2");
    });
  });

  it("rebuilds the client when the endpoint moves but the key does not", () => {
    // Same key, same digest, new URL. Keyed on the digest alone, the cache
    // would keep serving the client built on the OLD endpoint.
    selectModel({ tier: "balanced", credential: compat() });
    selectModel({
      tier: "balanced",
      credential: compat({ baseUrl: "https://api.fireworks.ai/inference/v1" }),
    });
    expect(mocks.createOpenAICompatible).toHaveBeenCalledTimes(2);
    expect(
      (mocks.createOpenAICompatible.mock.calls[1]?.[0] as { baseURL: string })
        .baseURL,
    ).toBe("https://api.fireworks.ai/inference/v1");
  });

  it("refuses an openai_compatible credential with no endpoint rather than guessing one", () => {
    expect(() =>
      selectModel({ tier: "balanced", credential: compat({ baseUrl: null }) }),
    ).toThrow(/no baseUrl/);
  });

  it("keeps embeddings on the platform key for every direct vendor, and says so for billing", () => {
    for (const provider of [
      "openai",
      "anthropic",
      "openai_compatible",
    ] as const) {
      expect(embeddingProvider(compat({ provider })).fundedBy).toBe("platform");
    }
  });
});

describe("the model's identity on the key that serves it (@oxagen/ai)", () => {
  // One string cannot mean both "what the endpoint is asked for" and "what the
  // catalog, the posture matrix and the provider tool ceilings are keyed by".
  // On a direct-vendor key the two differ, and every lookup made on the wire id
  // answers "unknown model": the reasoning effort a person asked for is
  // dropped, and the 128-tool refusal never fires (#3314, findings 1 and 2).
  beforeEach(() => {
    resetMocks();
    envValues = { ...TIER_ENV, OXAGEN_MODEL_PROVIDER: "gateway" };
  });

  const openaiKey: ModelCredential = {
    provider: "openai",
    apiKey: "sk-openai-0123456789",
    digest: "d-openai",
    modelMap: { balanced: "gpt-5.2" },
  };

  it("carries the wire id, the catalog id and the provider for a direct openai key", () => {
    expect(
      resolveModelIdentity({ tier: "balanced", credential: openaiKey }),
    ).toEqual({
      wireId: "gpt-5.2",
      catalogId: "openai/gpt-5.2",
      provider: "openai",
    });
  });

  it("restores the vendor prefix on a direct anthropic key", () => {
    expect(
      resolveModelIdentity({
        tier: "balanced",
        credential: {
          provider: "anthropic",
          apiKey: "sk-ant-0123456789",
          digest: "d-ant",
          modelMap: { balanced: "claude-sonnet-5" },
        },
      }),
    ).toEqual({
      wireId: "claude-sonnet-5",
      catalogId: "anthropic/claude-sonnet-5",
      provider: "anthropic",
    });
  });

  it("sends the wire id selectModel sends, never the catalog id", () => {
    // The catalog id is for lookups. Sending it would 404: `api.openai.com`
    // has no model called `openai/gpt-5.2`.
    const identity = resolveModelIdentity({
      tier: "balanced",
      credential: openaiKey,
    });
    const model = selectModel({ tier: "balanced", credential: openaiKey });
    expect((model as unknown as { modelId: string }).modelId).toBe(
      identity.wireId,
    );
  });

  it("leaves a gateway-shaped id alone on the platform key and the routed keys", () => {
    expect(resolveModelIdentity({ tier: "balanced" })).toEqual({
      wireId: "anthropic/claude-sonnet-5",
      catalogId: "anthropic/claude-sonnet-5",
      provider: "anthropic",
    });
    expect(
      resolveModelIdentity({
        tier: "balanced",
        credential: OPENROUTER_CREDENTIAL,
      }),
    ).toEqual({
      wireId: "anthropic/claude-sonnet-5",
      catalogId: "anthropic/claude-sonnet-5",
      provider: "anthropic",
    });
  });

  it("names openai_compatible as the provider and claims no catalog for its id", () => {
    // The endpoint is the customer's and so is the namespace: a gateway
    // prefix here would be a claim about models nobody has seen. What the
    // provider ceilings need is the KIND of endpoint, which this says.
    expect(
      resolveModelIdentity({
        tier: "balanced",
        credential: {
          provider: "openai_compatible",
          apiKey: "sk-together-0123456789",
          digest: "d-compat",
          baseUrl: "https://api.together.xyz/v1",
          modelMap: { balanced: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
        },
      }),
    ).toEqual({
      wireId: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      catalogId: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      provider: "openai_compatible",
    });
  });

  it("does not double a prefix the vendor's own spelling already carries", () => {
    expect(modelIdentityFor("openai/gpt-5.2", openaiKey).catalogId).toBe(
      "openai/gpt-5.2",
    );
  });

  it("reports no provider for a bare id nothing names", () => {
    expect(modelIdentityFor("some-local-model")).toEqual({
      wireId: "some-local-model",
      catalogId: "some-local-model",
      provider: null,
    });
  });
});
