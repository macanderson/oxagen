/**
 * The pair that must not be separated (ADR-131).
 *
 * Fifteen call sites read `fundedBy` off the funding source and then built
 * the model with a credential-less `selectModel`, so an organisation on its
 * own key was reported as having paid while Oxagen's shared key paid the
 * vendor. These tests hold the two halves together: every case asserts what
 * reached `selectModel` AND what `fundedBy` came back as, because either one
 * alone is what let the defect through.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveModelFundingSource: vi.fn(),
  selectModel: vi.fn(),
}));

vi.mock("./funding-source", () => ({
  resolveModelFundingSource: mocks.resolveModelFundingSource,
}));

vi.mock("./models", () => ({
  selectModel: mocks.selectModel,
}));

// `wrapLanguageModel` is the real one: the minted-key test below drives the
// wrapped model's `doGenerate` and `doStream` to prove the refusal mapping.

import { APICallError } from "@ai-sdk/provider";
import { AssistantModelKeyLimitError } from "./assistant-model-key-limit";
import {
  selectModelForOrg,
  selectModelFromFunding,
} from "./select-model-for-org";

/** The two entry points the middleware wraps, as a test drives them. */
type Callable = {
  doGenerate: (o: unknown) => Promise<unknown>;
  doStream: (o: unknown) => Promise<unknown>;
};
const callable = (model: unknown) => model as Callable;

const ORG = "00000000-0000-4000-8000-0000000000aa";

const BROUGHT_KEY = {
  provider: "openrouter" as const,
  apiKey: "sk-or-v1-customer-secret",
  digest: "sha256:abc",
  baseUrl: null,
  modelMap: {},
};

const MINTED_KEY = {
  provider: "openrouter" as const,
  apiKey: "sk-or-v1-oxagen-minted",
  digest: "sha256:def",
  baseUrl: null,
  modelMap: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectModel.mockReturnValue({ modelId: "a-model" });
});

