// @vitest-environment jsdom
/**
 * provider-model-picker.test.tsx
 *
 * Unit tests for ProviderModelPicker (cascading Provider → Model select).
 *
 * Base UI's Select popup requires floating-UI layout to open, which JSDOM does
 * not provide (see packages/ui select.test.tsx note), so — following the
 * repo-selector.test.tsx convention — we replace `@/components/ui/select` with a
 * minimal shim: each SelectItem renders as a button that fires the enclosing
 * Select's onValueChange with its own value. That lets us drive the cascade
 * (pick a provider → its models populate → pick a model → onChange fires) and
 * the default-option path without portals or layout.
 *
 * Covered:
 *   - renders a provider option per text-capable vendor
 *   - selecting a provider populates that provider's models
 *   - selecting a model calls onChange with the model id
 *   - selecting the default option calls onChange(null)
 *   - selecting a provider surfaces its real @oxagen/ai/posture badges
 *     (catalog and posture themselves are left UNMOCKED — real registry
 *     data, same convention this file already uses for model names)
 */

import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

// A React-context bridge so each SelectItem shim can reach the onValueChange of
// its enclosing Select without threading props through the (opaque) children.
const SelectCtx = React.createContext<((v: string) => void) | undefined>(
  undefined,
);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...props }: { children: React.ReactNode }) => (
    <label {...props}>{children}</label>
  ),
}));

// Badge and Tooltip are mocked the same way every other test file in this
// repo mocks them (jsdom cannot lay out Base UI's floating-ui popups) — see
// model-picker.test.tsx / prompt-cache-bar.test.tsx for the same shim.
vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant,
    size,
    className,
    title,
    ...rest
  }: {
    children?: React.ReactNode;
    variant?: string;
    size?: string;
    className?: string;
    title?: string;
  }) => (
    <span
      data-variant={variant}
      data-size={size}
      title={title}
      className={className}
      {...rest}
    >
      {children}
    </span>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    render: trigger,
    children,
  }: {
    render: React.ReactElement;
    children: React.ReactNode;
  }) =>
    React.isValidElement(trigger)
      ? React.cloneElement(trigger, {}, children)
      : null,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// Render the vendor icon as a testable stub (no real SVG needed here).
vi.mock("../provider-icon", () => ({
  ProviderIcon: ({ vendor }: { vendor: string }) => (
    <span data-testid={`icon-${vendor}`} />
  ),
  PROVIDER_ACCENT: {},
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    value,
    disabled,
  }: {
    children: React.ReactNode;
    onValueChange?: (v: string) => void;
    value?: string;
    disabled?: boolean;
  }) => (
    <SelectCtx.Provider value={disabled ? undefined : onValueChange}>
      <div data-testid="select" data-value={value} data-disabled={disabled}>
        {children}
      </div>
    </SelectCtx.Provider>
  ),
  SelectTrigger: ({
    children,
    "aria-labelledby": ariaLabelledby,
    id,
  }: {
    children: React.ReactNode;
    "aria-labelledby"?: string;
    id?: string;
  }) => (
    <div data-testid="select-trigger" id={id} aria-labelledby={ariaLabelledby}>
      {children}
    </div>
  ),
  SelectValue: ({
    placeholder,
    children,
  }: {
    placeholder?: string;
    children?: React.ReactNode;
  }) => <span>{children ?? placeholder}</span>,
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => {
    const onValueChange = React.useContext(SelectCtx);
    return (
      <button
        type="button"
        role="option"
        aria-selected={false}
        data-value={value}
        disabled={!onValueChange}
        onClick={() => onValueChange?.(value)}
      >
        {children}
      </button>
    );
  },
}));

async function importPicker() {
  const mod = await import("../provider-model-picker");
  return mod.ProviderModelPicker;
}

/** The provider option button for a vendor value (e.g. "anthropic"). */
function providerOption(vendor: string): HTMLElement {
  const el = screen
    .getAllByRole("option")
    .find((o) => o.getAttribute("data-value") === vendor);
  if (!el) throw new Error(`no provider option for ${vendor}`);
  return el;
}

