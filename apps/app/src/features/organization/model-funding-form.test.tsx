// @vitest-environment jsdom
// The write surface of Organization › Model funding: choose a vendor, paste a
// key, test it, save it, remove it.
//
// The cases the design turns on:
//   - the fields follow the vendor (a URL only for an OpenAI-compatible
//     server, models only for a direct vendor);
//   - "the key works" and "the assistant can work with this model" are two
//     different answers, and the page says which one failed;
//   - the key does not stay in memory after a save, and is never rendered;
//   - Remove asks first, in the page.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCredential } from "@/data/contracts/org";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, testModelKey, saveModelKey, removeModelKey } = vi.hoisted(
  () => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    testModelKey: vi.fn(),
    saveModelKey: vi.fn(),
    removeModelKey: vi.fn(),
  }),
);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./model-funding-actions", () => ({
  testModelKey,
  saveModelKey,
  removeModelKey,
}));

const { ModelFundingForm } = await import("./model-funding-form");

const NONE: ModelCredential = {
  configured: false,
  provider: null,
  status: null,
  keyHint: null,
  baseUrl: null,
  modelMap: {},
  lastVerifiedAt: null,
  rotatedAt: null,
};

const STORED: ModelCredential = {
  configured: true,
  provider: "openai_compatible",
  status: "active",
  keyHint: "9f2c",
  baseUrl: "https://api.together.xyz/v1",
  modelMap: { balanced: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  lastVerifiedAt: "2026-09-18T12:00:00.000Z",
  rotatedAt: "2026-09-18T11:00:00.000Z",
};

const KEY = "sk-customer-secret-0123456789";

function renderForm(credential: ModelCredential = NONE) {
  return render(
    <IntlProvider>
      <ModelFundingForm org="acme" credential={credential} />
    </IntlProvider>,
  );
}

async function choose(provider: string) {
  await userEvent.selectOptions(screen.getByLabelText("Vendor"), provider);
}

beforeEach(() => {
  for (const fn of [testModelKey, saveModelKey, removeModelKey, router.refresh])
    fn.mockReset();
});
afterEach(cleanup);

describe("ModelFundingForm: the fields follow the vendor", () => {
  it("asks a routed vendor for a key and nothing else", async () => {
    renderForm();
    await choose("openrouter");
    expect(screen.getByLabelText("API key")).toBeTruthy();
    expect(screen.queryByLabelText("Endpoint URL")).toBeNull();
    expect(screen.queryByTestId("funding-models")).toBeNull();
  });

  it("asks a direct vendor for the model the assistant runs on", async () => {
    renderForm();
    await choose("openai");
    expect(screen.getByTestId("funding-models")).toBeTruthy();
    expect(screen.getByLabelText("Balanced model")).toBeTruthy();
    expect(screen.queryByLabelText("Endpoint URL")).toBeNull();
  });

  it("asks an OpenAI-compatible server for its URL and a model", async () => {
    renderForm();
    await choose("openai_compatible");
    expect(screen.getByLabelText("Endpoint URL")).toBeTruthy();
    expect(screen.getByLabelText("Balanced model")).toBeTruthy();
  });

  it("warns that Anthropic's endpoint has no prompt caching, and only for Anthropic", async () => {
    renderForm();
    await choose("anthropic");
    expect(screen.getByTestId("funding-anthropic-note")).toBeTruthy();
    await choose("openai");
    expect(screen.queryByTestId("funding-anthropic-note")).toBeNull();
  });
});

describe("ModelFundingForm: testing a key", () => {
  it("sends the endpoint and the balanced model for an OpenAI-compatible server", async () => {
    testModelKey.mockResolvedValue({
      ok: true,
      value: { ok: true, toolCalling: true, latencyMs: 120, error: null },
    });
    renderForm();
    await choose("openai_compatible");
    await userEvent.type(screen.getByLabelText("API key"), KEY);
    await userEvent.type(
      screen.getByLabelText("Endpoint URL"),
      "https://api.together.xyz/v1",
    );
    await userEvent.type(screen.getByLabelText("Balanced model"), "llama-70b");
    await userEvent.click(screen.getByTestId("funding-test"));
    await waitFor(() => expect(testModelKey).toHaveBeenCalledTimes(1));
    expect(testModelKey).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({
        provider: "openai_compatible",
        apiKey: KEY,
        baseUrl: "https://api.together.xyz/v1",
        balanced: "llama-70b",
      }),
    );
    expect(await screen.findByTestId("funding-verdict-ok")).toBeTruthy();
  });

  it("says plainly when the key works but the model cannot use tools", async () => {
    testModelKey.mockResolvedValue({
      ok: true,
      value: {
        ok: true,
        toolCalling: false,
        latencyMs: 90,
        error: "tools are not supported for this model",
      },
    });
    renderForm();
    await choose("openai_compatible");
    await userEvent.type(screen.getByLabelText("API key"), KEY);
    await userEvent.click(screen.getByTestId("funding-test"));
    const alert = await screen.findByTestId("funding-verdict-no-tools");
    expect(alert.textContent).toContain("cannot use tools");
    expect(alert.textContent).toContain("tools are not supported");
  });

  it("shows the vendor's reason when it refuses the key", async () => {
    testModelKey.mockResolvedValue({
      ok: true,
      value: {
        ok: false,
        toolCalling: null,
        latencyMs: 40,
        error: "Invalid API key",
      },
    });
    renderForm();
    await userEvent.type(screen.getByLabelText("API key"), KEY);
    await userEvent.click(screen.getByTestId("funding-test"));
    const alert = await screen.findByTestId("funding-verdict-refused");
    expect(alert.textContent).toContain("Invalid API key");
  });

  it("names the missing field next to it", async () => {
    testModelKey.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "balanced_model_required",
      field: "balanced",
    });
    renderForm();
    await choose("openai");
    await userEvent.type(screen.getByLabelText("API key"), KEY);
    await userEvent.click(screen.getByTestId("funding-test"));
    expect(
      await screen.findByText("Enter the model the assistant should use."),
    ).toBeTruthy();
  });
});

