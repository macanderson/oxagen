// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="sheet">{children}</div> : null,
  SheetPopup: ({ children, ...rest }: { children: React.ReactNode; [k: string]: unknown }) => (
    <div>{children}</div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
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
  it("does NOT render sheet when isWandOpen=false", () => {
    mockPageCtx.isWandOpen = false;
    render(<WandPanel {...defaultProps} />);
    expect(screen.queryByTestId("sheet")).toBeNull();
  });

  it("renders 'Oxagen AI' title when isWandOpen=true", async () => {
    mockPageCtx.isWandOpen = true;
    render(<WandPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("sheet")).toBeDefined();
    });
    expect(screen.getByText("Oxagen AI")).toBeDefined();
  });

  it("'Open in full chat' link href is correctly built", async () => {
    mockPageCtx.isWandOpen = true;
    render(<WandPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTestId("sheet")).toBeDefined();
    });
    const link = screen.getByRole("link", { name: /open in full chat/i }) as HTMLAnchorElement;
    expect(link.href).toContain("/acme/prod/ask");
  });
});
