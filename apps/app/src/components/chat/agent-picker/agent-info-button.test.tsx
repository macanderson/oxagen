// @vitest-environment jsdom
/**
 * agent-info-button.test.tsx — the "About {name}" affordance: desktop opens a
 * Popover, phone-width opens the shared Sheet chrome; both show the full
 * description + skill list and a "Chat with {name}" CTA that applies the
 * selection. Popover/Sheet are mocked to render inline (same convention as
 * session-settings.test.tsx / chat-shell-client.test.tsx) so content is
 * assertable without a real Base UI portal.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AgentInfoButton } from "./agent-info-button";
import type { AgentOption } from "./agent-picker-types";

const { mockIsMobile } = vi.hoisted(() => ({ mockIsMobile: { value: false } }));
vi.mock("@/hooks/use-media-query", () => ({
  useIsMobile: () => mockIsMobile.value,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({
    render,
    children,
  }: {
    render: React.ReactElement;
    children?: React.ReactNode;
  }) => React.cloneElement(render, undefined, children),
  PopoverPopup: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div role="dialog" aria-label="Agent info" className={className}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="sheet-root">{children}</div> : null,
  SheetPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

afterEach(() => {
  cleanup();
  mockIsMobile.value = false;
});

const CODER: AgentOption = {
  agentId: "agt_code",
  slug: "coder",
  name: "Coder",
  description: "Writes and reviews production code end to end.",
  agentType: "code",
  isCode: true,
  avatarUrl: null,
  summary: "Short summary",
  managed: false,
  toolRefs: [
    { type: "skill", ref: "skills/code-review" },
    { type: "skill", ref: "skills/write-tests" },
  ],
};

describe("AgentInfoButton — desktop (Popover)", () => {
  it("renders the info affordance with an accessible label", () => {
    render(<AgentInfoButton agent={CODER} onChat={vi.fn()} />);
    expect(screen.getByRole("button", { name: "About Coder" })).toBeInTheDocument();
  });

  it("opens the popover with the full description and skill list", () => {
    render(<AgentInfoButton agent={CODER} onChat={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "About Coder" }));
    expect(
      screen.getByText("Writes and reviews production code end to end."),
    ).toBeInTheDocument();
    expect(screen.getByText("Code Review")).toBeInTheDocument();
    expect(screen.getByText("Write Tests")).toBeInTheDocument();
  });

  it("the CTA applies the selection via onChat", () => {
    const onChat = vi.fn();
    render(<AgentInfoButton agent={CODER} onChat={onChat} />);
    fireEvent.click(screen.getByRole("button", { name: "About Coder" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat with Coder" }));
    expect(onChat).toHaveBeenCalledTimes(1);
  });

  it("falls back to the summary when there is no full description", () => {
    const NO_DESC: AgentOption = { ...CODER, description: null };
    render(<AgentInfoButton agent={NO_DESC} onChat={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "About Coder" }));
    expect(screen.getByText("Short summary")).toBeInTheDocument();
  });
});

describe("AgentInfoButton — mobile (Sheet)", () => {
  it("opens the sheet with the full description and CTA", () => {
    mockIsMobile.value = true;
    render(<AgentInfoButton agent={CODER} onChat={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "About Coder" }));
    expect(screen.getByTestId("sheet-root")).toBeInTheDocument();
    expect(
      screen.getByText("Writes and reviews production code end to end."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chat with Coder" })).toBeInTheDocument();
  });

  it("the CTA applies the selection via onChat", () => {
    mockIsMobile.value = true;
    const onChat = vi.fn();
    render(<AgentInfoButton agent={CODER} onChat={onChat} />);
    fireEvent.click(screen.getByRole("button", { name: "About Coder" }));
    fireEvent.click(screen.getByRole("button", { name: "Chat with Coder" }));
    expect(onChat).toHaveBeenCalledTimes(1);
  });
});
