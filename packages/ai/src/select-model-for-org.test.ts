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

import { selectModelForOrg } from "./select-model-for-org";

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
