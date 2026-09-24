// @vitest-environment jsdom
// The write surface of Organization › Model funding and routes, the design's
// customer-key state: one password field, Test and save, and Remove the key.
//
// The cases the design turns on:
//   - Test and save stores a key only after the vendor accepted it, and the
//     assistant can call tools with it;
//   - "the key works" and "the assistant can work with this model" are two
//     different answers, and the page says which one failed;
//   - another vendor's fields follow the vendor (a URL only for an
//     OpenAI-compatible server, models only for a direct vendor);
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

const KEY_LABEL = "Your OpenRouter or vendor key";

async function choose(provider: string) {
  await userEvent.selectOptions(screen.getByLabelText("Vendor"), provider);
}

const ACCEPTED = {
  ok: true,
  value: { ok: true, toolCalling: true, latencyMs: 120, error: null },
};

async function testAndSave() {
  await userEvent.click(screen.getByRole("button", { name: "Test and save" }));
}

beforeEach(() => {
  for (const fn of [testModelKey, saveModelKey, removeModelKey, router.refresh])
    fn.mockReset();
});
afterEach(cleanup);

describe("ModelFundingForm: the design's customer-key state", () => {
  it("is one password field and Test and save, with OpenRouter by default", () => {
    renderForm();
    const field = screen.getByLabelText(KEY_LABEL);
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAccessibleDescription(
      "Oxagen calls the model with it once to check it works, then stores it encrypted. It is never returned to a screen and never read from the environment.",
    );
    expect(
      screen.getByRole("button", { name: "Test and save" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Vendor")).toHaveValue("openrouter");
    expect(screen.getByTestId("funding-vendor")).not.toHaveAttribute("open");
    expect(screen.queryByLabelText("Endpoint URL")).toBeNull();
    expect(screen.queryByTestId("funding-models")).toBeNull();
  });

  it("draws Test and save plain, because the header's Create a workspace is the one gold action", () => {
    renderForm();
    const save = screen.getByRole("button", { name: "Test and save" });
    expect(save.className).not.toContain("bg-button-primary-bg");
  });
});

describe("ModelFundingForm: another vendor's fields follow the vendor", () => {
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

  it("opens Another vendor on a stored key from one", () => {
    renderForm(STORED);
    expect(screen.getByTestId("funding-vendor")).toHaveAttribute("open");
    expect(screen.getByLabelText("Vendor")).toHaveValue("openai_compatible");
  });

  it("warns that Anthropic's endpoint has no prompt caching, and only for Anthropic", async () => {
    renderForm();
    await choose("anthropic");
    expect(screen.getByTestId("funding-anthropic-note")).toBeTruthy();
    await choose("openai");
    expect(screen.queryByTestId("funding-anthropic-note")).toBeNull();
  });
});

describe("ModelFundingForm: Test and save", () => {
  it("tests the key, then saves it, clears the field and re-reads the page", async () => {
    testModelKey.mockResolvedValue(ACCEPTED);
    saveModelKey.mockResolvedValue({ ok: true, value: STORED });
    renderForm();
    const field = screen.getByLabelText<HTMLInputElement>(KEY_LABEL);
    await userEvent.type(field, KEY);
    await testAndSave();
    await waitFor(() => {
      expect(saveModelKey).toHaveBeenCalledTimes(1);
    });
    expect(testModelKey).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({ provider: "openrouter", apiKey: KEY }),
    );
    expect(testModelKey.mock.invocationCallOrder[0]).toBeLessThan(
      saveModelKey.mock.invocationCallOrder[0] ?? 0,
    );
    expect(await screen.findByTestId("funding-saved")).toBeTruthy();
    expect(field.value).toBe("");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("sends the endpoint and the balanced model for an OpenAI-compatible server", async () => {
    testModelKey.mockResolvedValue(ACCEPTED);
    saveModelKey.mockResolvedValue({ ok: true, value: STORED });
    renderForm();
    await choose("openai_compatible");
    await userEvent.type(screen.getByLabelText(KEY_LABEL), KEY);
    await userEvent.type(
      screen.getByLabelText("Endpoint URL"),
      "https://api.together.xyz/v1",
    );
    await userEvent.type(screen.getByLabelText("Balanced model"), "llama-70b");
    await testAndSave();
    await waitFor(() => {
      expect(saveModelKey).toHaveBeenCalledTimes(1);
    });
    expect(saveModelKey).toHaveBeenCalledWith(
      "acme",
      expect.objectContaining({
        provider: "openai_compatible",
        apiKey: KEY,
        baseUrl: "https://api.together.xyz/v1",
        balanced: "llama-70b",
      }),
    );
  });

  it("stores nothing, and says so plainly, when the key works but the model cannot use tools (negative)", async () => {
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
    await userEvent.type(screen.getByLabelText(KEY_LABEL), KEY);
    await testAndSave();
    const alert = await screen.findByTestId("funding-verdict-no-tools");
    expect(alert.textContent).toContain("cannot use tools");
    expect(alert.textContent).toContain("tools are not supported");
    expect(saveModelKey).not.toHaveBeenCalled();
  });

  it("stores nothing, and shows the vendor's reason, when it refuses the key (negative)", async () => {
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
    await userEvent.type(screen.getByLabelText(KEY_LABEL), KEY);
    await testAndSave();
    const alert = await screen.findByTestId("funding-verdict-refused");
    expect(alert.textContent).toContain("Invalid API key");
    expect(saveModelKey).not.toHaveBeenCalled();
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
    await userEvent.type(screen.getByLabelText(KEY_LABEL), KEY);
    await testAndSave();
    expect(
      await screen.findByText("Enter the model the assistant should use."),
    ).toBeTruthy();
    expect(saveModelKey).not.toHaveBeenCalled();
  });

  it("says who may change this when the server refuses the role", async () => {
    testModelKey.mockResolvedValue(ACCEPTED);
    saveModelKey.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    renderForm();
    await userEvent.type(screen.getByLabelText(KEY_LABEL), KEY);
    await testAndSave();
    expect(
      (await screen.findByTestId("funding-failure")).textContent,
    ).toContain("owner or admin");
  });

  it("reports a write that threw instead of answering", async () => {
    testModelKey.mockRejectedValue(new Error("network"));
    renderForm();
    await userEvent.type(screen.getByLabelText(KEY_LABEL), KEY);
    await testAndSave();
    expect(await screen.findByTestId("funding-failure")).toBeTruthy();
  });
});

describe("ModelFundingForm: the stored key", () => {
  it("starts the field empty and never renders the key", () => {
    const { container } = renderForm(STORED);
    // A stored key is never sent back to the page.
    expect(screen.getByLabelText<HTMLInputElement>(KEY_LABEL).value).toBe("");
    expect(container.textContent).not.toContain(KEY);
  });

  it("offers Remove the key only when one is held", () => {
    renderForm(NONE);
    expect(screen.queryByTestId("funding-remove")).toBeNull();
    cleanup();
    renderForm(STORED);
    expect(screen.getByTestId("funding-remove")).toHaveTextContent(
      "Remove the key",
    );
  });

  it("asks before removing, in the page, and removes only on yes", async () => {
    removeModelKey.mockResolvedValue({ ok: true, value: NONE });
    renderForm(STORED);
    await userEvent.click(screen.getByTestId("funding-remove"));
    expect(screen.getByTestId("funding-remove-confirm")).toBeTruthy();
    expect(removeModelKey).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(removeModelKey).toHaveBeenCalledWith("acme");
    });
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
