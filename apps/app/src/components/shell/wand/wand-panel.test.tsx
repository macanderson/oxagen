// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as React from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/prod/ask",
}));

const mockPageCtx = {
  isWandOpen: false,
  closeWand: vi.fn(),
  fillableForm: null as null | unknown,
  entity: null as null | { summary: string },
  _setIsFilling: vi.fn(),
  _setFillResult: vi.fn(),
};

vi.mock("@/lib/page-context", () => ({
  usePageContext: () => mockPageCtx,
}));

vi.mock("@/lib/sidebar", () => ({
  resolveSidebarCtx: () => ({ orgSlug: "acme", workspaceSlug: "prod" }),
}));

vi.mock("@/app/[orgSlug]/shell-actions", () => ({
  wandSendAction: vi.fn(),
  wandResolveApprovalAction: vi.fn(),
  wandResolveConsentAction: vi.fn(),
  wandResolvePlanAction: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}>{children}</a>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    render: renderEl,
    "aria-label": ariaLabel,
    ...p
  }: {
    children?: React.ReactNode;
    render?: React.ReactElement;
    "aria-label"?: string;
    [k: string]: unknown;
  }) => {
    if (renderEl) {
      // Clone the render element (e.g. Link) injecting children and aria-label
      return React.cloneElement(
        renderEl as React.ReactElement<Record<string, unknown>>,
        { "aria-label": ariaLabel, children },
      );
    }
    return (
      <button aria-label={ariaLabel} {...(p as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children}</button>
    );
  },
}));

vi.mock("@/components/chat/chat-shell-client", () => ({
  ChatShellClient: () => <div data-testid="chat-shell" />,
}));

vi.mock("@/components/chat/chat-shell", () => ({}));
vi.mock("@/components/chat/message-bubble", () => ({}));
vi.mock("@/components/chat/message-composer", () => ({}));
vi.mock("@/lib/ask/fill-types", () => ({}));
vi.mock("@oxagen/ai/catalog", () => ({}));

vi.mock("lucide-react", () => ({
  ArrowUpRight: () => <span />,
  Wand2: () => <span />,
  Sparkles: () => <span />,
  X: () => <span />,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { WandPanel } from "./wand-panel";

const defaultProps = {
  orgSlug: "acme",
  availableWorkspaces: [{ slug: "prod", name: "Production", publicId: "ws_1" }],
  modelConfig: {} as Parameters<typeof WandPanel>[0]["modelConfig"],
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockPageCtx.isWandOpen = false;
  mockPageCtx.closeWand = vi.fn();
  mockPageCtx.fillableForm = null;
  mockPageCtx.entity = null;
  mockPageCtx._setIsFilling = vi.fn();
  mockPageCtx._setFillResult = vi.fn();
});

describe("WandPanel", () => {
  it("does NOT render the panel when isWandOpen=false", () => {
    mockPageCtx.isWandOpen = false;
    render(<WandPanel {...defaultProps} />);
    expect(document.getElementById("wand-panel")).toBeNull();
    expect(screen.queryByText("Oxagen AI")).toBeNull();
  });

  it("renders the floating #wand-panel with 'Oxagen AI' title when isWandOpen=true", () => {
    mockPageCtx.isWandOpen = true;
    render(<WandPanel {...defaultProps} />);
    // The panel root carries id="wand-panel" — the anchor wand-button's
    // aria-controls and the form-fill e2e specs both rely on.
    expect(document.getElementById("wand-panel")).not.toBeNull();
    expect(screen.getByText("Oxagen AI")).toBeDefined();
  });

  it("renders a Close button inside the panel", () => {
    mockPageCtx.isWandOpen = true;
    render(<WandPanel {...defaultProps} />);
    const panel = document.getElementById("wand-panel");
    expect(panel).not.toBeNull();
    const closeButton = screen.getByRole("button", { name: /close/i });
    expect(panel?.contains(closeButton)).toBe(true);
  });

  it("'Open in full chat' link href is correctly built", () => {
    mockPageCtx.isWandOpen = true;
    render(<WandPanel {...defaultProps} />);
    const link = screen.getByRole("link", { name: /open in full chat/i }) as HTMLAnchorElement;
    expect(link.href).toContain("/acme/prod/ask");
  });
});
