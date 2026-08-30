// @vitest-environment jsdom
/**
 * new-automation-button.test.tsx — unit test for the list-header primary
 * action's open-state wiring. NewAutomationDialog is stubbed (its own
 * validation/submit logic is covered by new-automation-dialog.test.tsx) — here
 * we only prove the button owns and forwards the dialog's open state and the
 * tenant slugs.
 */
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("./new-automation-dialog", () => ({
  NewAutomationDialog: ({
    open,
    orgSlug,
    workspaceSlug,
  }: {
    open: boolean;
    orgSlug: string;
    workspaceSlug: string;
  }) =>
    open ? (
      <div data-testid="new-automation-dialog-stub">
        open for {orgSlug}/{workspaceSlug}
      </div>
    ) : null,
}));

import { NewAutomationButton } from "./new-automation-button";

afterEach(() => cleanup());

describe("NewAutomationButton", () => {
  it("renders the dialog closed initially", () => {
    render(<NewAutomationButton orgSlug="acme" workspaceSlug="main" />);
    expect(screen.queryByTestId("new-automation-dialog-stub")).toBeNull();
  });

  it("clicking the button opens the dialog with the tenant slugs", () => {
    render(<NewAutomationButton orgSlug="acme" workspaceSlug="main" />);
    fireEvent.click(screen.getByTestId("new-automation"));
    expect(screen.getByTestId("new-automation-dialog-stub").textContent).toBe(
      "open for acme/main",
    );
  });
});