describe("ModelFundingForm: saving", () => {
  it("saves, clears the key from the field, and re-reads the page", async () => {
    saveModelKey.mockResolvedValue({ ok: true, value: STORED });
    renderForm();
    const field = screen.getByLabelText("API key") as HTMLInputElement;
    await userEvent.type(field, KEY);
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(saveModelKey).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("funding-saved")).toBeTruthy();
    expect(field.value).toBe("");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("says who may change this when the server refuses the role", async () => {
    saveModelKey.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    renderForm();
    await userEvent.type(screen.getByLabelText("API key"), KEY);
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(
      (await screen.findByTestId("funding-failure")).textContent,
    ).toContain("owner or admin");
  });

  it("reports a write that threw instead of answering", async () => {
    saveModelKey.mockRejectedValue(new Error("network"));
    renderForm();
    await userEvent.type(screen.getByLabelText("API key"), KEY);
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByTestId("funding-failure")).toBeTruthy();
  });
});

describe("ModelFundingForm: the stored key", () => {
  it("shows the vendor, the last four characters, the endpoint and the model, never the key", () => {
    const { container } = renderForm(STORED);
    const current = screen.getByTestId("funding-current");
    expect(current.textContent).toContain("Other OpenAI-compatible server");
    expect(current.textContent).toContain("9f2c");
    expect(current.textContent).toContain("https://api.together.xyz/v1");
    expect(current.textContent).toContain(
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    );
    // The field starts empty: a stored key is never sent back to the page.
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe(
      "",
    );
    expect(container.textContent).not.toContain(KEY);
  });

  it("says the organization is on Oxagen's key when none is stored", () => {
    renderForm(NONE);
    expect(screen.getByTestId("funding-none")).toBeTruthy();
    expect(screen.queryByTestId("funding-remove")).toBeNull();
  });

  it("asks before removing, in the page, and removes only on yes", async () => {
    removeModelKey.mockResolvedValue({ ok: true, value: NONE });
    renderForm(STORED);
    await userEvent.click(screen.getByTestId("funding-remove"));
    expect(screen.getByTestId("funding-remove-confirm")).toBeTruthy();
    expect(removeModelKey).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeModelKey).toHaveBeenCalledWith("acme"));
    expect(router.refresh).toHaveBeenCalled();
  });

  it("keeps the key when the person backs out of removing it", async () => {
    renderForm(STORED);
    await userEvent.click(screen.getByTestId("funding-remove"));
    await userEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByTestId("funding-remove-confirm")).toBeNull();
    expect(removeModelKey).not.toHaveBeenCalled();
  });
});

describe("ModelFundingForm: accessibility", () => {
  it("has no axe violations with a stored key", async () => {
    const { container } = renderForm(STORED);
    await expectNoAxe(container);
  });
});
