// @vitest-environment jsdom
/**
 * agent-gallery.test.tsx — the empty-state hero wrapper around the picker panel.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AgentGallery } from "./agent-gallery";
import type { AgentOption } from "./agent-picker-types";

vi.mock("./agent-picker-panel", () => ({
  AgentPickerPanel: (props: { variant: string; agents: AgentOption[] }) => (
    <div
      data-testid="picker-panel"
      data-variant={props.variant}
      data-count={props.agents.length}
    />
  ),
}));

afterEach(cleanup);

const CHATTER: AgentOption = {
  agentId: "agt_chat",
  slug: "chatter",
  name: "Chatter",
  description: null,
  agentType: "custom",
  isCode: false,
  avatarUrl: null,
  summary: null,
  managed: false,
  toolRefs: [],
};

describe("AgentGallery", () => {
  it("renders the hero heading and the gallery-variant panel", () => {
    render(
      <AgentGallery
        agents={[CHATTER]}
        repos={[]}
        environments={[]}
        defaultRepoKey={null}
        defaultEnvId={null}
        defaultAgentId={null}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Choose your assistant" }),
    ).toBeInTheDocument();
    const panel = screen.getByTestId("picker-panel");
    expect(panel).toHaveAttribute("data-variant", "gallery");
    expect(panel).toHaveAttribute("data-count", "1");
  });

  it("renders nothing when the workspace has no agents", () => {
    const { container } = render(
      <AgentGallery
        agents={[]}
        repos={[]}
        environments={[]}
        defaultRepoKey={null}
        defaultEnvId={null}
        defaultAgentId={null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
