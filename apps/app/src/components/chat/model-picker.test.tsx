// @vitest-environment jsdom
/**
 * model-picker.test.tsx
 *
 * Render tests for ModelPicker:
 *   - Renders trigger button with current tier label
 *   - Renders "Oxagen Fast" label for default fast tier
 *   - Re-exports defaultModelState and buildSeededModelState
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

vi.mock("@oxagen/ai/catalog", () => ({
  gatewayModels: [],
  vendorLabels: { anthropic: "Anthropic", openai: "OpenAI" },
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
    <button type={type ?? "button"} onClick={onClick} className={className} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ render: renderProp }: { children?: React.ReactNode; render?: React.ReactElement }) =>
    renderProp ?? null,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div data-testid="menu-popup">{children}</div>,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <div role="menuitem" onClick={onClick}>{children}</div>
  ),
  MenuSeparator: () => <hr />,
  MenuGroupLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuSubTrigger: ({ render: renderProp }: { children?: React.ReactNode; render?: React.ReactElement }) =>
    renderProp ?? null,
  MenuSubPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  Check: () => <span data-testid="icon-check" />,
  ChevronDown: () => <span data-testid="icon-chevron-down" />,
}));

// modelConfig.text[tier] is expected to be a string model ID by the component
const DEFAULT_MODEL_CONFIG = {
  text: {
    fast: "claude-haiku-4-5",
    balanced: "claude-sonnet-4-5",
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
