// The three Model funding writes through the real kernel seam (INV-19): the
// viewer resolution and the kernel's invoke() are the only fakes, so each case
// shows what the person gets back and whether the capability ran.
//
// The two that matter most: a missing field is refused before any capability
// runs, so the key never reaches the kernel for a form that could not have
// succeeded; and nothing any action returns carries the key.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { OrgCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { testModelKey, saveModelKey, removeModelKey } = await import(
  "./model-funding-actions"
);

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
});

const KEY = "sk-customer-secret-0123456789";

const blank = {
  apiKey: KEY,
  baseUrl: "",
  balanced: "",
  fast: "",
  precise: "",
};

const view = {
  configured: true,
  provider: "openai",
  status: "active",
  keyHint: "6789",
  baseUrl: null,
  modelMap: { balanced: "gpt-5.2" },
  lastVerifiedAt: null,
  rotatedAt: "2026-09-18T11:00:00.000Z",
};

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("saveModelKey", () => {
  it("stores a routed key with no endpoint and no models", async () => {
    invoke.mockResolvedValue({ ...view, provider: "openrouter", modelMap: {} });
    const out = await saveModelKey("acme", {
      ...blank,
      provider: "openrouter",
    });
    expect(out.ok).toBe(true);
    const [name, input] = invoke.mock.calls[0]!;
    expect(name).toBe("set_model_credential");
    expect(input).toEqual({ provider: "openrouter", apiKey: KEY });
  });

  it("sends a direct vendor's models, dropping the ones left blank", async () => {
    invoke.mockResolvedValue(view);
    await saveModelKey("acme", {
      ...blank,
      provider: "openai",
      balanced: " gpt-5.2 ",
    });
    expect(invoke.mock.calls[0]![1]).toEqual({
      provider: "openai",
      apiKey: KEY,
      modelMap: { balanced: "gpt-5.2" },
    });
  });

  it("sends the endpoint for an OpenAI-compatible server", async () => {
    invoke.mockResolvedValue({ ...view, provider: "openai_compatible" });
    await saveModelKey("acme", {
      ...blank,
      provider: "openai_compatible",
      baseUrl: "https://api.together.xyz/v1",
      balanced: "llama-70b",
    });
    expect(invoke.mock.calls[0]![1]).toMatchObject({
      baseUrl: "https://api.together.xyz/v1",
      modelMap: { balanced: "llama-70b" },
    });
  });

  it("refuses a direct vendor with no balanced model before any capability runs", async () => {
    const out = await saveModelKey("acme", { ...blank, provider: "anthropic" });
    expect(out).toEqual({
      ok: false,
      reason: "invalid",
      code: "balanced_model_required",
      field: "balanced",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an OpenAI-compatible server with no URL before any capability runs", async () => {
    const out = await saveModelKey("acme", {
      ...blank,
      provider: "openai_compatible",
      balanced: "m",
    });
    expect(out).toMatchObject({ ok: false, field: "baseUrl" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an empty key before any capability runs", async () => {
    const out = await saveModelKey("acme", {
      ...blank,
      apiKey: " ",
      provider: "openrouter",
    });
    expect(out).toMatchObject({ ok: false, field: "apiKey" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("answers a role refusal as denied, with nothing stored", async () => {
    invoke.mockRejectedValue(
      new kernel.CapabilityError(
        "set_model_credential",
        "authz_denied",
        "Forbidden",
      ),
    );
    const out = await saveModelKey("acme", {
      ...blank,
      provider: "openrouter",
    });
    expect(out).toMatchObject({ ok: false, reason: "denied" });
  });

  it("never returns the key", async () => {
    invoke.mockResolvedValue(view);
    const out = await saveModelKey("acme", {
      ...blank,
      provider: "openai",
      balanced: "gpt-5.2",
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });
});

describe("testModelKey", () => {
  it("asks the balanced model the tool question for an OpenAI-compatible server", async () => {
    invoke.mockResolvedValue({
      ok: true,
      provider: "openai_compatible",
      latencyMs: 80,
      error: null,
      toolCalling: true,
    });
    const out = await testModelKey("acme", {
      ...blank,
      provider: "openai_compatible",
      baseUrl: "https://api.together.xyz/v1",
      balanced: "llama-70b",
    });
    expect(invoke.mock.calls[0]![0]).toBe("verify_model_credential");
    expect(invoke.mock.calls[0]![1]).toEqual({
      provider: "openai_compatible",
      apiKey: KEY,
      baseUrl: "https://api.together.xyz/v1",
      toolProbeModel: "llama-70b",
    });
    expect(out).toEqual({
      ok: true,
      value: { ok: true, toolCalling: true, latencyMs: 80, error: null },
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("sends no endpoint for a vendor whose URL Oxagen spells", async () => {
    invoke.mockResolvedValue({
      ok: true,
      provider: "openrouter",
      latencyMs: 30,
      error: null,
      toolCalling: true,
    });
    await testModelKey("acme", { ...blank, provider: "openrouter" });
    expect(invoke.mock.calls[0]![1]).toEqual({
      provider: "openrouter",
      apiKey: KEY,
    });
  });
});

describe("removeModelKey", () => {
  it("removes the organisation's key", async () => {
    invoke.mockResolvedValue({ ...view, configured: false, provider: null });
    const out = await removeModelKey("acme");
    expect(invoke.mock.calls[0]![0]).toBe("delete_model_credential");
    expect(out.ok).toBe(true);
  });
});
