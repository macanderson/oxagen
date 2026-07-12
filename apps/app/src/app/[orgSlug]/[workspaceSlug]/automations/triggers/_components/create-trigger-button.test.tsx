// @vitest-environment jsdom
/**
 * create-trigger-button.test.tsx — unit test for the Triggers board header's
 * primary action. TriggerFormDialog is stubbed (its own validation/submit
 * logic is covered by trigger-form-dialog.test.tsx) — here we only prove the
 * button owns and forwards the dialog's open state + tenant slugs + agent
 * list, and that a created trigger refreshes the page.
 */
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("./trigger-form-dialog", () => ({
  TriggerFormDialog: ({
    open,
    orgSlug,
    workspaceSlug,
    agents,
    onCreated,
  }: {
    open: boolean;
    orgSlug: string;
    workspaceSlug: string;
    agents: { name: string }[];
    onCreated?: () => void;
  }) =>
    open ? (
      <div data-testid="trigger-form-dialog-stub">
        open for {orgSlug}/{workspaceSlug} with {agents.length} agents
        <button type="button" onClick={() => onCreated?.()} data-testid="simulate-created">
          simulate created
        </button>
      </div>
    ) : null,
}));

import { CreateTriggerButton } from "./create-trigger-button";

const AGENTS = [
  { agentId: "a1", publicId: "agt_1", name: "Agent One", agentType: "custom" },
  { agentId: "a2", publicId: "agt_2", name: "Agent Two", agentType: "custom" },
];

afterEach(() => cleanup());

describe("CreateTriggerButton", () => {
  it("renders the dialog closed initially", () => {
    render(<CreateTriggerButton orgSlug="acme" workspaceSlug="main" agents={AGENTS} />);
    expect(screen.queryByTestId("trigger-form-dialog-stub")).toBeNull();
  });

  it("clicking the button opens the dialog with the tenant slugs and agent list", () => {
    render(<CreateTriggerButton orgSlug="acme" workspaceSlug="main" agents={AGENTS} />);
    fireEvent.click(screen.getByTestId("new-trigger"));
    expect(screen.getByTestId("trigger-form-dialog-stub").textContent).toContain(
      "open for acme/main with 2 agents",
    );
  });

  it("onCreated refreshes the page", () => {
    render(<CreateTriggerButton orgSlug="acme" workspaceSlug="main" agents={AGENTS} />);
    fireEvent.click(screen.getByTestId("new-trigger"));
    fireEvent.click(screen.getByTestId("simulate-created"));
    expect(mockRefresh).toHaveBeenCalled();
  });
});