describe("selectModelForOrg", () => {
  it("builds the shared model and reports platform funding when the organisation has no key", async () => {
    mocks.resolveModelFundingSource.mockResolvedValue({
      fundedBy: "platform",
    });

    const selection = await selectModelForOrg(ORG, { tier: "fast" });

    expect(mocks.resolveModelFundingSource).toHaveBeenCalledWith(ORG);
    // No credential key at all, rather than `credential: undefined` — the
    // provider factory branches on presence.
    expect(mocks.selectModel).toHaveBeenCalledWith({ tier: "fast" });
    expect(mocks.selectModel.mock.calls[0]![0]).not.toHaveProperty(
      "credential",
    );
    expect(selection).toEqual({
      model: { modelId: "a-model" },
      fundedBy: "platform",
    });
  });

  it("builds on the customer's key AND bills the customer, never one without the other", async () => {
    mocks.resolveModelFundingSource.mockResolvedValue({
      fundedBy: "org",
      modelKey: BROUGHT_KEY,
      keyHint: "cret",
    });

    const selection = await selectModelForOrg(ORG, { tier: "precise" });

    expect(mocks.selectModel).toHaveBeenCalledWith({
      tier: "precise",
      credential: BROUGHT_KEY,
    });
    expect(selection.fundedBy).toBe("org");
  });

  it("builds on the key Oxagen minted for the organisation and still bills the tokens", async () => {
    // The combination ADR-131 introduced, and the reason `fundedBy` can no
    // longer be read as "does this organisation have a key?". It has one; the
    // tokens are still Oxagen's to pay for.
    mocks.resolveModelFundingSource.mockResolvedValue({
      fundedBy: "platform",
      modelKey: MINTED_KEY,
      keyHint: "nted",
    });

    const selection = await selectModelForOrg(ORG, { tier: "fast" });

    expect(mocks.selectModel).toHaveBeenCalledWith({
      tier: "fast",
      credential: MINTED_KEY,
    });
    expect(selection.fundedBy).toBe("platform");
  });

  describe("a minted key's spend refusal (ADR-131 §3, §9)", () => {
    /** A model whose vendor answers 402 to every call. */
    function refusingModel() {
      const refusal = new APICallError({
        message: "Key limit exceeded",
        url: "https://openrouter.ai/api/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 402,
        responseBody: '{"error":{"message":"Key limit exceeded","code":402}}',
      });
      return {
        specificationVersion: "v4" as const,
        provider: "openrouter",
        modelId: "a-model",
        supportedUrls: {},
        doGenerate: vi.fn(async () => {
          throw refusal;
        }),
        doStream: vi.fn(async () => {
          throw refusal;
        }),
      };
    }

    it("reaches the caller as a named error with a message the assistant can show", async () => {
      mocks.selectModel.mockReturnValue(refusingModel());
      mocks.resolveModelFundingSource.mockResolvedValue({
        fundedBy: "platform",
        modelKey: MINTED_KEY,
        keyHint: "nted",
      });
      const { model } = await selectModelForOrg(ORG, { tier: "fast" });
      const wrapped = callable(model);
      for (const call of [wrapped.doGenerate, wrapped.doStream]) {
        const err: unknown = await call
          .call(wrapped, { prompt: [] })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AssistantModelKeyLimitError);
        const refused = err as AssistantModelKeyLimitError;
        expect(refused.code).toBe("assistant_model_key_limit");
        expect(refused.keyHint).toBe("nted");
        expect(refused.message).toMatch(/daily ceiling/);
        expect(refused.message).not.toMatch(/openrouter|sk-or-v1/i);
      }
    });

    it("does not fall back to the shared key", async () => {
      // The ceiling bounds one organisation's blast radius on the shared
      // account. A retry on the shared key would spend past it the moment
      // it was reached, so the refusal is final until the ceiling resets.
      mocks.selectModel.mockReturnValue(refusingModel());
      mocks.resolveModelFundingSource.mockResolvedValue({
        fundedBy: "platform",
        modelKey: MINTED_KEY,
        keyHint: "nted",
      });
      const { model } = await selectModelForOrg(ORG);
      await expect(
        callable(model).doGenerate({ prompt: [] }),
      ).rejects.toBeInstanceOf(AssistantModelKeyLimitError);
      // One build, one key: nothing asked `selectModel` for a second model.
      expect(mocks.selectModel).toHaveBeenCalledTimes(1);
    });

    it("passes every other error through untouched", async () => {
      const outage = new Error("upstream 503");
      mocks.selectModel.mockReturnValue({
        ...refusingModel(),
        doGenerate: vi.fn(async () => {
          throw outage;
        }),
      });
      mocks.resolveModelFundingSource.mockResolvedValue({
        fundedBy: "platform",
        modelKey: MINTED_KEY,
        keyHint: "nted",
      });
      const { model } = await selectModelForOrg(ORG);
      await expect(callable(model).doGenerate({ prompt: [] })).rejects.toBe(
        outage,
      );
    });

    it("leaves a key the customer brought unwrapped: its 402 is the customer's own account", async () => {
      const raw = refusingModel();
      mocks.selectModel.mockReturnValue(raw);
      mocks.resolveModelFundingSource.mockResolvedValue({
        fundedBy: "org",
        modelKey: BROUGHT_KEY,
        keyHint: "cret",
      });
      const { model } = await selectModelForOrg(ORG);
      expect(model).toBe(raw);
    });

    it("leaves the shared key unwrapped", async () => {
      const raw = refusingModel();
      mocks.selectModel.mockReturnValue(raw);
      mocks.resolveModelFundingSource.mockResolvedValue({
        fundedBy: "platform",
      });
      const { model } = await selectModelForOrg(ORG);
      expect(model).toBe(raw);
    });
  });

  it("passes the caller's selector through and lets the organisation own the key", async () => {
    mocks.resolveModelFundingSource.mockResolvedValue({
      fundedBy: "org",
      modelKey: BROUGHT_KEY,
      keyHint: "cret",
    });

    await selectModelForOrg(ORG, { model: "anthropic/claude-sonnet-5" });

    expect(mocks.selectModel).toHaveBeenCalledWith({
      model: "anthropic/claude-sonnet-5",
      credential: BROUGHT_KEY,
    });
  });

  it("a caller that passed a credential of its own cannot override the organisation's", async () => {
    // The selector type omits `credential`, so this is a compile error in
    // source. The runtime behaviour is asserted anyway: the resolved key
    // wins, because the caller does not choose which organisation pays.
    mocks.resolveModelFundingSource.mockResolvedValue({
      fundedBy: "org",
      modelKey: BROUGHT_KEY,
      keyHint: "cret",
    });

    await selectModelForOrg(ORG, {
      tier: "fast",
      credential: { provider: "openrouter", apiKey: "sk-or-v1-someone-else" },
    } as never);

    expect(mocks.selectModel.mock.calls[0]![0].credential).toBe(BROUGHT_KEY);
  });

  it("defaults the selector, so a caller that wants only the funding answer still gets a model", async () => {
    mocks.resolveModelFundingSource.mockResolvedValue({ fundedBy: "platform" });
    await expect(selectModelForOrg(ORG)).resolves.toMatchObject({
      fundedBy: "platform",
    });
    expect(mocks.selectModel).toHaveBeenCalledWith({});
  });

  it("propagates a failed funding read rather than quietly building on the shared key", async () => {
    // Falling back here would reintroduce the defect this module removes: a
    // turn on Oxagen's key that the meter records against nobody.
    mocks.resolveModelFundingSource.mockRejectedValue(new Error("pg down"));
    await expect(selectModelForOrg(ORG, { tier: "fast" })).rejects.toThrow(
      "pg down",
    );
    expect(mocks.selectModel).not.toHaveBeenCalled();
  });
});

it("builds from one existing funding snapshot without resolving changed settings again", () => {
  const selection = selectModelFromFunding(
    ORG,
    { fundedBy: "org", modelKey: BROUGHT_KEY, keyHint: "test" },
    { tier: "fast" },
  );
  expect(mocks.resolveModelFundingSource).not.toHaveBeenCalled();
  expect(mocks.selectModel).toHaveBeenCalledWith({
    tier: "fast",
    credential: BROUGHT_KEY,
  });
  expect(selection.fundedBy).toBe("org");
});
