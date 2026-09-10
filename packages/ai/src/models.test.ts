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
  resetCredentialClientsForTests,
  resolvedTierCatalog,
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
