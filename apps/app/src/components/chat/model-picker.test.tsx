// @vitest-environment jsdom
/**
 * model-picker.test.tsx
 *
 * Render tests for ModelPicker:
 *   - Renders trigger button with current tier label
 *   - Renders "Oxagen Fast" label for default fast tier
 *   - Re-exports defaultModelState and buildSeededModelState
 *   - Renders provider capability posture badges (@oxagen/ai/posture) per
 *     "Other models" row: requiresAction badges inline, distinguishable from
 *     passive ones, detail prose reachable, unknown vendor never fabricated
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import { cloneElement, isValidElement } from "react";

afterEach(cleanup);

vi.mock("@oxagen/ai/catalog", () => ({
  gatewayModels: [
    {
      id: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      vendor: "anthropic",
      released: "2026-01-01",
      context: "200K",
      capabilities: ["vision", "tools"],
    },
    {
      id: "mysteryvendor/mystery-model",
      name: "Mystery Model",
      vendor: "mysteryvendor",
      released: "2026-02-01",
      context: "128K",
      capabilities: ["tools"],
    },
  ],
  vendorLabels: {
    anthropic: "Anthropic",
    openai: "OpenAI",
    mysteryvendor: "Mystery Vendor",
  },
  getModel: () => undefined,
  supportsImage: () => false,
  supportsVideo: () => false,
  supportsText: () => true,
  capabilityLabel: (c: string) => c,
  formatReleaseDate: (d: string) => d,
  TEXT_TIERS: [
    { id: "fast", name: "Oxagen Fast", blurb: "Quick responses" },
    { id: "balanced", name: "Oxagen Balanced", blurb: "Best value" },
    { id: "precise", name: "Oxagen Precise", blurb: "Most capable" },
  ],
  MEDIA_TIERS: [
    { id: "basic", name: "Oxagen Basic", blurb: "Basic image" },
    { id: "standard", name: "Oxagen Standard", blurb: "Standard image" },
    { id: "premium", name: "Oxagen Premium", blurb: "Premium image" },
  ],
}));

// A minimal double for @oxagen/ai/posture: one known vendor (anthropic, with
// exactly one requiresAction axis) and one vendor the matrix has never seen
// (mysteryvendor), so postureForModel legitimately returns undefined for it —
// the real registry's completeness contract is exercised in
// packages/ai/src/provider-posture.test.ts, not here.
vi.mock("@oxagen/ai/posture", () => ({
  postureForModel: (modelId: string) =>
    modelId === "anthropic/claude-sonnet-5"
      ? { vendor: "anthropic" }
      : undefined,
  postureBadges: (posture: { vendor: string }) =>
    posture.vendor === "anthropic"
      ? [
          {
            axis: "cache",
            label: "Cache: opt-in",
            detail:
              "Anthropic requires an explicit cache breakpoint or nothing is cached.",
            requiresAction: true,
          },
          {
            axis: "reasoning",
            label: "Reasoning: controllable",
            detail: "Adaptive thinking driven by an effort tier.",
            requiresAction: false,
          },
          {
            axis: "structuredOutput",
            label: "Structured output: native",
            detail: "Schema-constrained decoding; the response always parses.",
            requiresAction: false,
          },
          {
            axis: "attachments",
            label: "Accepts: image",
            detail: "Image parts only — no native video or audio input.",
            requiresAction: false,
          },
        ]
      : [],
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    className,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      className={className}
      {...rest}
    >
      {children}
    </button>
  ),
}));

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

// Same idiom as prompt-cache-bar.test.tsx: render the trigger element AND its
// children, and render popup content unconditionally, so posture detail is
// assertable without simulating hover/focus timers.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    render: trigger,
    children,
  }: {
    render: React.ReactElement;
    children: React.ReactNode;
  }) => (isValidElement(trigger) ? cloneElement(trigger, {}, children) : null),
  TooltipPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({
    render: renderProp,
  }: {
    children?: React.ReactNode;
    render?: React.ReactElement;
  }) => renderProp ?? null,
  MenuPopup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="menu-popup">{children}</div>
  ),
  MenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <div role="menuitem" onClick={onClick}>
      {children}
    </div>
  ),
  MenuSeparator: () => <hr />,
  MenuGroupLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MenuSub: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  MenuSubTrigger: ({
    render: renderProp,
  }: {
    children?: React.ReactNode;
    render?: React.ReactElement;
  }) => renderProp ?? null,
  MenuSubPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Check: vi.fn(() => <span data-testid="icon-check" />),
    ChevronDown: vi.fn(() => <span data-testid="icon-chevron-down" />),
  };
});

// modelConfig.text[tier] is expected to be a string model ID by the component
const DEFAULT_MODEL_CONFIG = {
  text: {
    fast: "claude-haiku-4-5",
    balanced: "claude-sonnet-5",
    precise: "claude-opus-4-5",
  },
  image: {
    basic: "gpt-image-1",
    standard: "gpt-image-1",
    premium: "flux-2-max",
  },
  video: {
    basic: "veo-3.0-fast",
    standard: "veo-3.0",
    premium: "veo-3.0",
  },
} as unknown as import("@oxagen/ai/catalog").ResolvedTierCatalog;

describe("ModelPicker", () => {
  it("renders trigger button with Fast label when tier=fast", async () => {
    const { ModelPicker, defaultModelState } = await import("./model-picker");
    render(
      <ModelPicker
        value={defaultModelState}
        onChange={vi.fn()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    expect(screen.getByText("Oxagen Fast")).toBeInTheDocument();
  });

  it("renders trigger button with Balanced label when tier=balanced", async () => {
    const { ModelPicker, defaultModelState } = await import("./model-picker");
    render(
      <ModelPicker
        value={{ ...defaultModelState, tier: "balanced" }}
        onChange={vi.fn()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    expect(screen.getByText("Oxagen Balanced")).toBeInTheDocument();
  });

  it("re-exports defaultModelState with tier=fast", async () => {
    const { defaultModelState } = await import("./model-picker");
    expect(defaultModelState.tier).toBe("fast");
    expect(defaultModelState.generate).toBeNull();
  });

  it("re-exports buildSeededModelState", async () => {
    const { buildSeededModelState } = await import("./model-picker");
    const state = buildSeededModelState({
      textTier: "balanced",
      textModel: null,
      imageModel: null,
      videoModel: null,
    });
    expect(state.tier).toBe("balanced");
  });
});

/** First element of an RTL query-all result, narrowed for strict-mode TS
 * (Array#at/index access is `T | undefined` under noUncheckedIndexedAccess). */
