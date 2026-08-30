// @vitest-environment jsdom
/**
 * mcp-server-picker.test.tsx
 *
 * Unit tests for McpServerPicker:
 *   - Button renders, no badge when nothing active
 *   - Badge shows active count
 *   - Panel opens/closes on button click
 *   - Panel closes on click-outside
 *   - Server list rendered with name and health dot
 *   - Toggle switch activates / deactivates a server
 *   - "Activate all" / "Deactivate all" logic
 *   - Unreachable server switch is disabled
 *   - Tool count rendered when toolCount > 0
 *   - Empty-state message when servers=[]
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { McpServerSummary } from "./mcp-types";

// Controllable viewport: false = desktop (default, matches jsdom), true = phone.
const { mockViewport } = vi.hoisted(() => ({
  mockViewport: { isMobile: false },
}));
vi.mock("@/hooks/use-media-query", () => ({
  useIsMobile: () => mockViewport.isMobile,
  useMediaQuery: () => mockViewport.isMobile,
}));

afterEach(() => {
  cleanup();
  mockViewport.isMobile = false;
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// Sheet shim — renders children inline when open (real component portals a
// Base UI dialog; these tests assert the picker's own composition).
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="sheet-root">{children}</div> : null,
  SheetPopup: ({
    children,
    side,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    side?: string;
    "data-testid"?: string;
  }) => (
    <div role="dialog" data-testid={testId} data-side={side}>
      {children}
    </div>
  ),
  SheetHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetPanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  SheetDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    className,
    "aria-label": ariaLabel,
    "aria-expanded": ariaExpanded,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      className={className}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      {...rest}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
    id,
    "aria-label": ariaLabel,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    disabled?: boolean;
    id?: string;
    "aria-label"?: string;
  }) => (
    <button
      role="switch"
      id={id}
      aria-checked={checked ?? false}
      aria-label={ariaLabel}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
    />
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Server: vi.fn(() => <span data-testid="icon-server" />),
  };
});

function makeServer(overrides?: Partial<McpServerSummary>): McpServerSummary {
  return {
    publicId: "mcs_abc",
    name: "GitHub MCP",
    toolCount: 5,
    healthStatus: "healthy",
    ...overrides,
  };
}

const DEFAULT_SERVERS: McpServerSummary[] = [
  makeServer({ publicId: "mcs_1", name: "Server A" }),
  makeServer({ publicId: "mcs_2", name: "Server B" }),
];

describe("McpServerPicker — button", () => {
  it("renders the MCP servers button", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={[]}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "MCP servers" }),
    ).toBeInTheDocument();
  });

  it("shows no badge when no servers are active", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    const { container } = render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    // Badge is only present when activeCount > 0
    expect(container.querySelector(".bg-primary.rounded-full")).toBeNull();
  });

  it("shows active count badge when 1+ servers active", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set(["mcs_1"])}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "MCP servers — 1 active" }),
    ).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("badge count updates when 2 servers active", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set(["mcs_1", "mcs_2"])}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "MCP servers — 2 active" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});

describe("McpServerPicker — panel open/close", () => {
  it("panel is not visible initially", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens panel on button click", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes panel on second button click (toggle)", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: "MCP servers" });
    await userEvent.click(btn);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.click(btn);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes panel on click outside", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <div>
        <McpServerPicker
          servers={DEFAULT_SERVERS}
          activeServerIds={new Set()}
          onActiveServerIdsChange={vi.fn()}
        />
        <div data-testid="outside">Outside</div>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("McpServerPicker — server list", () => {
  it("shows empty-state when servers is empty", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={[]}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    expect(screen.getByText("No MCP servers installed.")).toBeInTheDocument();
  });

  it("renders server names in the list", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    expect(screen.getByText("Server A")).toBeInTheDocument();
    expect(screen.getByText("Server B")).toBeInTheDocument();
  });

  it("renders health dot for each server", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={[makeServer({ publicId: "mcs_1", healthStatus: "healthy" })]}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    expect(screen.getByLabelText("Health: healthy")).toBeInTheDocument();
  });

  it("renders degraded health dot", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={[makeServer({ publicId: "mcs_1", healthStatus: "degraded" })]}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    expect(screen.getByLabelText("Health: degraded")).toBeInTheDocument();
  });

  it("renders tool count when toolCount > 0", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={[makeServer({ publicId: "mcs_1", toolCount: 7 })]}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    expect(screen.getByText("7t")).toBeInTheDocument();
  });

  it("does not render tool count when toolCount is 0", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={[makeServer({ publicId: "mcs_1", toolCount: 0 })]}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    expect(screen.queryByText("0t")).toBeNull();
  });
});

describe("McpServerPicker — toggle switches", () => {
  it("activates a server when its switch is toggled on", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    const onChange = vi.fn();
    render(
      <McpServerPicker
        servers={[makeServer({ publicId: "mcs_1", name: "Server A" })]}
        activeServerIds={new Set()}
        onActiveServerIdsChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    await userEvent.click(
      screen.getByRole("switch", { name: "Activate Server A" }),
    );
    expect(onChange).toHaveBeenCalledOnce();
    const [newSet] = onChange.mock.calls[0] as [Set<string>];
    expect(newSet.has("mcs_1")).toBe(true);
  });

  it("deactivates an active server when its switch is toggled off", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    const onChange = vi.fn();
    render(
      <McpServerPicker
        servers={[makeServer({ publicId: "mcs_1", name: "Server A" })]}
        activeServerIds={new Set(["mcs_1"])}
        onActiveServerIdsChange={onChange}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "MCP servers — 1 active" }),
    );
    await userEvent.click(
      screen.getByRole("switch", { name: "Deactivate Server A" }),
    );
    expect(onChange).toHaveBeenCalledOnce();
    const [newSet] = onChange.mock.calls[0] as [Set<string>];
    expect(newSet.has("mcs_1")).toBe(false);
  });

  it("disables switch for unreachable server", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={[
          makeServer({
            publicId: "mcs_1",
            name: "Dead",
            healthStatus: "unreachable",
          }),
        ]}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    const sw = screen.getByRole("switch", { name: "Activate Dead" });
    expect(sw).toBeDisabled();
  });
});

describe("McpServerPicker — activate/deactivate all", () => {
  it("shows 'Activate all' when not all servers are active", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set(["mcs_1"])}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "MCP servers — 1 active" }),
    );
    expect(screen.getByText("Activate all")).toBeInTheDocument();
  });

  it("shows 'Deactivate all' when all servers are active", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set(["mcs_1", "mcs_2"])}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "MCP servers — 2 active" }),
    );
    expect(screen.getByText("Deactivate all")).toBeInTheDocument();
  });

  it("'Activate all' activates every server", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    const onChange = vi.fn();
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set()}
        onActiveServerIdsChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    await userEvent.click(screen.getByText("Activate all"));
    expect(onChange).toHaveBeenCalledOnce();
    const [newSet] = onChange.mock.calls[0] as [Set<string>];
    expect(newSet.has("mcs_1")).toBe(true);
    expect(newSet.has("mcs_2")).toBe(true);
  });

  it("'Deactivate all' clears all active servers", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    const onChange = vi.fn();
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set(["mcs_1", "mcs_2"])}
        onActiveServerIdsChange={onChange}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "MCP servers — 2 active" }),
    );
    await userEvent.click(screen.getByText("Deactivate all"));
    expect(onChange).toHaveBeenCalledOnce();
    const [newSet] = onChange.mock.calls[0] as [Set<string>];
    expect(newSet.size).toBe(0);
  });
});

describe("McpServerPicker — desktop panel viewport clamp", () => {
  it("clamps the anchored panel width to the viewport", async () => {
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    expect(screen.getByRole("dialog").className).toContain(
      "max-w-[calc(100vw-2rem)]",
    );
  });
});

describe("McpServerPicker — mobile bottom sheet", () => {
  it("opens a bottom sheet instead of the anchored panel on phones", async () => {
    mockViewport.isMobile = true;
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("mcp-server-picker-sheet")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    const sheet = screen.getByTestId("mcp-server-picker-sheet");
    expect(sheet).toHaveAttribute("data-side", "bottom");
    expect(screen.getByText("Server A")).toBeInTheDocument();
    expect(screen.getByText("Server B")).toBeInTheDocument();
  });

  it("renders ≥44px-tall server rows inside the sheet", async () => {
    mockViewport.isMobile = true;
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={[makeServer({ publicId: "mcs_1", name: "Server A" })]}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    const row = screen.getByText("Server A").closest("li")!;
    expect(row.className).toContain("min-h-11");
  });

  it("toggling a server inside the sheet reports the new active set", async () => {
    mockViewport.isMobile = true;
    const { McpServerPicker } = await import("./mcp-server-picker");
    const onChange = vi.fn();
    render(
      <McpServerPicker
        servers={[makeServer({ publicId: "mcs_1", name: "Server A" })]}
        activeServerIds={new Set()}
        onActiveServerIdsChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    await userEvent.click(
      screen.getByRole("switch", { name: "Activate Server A" }),
    );
    const [newSet] = onChange.mock.calls[0] as [Set<string>];
    expect(newSet.has("mcs_1")).toBe(true);
  });

  it("gives the trigger a 44px touch target on phones", async () => {
    mockViewport.isMobile = true;
    const { McpServerPicker } = await import("./mcp-server-picker");
    render(
      <McpServerPicker
        servers={DEFAULT_SERVERS}
        activeServerIds={new Set()}
        onActiveServerIdsChange={vi.fn()}
      />,
    );
    const btn = screen.getByRole("button", { name: "MCP servers" });
    expect(btn.className).toContain("h-11");
    expect(btn.className).toContain("w-11");
  });
});
