// A 402 on the organization's own model key (#5408). The key is the
// organization's, so the text triage records names that key and keeps the
// provider's words, which say where to add credit. Oxagen's shared key never
// reaches this branch as a bare 402: @oxagen/ai names that refusal itself.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  selectModelForOrg: vi.fn(),
  laneBudget: vi.fn(),
}));
vi.mock("@oxagen/ai", () => ({
  CREDIT_REASONS: { CONSUME_ASSISTANT_TOKENS: "consume_assistant_tokens" },
  PLATFORM_PROVIDER_BALANCE_CODE: "platform_provider_balance",
  generateObjectFor: mocks.generateObjectFor,
  isPlatformProviderBalanceError: () => false,
  // The real check reads the AI SDK's APICallError status; this one reads the
  // same field off the fake below.
  isSpendRefusal: (err: unknown) => typeof err === "object" && err !== null && "statusCode" in err && err.statusCode === 402,
  modelIdOf: (model: { id: string }) => model.id,
  selectModelForOrg: mocks.selectModelForOrg,
}));
// The real lane gate would read the database, find no tenant scope, and fail
// open. Replacing it keeps this file about the model's refusal.
vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return { ...real, assertUnderWorkspaceLaneBudget: mocks.laneBudget };
});

const { aiTriageModelClient, orgKeyBalanceMessage } = await import("./triage-run");

/** The provider's answer when an account has no balance left. */
class ProviderRefusal extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

const OPENROUTER_402 = "Insufficient credits. Add more using https://openrouter.ai/settings/credits";
const scope = { orgId: "00000000-0000-4000-8000-000000000001", workspaceId: "00000000-0000-4000-8000-000000000002" };
const request = { system: "rules", prompt: "<triage-input>{}</triage-input>", schema: {} };

beforeEach(() => {
  mocks.generateObjectFor.mockReset();
  mocks.selectModelForOrg.mockReset();
  mocks.laneBudget.mockReset();
  mocks.laneBudget.mockResolvedValue(undefined);
});

describe("aiTriageModelClient on a 402", () => {
  it("names the organization's own key, and keeps what the provider said", async () => {
    mocks.selectModelForOrg.mockResolvedValue({ model: { id: "byok-model" }, fundedBy: "org" });
    const refusal = new ProviderRefusal(402, OPENROUTER_402);
    mocks.generateObjectFor.mockRejectedValue(refusal);
    const failed = aiTriageModelClient(scope).complete(request);
    await expect(failed).rejects.toThrow(
      `The model provider refused your organization's own model key for lack of balance. Add credit to the provider account behind that key. The provider said: ${OPENROUTER_402}`,
    );
    await expect(failed).rejects.toHaveProperty("cause", refusal);
  });

  it("reads the provider's status off the last attempt when the AI SDK wrapped it", async () => {
    mocks.selectModelForOrg.mockResolvedValue({ model: { id: "byok-model" }, fundedBy: "org" });
    const wrapped = Object.defineProperty(new Error("Failed after 3 attempts"), "lastError", {
      value: new ProviderRefusal(402, OPENROUTER_402),
    });
    mocks.generateObjectFor.mockRejectedValue(wrapped);
    await expect(aiTriageModelClient(scope).complete(request)).rejects.toThrow(/organization's own model key/);
  });

  it("leaves a platform-funded call's error as it is", async () => {
    mocks.selectModelForOrg.mockResolvedValue({ model: { id: "fast-model" }, fundedBy: "platform" });
    const refusal = new ProviderRefusal(402, OPENROUTER_402);
    mocks.generateObjectFor.mockRejectedValue(refusal);
    await expect(aiTriageModelClient(scope).complete(request)).rejects.toBe(refusal);
  });

  it("leaves any other error on the organization's key as it is", async () => {
    mocks.selectModelForOrg.mockResolvedValue({ model: { id: "byok-model" }, fundedBy: "org" });
    const outage = new ProviderRefusal(503, "overloaded");
    mocks.generateObjectFor.mockRejectedValue(outage);
    await expect(aiTriageModelClient(scope).complete(request)).rejects.toBe(outage);
  });
});

describe("orgKeyBalanceMessage", () => {
  it("drops the provider's closing full stop, so the reason triage adds after it reads with one", () => {
    expect(orgKeyBalanceMessage("No credits left. ")).toMatch(/The provider said: No credits left$/);
    expect(orgKeyBalanceMessage("")).toMatch(/The provider said: nothing$/);
  });
});
