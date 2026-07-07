// @vitest-environment jsdom
/**
 * agent-selector.test.tsx
 *
 * Render + interaction tests for AgentSelector:
 *   - renders nothing when there are no agents (agent-less workspaces unaffected)
 *   - trigger shows "Default chat" (value null) or the selected agent's name
 *   - lists each agent with a code/chat badge + a "Default chat" option
 *   - onChange fires with the agentId (or null for "Default chat")
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { AgentOption } from "./agent-selector";

afterEach(cleanup);

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
    <button type={(type as "button" | "submit" | "reset") ?? "button"} onClick={onClick} className={className} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ render: renderProp, children }: { children?: React.ReactNode; render?: React.ReactElement }) => (
    <div data-testid="menu-trigger">
      {renderProp}
      {children}
    </div>
  ),
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div data-testid="menu-popup">{children}</div>,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <div role="menuitem" onClick={onClick}>{children}</div>
  ),
  MenuSeparator: () => <hr />,
  MenuGroupLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Bot: vi.fn(() => <span data-testid="icon-bot" />),
    Code2: vi.fn(() => <span data-testid="icon-code" />),
    Check: vi.fn(() => <span data-testid="icon-check" />),
    ChevronDown: vi.fn(() => <span data-testid="icon-chevron-down" />),
  };
});

const AGENTS: AgentOption[] = [
  { agentId: "agt_code", slug: "repo-fixer", name: "Repo Fixer", description: "fixes repos", agentType: "code", isCode: true },
  { agentId: "agt_chat", slug: "support", name: "Support Bot", description: null, agentType: "custom", isCode: false },
];

describe("AgentSelector", () => {
  it("renders nothing when there are no agents", async () => {
    const { AgentSelector } = await import("./agent-selector");
    const { container } = render(<AgentSelector agents={[]} value={null} onChange={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows 'Default chat' on the trigger when nothing is selected", async () => {
    const { AgentSelector } = await import("./agent-selector");
    render(<AgentSelector agents={AGENTS} value={null} onChange={vi.fn()} />);
    // "Default chat" appears on the trigger AND the default menu item.
    expect(screen.getAllByText("Default chat").length).toBeGreaterThan(0);
  });

  it("shows the selected agent's name on the trigger", async () => {
    const { AgentSelector } = await import("./agent-selector");
    render(<AgentSelector agents={AGENTS} value="agt_code" onChange={vi.fn()} />);
    expect(screen.getAllByText("Repo Fixer").length).toBeGreaterThan(0);
  });

  it("lists each agent with a code/chat badge", async () => {
    const { AgentSelector } = await import("./agent-selector");
    render(<AgentSelector agents={AGENTS} value={null} onChange={vi.fn()} />);
    expect(screen.getByText("Support Bot")).toBeInTheDocument();
    expect(screen.getByText("code")).toBeInTheDocument();
    expect(screen.getByText("chat")).toBeInTheDocument();
  });

  it("fires onChange with the agentId when an agent is picked", async () => {
    const onChange = vi.fn();
    const { AgentSelector } = await import("./agent-selector");
    render(<AgentSelector agents={AGENTS} value={null} onChange={onChange} />);
    fireEvent.click(screen.getByText("Repo Fixer"));
    expect(onChange).toHaveBeenCalledWith("agt_code");
  });

  it("fires onChange with null when 'Default chat' is picked", async () => {
    const onChange = vi.fn();
    const { AgentSelector } = await import("./agent-selector");
    render(<AgentSelector agents={AGENTS} value="agt_code" onChange={onChange} />);
    // The menu item (not the trigger label) is the clickable role=menuitem.
    const items = screen.getAllByText("Default chat");
    fireEvent.click(items[items.length - 1]!);
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