function firstOf<T>(items: T[]): T {
  const [first] = items;
  if (first === undefined) {
    throw new Error("expected at least one matching element");
  }
  return first;
}

describe("ModelPicker — provider capability posture badges", () => {
  async function renderPicker() {
    const { ModelPicker, defaultModelState } = await import("./model-picker");
    render(
      <ModelPicker
        value={defaultModelState}
        onChange={vi.fn()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
  }

  it("renders posture badges for a known model", async () => {
    await renderPicker();
    // requiresAction axis (cache: opt-in) renders inline on the row.
    expect(screen.getAllByText("Cache: opt-in").length).toBeGreaterThan(0);
    // Passive axes are reachable too — the tooltip mock renders popup
    // content unconditionally, so the full four-axis breakdown is present.
    expect(screen.getByText("Reasoning: controllable")).toBeInTheDocument();
    expect(screen.getByText("Structured output: native")).toBeInTheDocument();
    expect(screen.getByText("Accepts: image")).toBeInTheDocument();
  });

  it("makes a requiresAction badge visually distinguishable from a passive one", async () => {
    await renderPicker();
    const actionChip = firstOf(screen.getAllByText("Cache: opt-in"));
    const passiveChip = screen.getByText("Reasoning: controllable");

    expect(actionChip.getAttribute("data-variant")).toBe("warning-soft");
    expect(passiveChip.getAttribute("data-variant")).toBe("muted");
    expect(actionChip.getAttribute("data-variant")).not.toBe(
      passiveChip.getAttribute("data-variant"),
    );

    // Not color alone: the requiresAction chip also carries a leading icon
    // (an svg sibling inside the same badge) that the passive chip lacks.
    expect(actionChip.querySelector("svg")).not.toBeNull();
    expect(passiveChip.querySelector("svg")).toBeNull();
  });

  it("exposes the posture detail prose, not just the badge label", async () => {
    await renderPicker();
    // Rendered as visible tooltip-popup prose...
    expect(
      screen.getByText(/Anthropic requires an explicit cache breakpoint/),
    ).toBeInTheDocument();
    // ...and reachable as a native title attribute on the badge itself.
    const actionChip = firstOf(screen.getAllByText("Cache: opt-in"));
    expect(actionChip.getAttribute("title")).toMatch(
      /explicit cache breakpoint/,
    );
  });

  it("renders an explicit unknown state for a vendor with no posture row, never a fabricated badge", async () => {
    await renderPicker();
    const mysteryRow = screen.getByText("Mystery Model").closest("button");
    expect(mysteryRow).not.toBeNull();
    const scoped = within(mysteryRow as HTMLElement);

    expect(scoped.getByText("Posture: unknown")).toBeInTheDocument();
    // No axis label — real or otherwise — is fabricated for this vendor.
    expect(scoped.queryByText(/^Cache:/)).toBeNull();
    expect(scoped.queryByText(/^Reasoning:/)).toBeNull();
    expect(scoped.queryByText(/^Structured output:/)).toBeNull();
    expect(scoped.queryByText(/^Accepts:/)).toBeNull();
  });
});
