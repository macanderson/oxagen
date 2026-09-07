// @vitest-environment jsdom
/**
 * agent-context-chip.test.tsx — the composer chip's trigger states and its
 * popover wiring to the picker panel.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentContextChip } from "./agent-context-chip";
import type { AgentOption } from "./agent-picker-types";

// Stub the panel so opening the popover is observable without a real portal.
vi.mock("./agent-picker-panel", () => ({
  AgentPickerPanel: (props: {
    selectedAgentId: string | null;
    variant: string;
  }) => (
    <div
      data-testid="picker-panel"
      data-variant={props.variant}
      data-selected={props.selectedAgentId ?? ""}
    />
  ),
}));

vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    ...rest
  }: {
    src: string;
    alt: string;
    [key: string]: unknown;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element -- jsdom shim
    <img src={src} alt={alt} {...rest} />
  ),
}));

afterEach(cleanup);

const CODER: AgentOption = {
  agentId: "agt_code",
  slug: "coder",
  name: "Coder",
  description: null,
  agentType: "code",
  avatarUrl: null,
  summary: null,
  managed: false,
  toolRefs: [],
};

function renderChip(
  overrides: Partial<React.ComponentProps<typeof AgentContextChip>> = {},
) {
  render(
    <AgentContextChip
      agents={[CODER]}
      defaultAgentId={null}
      selectedAgentId={null}
      onApply={vi.fn()}
      {...overrides}
    />,
  );
}

describe("AgentContextChip", () => {
  it("renders nothing when the workspace has no agents", () => {
    const { container } = render(
      <AgentContextChip
        agents={[]}
        defaultAgentId={null}
        selectedAgentId={null}
        onApply={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the ghost 'Assistant' state when nothing is selected", () => {
    renderChip();
    expect(
      screen.getByRole("button", { name: "Agent: Assistant" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: /avatar/ }),
    ).not.toBeInTheDocument();
  });

  it("shows the selected agent's name and avatar", () => {
    renderChip({ selectedAgentId: "agt_code" });
    expect(
      screen.getByRole("button", { name: "Agent: Coder" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Coder avatar" }),
    ).toBeInTheDocument();
  });

  it("opens the picker panel on click, forwarding the current selection", async () => {
    renderChip({ selectedAgentId: "agt_code" });
    await userEvent.click(screen.getByRole("button", { name: "Agent: Coder" }));
    const panel = await screen.findByTestId("picker-panel");
    expect(panel).toHaveAttribute("data-variant", "popover");
    expect(panel).toHaveAttribute("data-selected", "agt_code");
  });

  // REGRESSION (e2e chat-agent-picker): there is no read-only variant. The
  // chip's accessible name is ALWAYS "Agent: <name>" — never "Agent locked:
  // <name>" — so the picker (and the workspace "default assistant" star it
  // hosts) stays reachable after a turn has been sent. ADR-041 removed the
  // durable code binding that a conversation-scoped lock protected.
  it("stays openable after a turn: no locked variant, name never changes", async () => {
    renderChip({ selectedAgentId: "agt_code" });
    expect(screen.queryByTestId("agent-context-chip-locked")).toBeNull();
    const chip = screen.getByRole("button", { name: "Agent: Coder" });
    expect(chip).not.toBeDisabled();
    await userEvent.click(chip);
    expect(await screen.findByTestId("picker-panel")).toBeInTheDocument();
  });
});