describe("ProviderModelPicker", () => {
  it("renders a provider option for each text-capable vendor", async () => {
    const ProviderModelPicker = await importPicker();
    render(<ProviderModelPicker value={null} onChange={vi.fn()} />);

    // Flagship providers are always present (they back the text tiers).
    expect(providerOption("anthropic")).toBeInTheDocument();
    expect(providerOption("openai")).toBeInTheDocument();
    expect(providerOption("google")).toBeInTheDocument();
    // A pure image vendor (bfl / FLUX) has no text models → no provider option.
    expect(
      screen
        .getAllByRole("option")
        .some((o) => o.getAttribute("data-value") === "bfl"),
    ).toBe(false);
  });

  it("shows the default option and both labels", async () => {
    const ProviderModelPicker = await importPicker();
    render(
      <ProviderModelPicker
        value={null}
        onChange={vi.fn()}
        providerLabel="Provider"
        modelLabel="Model"
      />,
    );
    expect(screen.getByText("Default tier")).toBeInTheDocument();
    expect(screen.getByText("Provider")).toBeInTheDocument();
    expect(screen.getByText("Model")).toBeInTheDocument();
  });

  it("selecting a provider populates that provider's models", async () => {
    const ProviderModelPicker = await importPicker();
    render(<ProviderModelPicker value={null} onChange={vi.fn()} />);

    // Before choosing a provider, no model options are shown.
    expect(screen.queryByText("Claude Opus 4.8")).not.toBeInTheDocument();

    await userEvent.click(providerOption("anthropic"));

    // Anthropic's text-capable models now populate the model select.
    expect(screen.getByText("Claude Opus 4.8")).toBeInTheDocument();
    expect(screen.getByText("Claude Sonnet 5")).toBeInTheDocument();
    // An OpenAI model must NOT appear in the Anthropic-scoped list.
    expect(screen.queryByText("GPT-5.2")).not.toBeInTheDocument();
  });

  it("selecting a model calls onChange with the model id", async () => {
    const onChange = vi.fn();
    const ProviderModelPicker = await importPicker();
    render(<ProviderModelPicker value={null} onChange={onChange} />);

    await userEvent.click(providerOption("anthropic"));
    // Picking a provider (with the default option present) clears the model.
    expect(onChange).toHaveBeenLastCalledWith(null);

    const modelOption = screen
      .getAllByRole("option")
      .find(
        (o) => o.getAttribute("data-value") === "anthropic/claude-opus-4.8",
      );
    expect(modelOption).toBeDefined();
    await userEvent.click(modelOption as HTMLElement);

    expect(onChange).toHaveBeenLastCalledWith("anthropic/claude-opus-4.8");
  });

  it("selecting the default option calls onChange(null)", async () => {
    const onChange = vi.fn();
    const ProviderModelPicker = await importPicker();
    // Start with a concrete model selected so the default choice is a change.
    render(
      <ProviderModelPicker
        value="anthropic/claude-opus-4.8"
        onChange={onChange}
      />,
    );

    const defaultOption = screen
      .getAllByRole("option")
      .find((o) => o.getAttribute("data-value") === "__default__");
    expect(defaultOption).toBeDefined();
    await userEvent.click(defaultOption as HTMLElement);

    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("auto-selects the first model when includeDefaultOption is false", async () => {
    const onChange = vi.fn();
    const ProviderModelPicker = await importPicker();
    render(
      <ProviderModelPicker
        value={null}
        onChange={onChange}
        includeDefaultOption={false}
      />,
    );

    // No default option is rendered.
    expect(
      screen
        .getAllByRole("option")
        .some((o) => o.getAttribute("data-value") === "__default__"),
    ).toBe(false);

    await userEvent.click(providerOption("openai"));
    // First OpenAI text model in catalog order is GPT-5.2.
    expect(onChange).toHaveBeenLastCalledWith("openai/gpt-5.2");
  });

  it("pre-selects the provider implied by a controlled model value", async () => {
    const ProviderModelPicker = await importPicker();
    render(<ProviderModelPicker value="openai/gpt-5.2" onChange={vi.fn()} />);

    // The model list is already scoped to OpenAI (derived from value's vendor).
    const modelSelects = screen.getAllByTestId("select");
    const modelSelect = modelSelects[modelSelects.length - 1]!;
    expect(within(modelSelect).getByText("GPT-5.2")).toBeInTheDocument();
    // No Anthropic model should be listed.
    expect(
      within(modelSelect).queryByText("Claude Opus 4.8"),
    ).not.toBeInTheDocument();
  });

  it("disables the model select until a provider is chosen", async () => {
    const ProviderModelPicker = await importPicker();
    render(<ProviderModelPicker value={null} onChange={vi.fn()} />);
    const selects = screen.getAllByTestId("select");
    const modelSelect = selects[selects.length - 1]!;
    expect(modelSelect).toHaveAttribute("data-disabled", "true");
  });

  // ── Provider capability posture badges (@oxagen/ai/posture) ────────────────
  //
  // Unlike model-picker.test.tsx, this file does not mock @oxagen/ai/catalog,
  // @oxagen/ai/posture, @/components/ui/badge, or @/components/ui/tooltip —
  // it exercises the real registry against the real catalog, same as it
  // already does for model names ("Claude Opus 4.8" etc). The badge styling
  // contract itself (requiresAction distinguishability, unknown-vendor
  // fallback) is proven once in model-picker.test.tsx, which owns
  // <PostureBadgeGroup>'s only other caller — these tests just prove the
  // wiring: picking a provider surfaces that vendor's real posture.
  it("shows no posture group before a provider is chosen", async () => {
    const ProviderModelPicker = await importPicker();
    render(<ProviderModelPicker value={null} onChange={vi.fn()} />);
    expect(
      screen.queryByRole("group", { name: /capability posture/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the chosen vendor's capability posture once a provider is picked", async () => {
    const ProviderModelPicker = await importPicker();
    render(<ProviderModelPicker value={null} onChange={vi.fn()} />);

    await userEvent.click(providerOption("anthropic"));

    const postureGroup = screen.getByRole("group", {
      name: /Anthropic capability posture/i,
    });
    // Anthropic's cache axis is the requiresAction row this registry exists
    // to guard (explicit opt-in cache) — it renders inline, unprompted.
    expect(within(postureGroup).getByText("Cache: opt-in")).toBeInTheDocument();
  });

  it("swaps posture content when the chosen provider changes", async () => {
    const ProviderModelPicker = await importPicker();
    render(<ProviderModelPicker value={null} onChange={vi.fn()} />);

    await userEvent.click(providerOption("anthropic"));
    expect(
      screen.getByRole("group", { name: /Anthropic capability posture/i }),
    ).toBeInTheDocument();

    await userEvent.click(providerOption("mistral"));

    const mistralPosture = screen.getByRole("group", {
      name: /Mistral capability posture/i,
    });
    // Mistral has no explicit cache control and fixed-off reasoning — its
    // one requiresAction axis is emulated structured output.
    expect(
      within(mistralPosture).getByText("Structured output: emulated"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: /^Anthropic capability posture/i }),
    ).not.toBeInTheDocument();
  });
});
