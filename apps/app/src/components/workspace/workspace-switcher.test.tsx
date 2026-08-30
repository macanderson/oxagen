// @vitest-environment jsdom
/**
 * workspace-switcher.test.tsx — render tests for WorkspaceSwitcher.
 *
 * Covers:
 *   - Renders the current workspace name in the trigger
 *   - Without createWorkspaceAction: renders the trigger button
 *   - With createWorkspaceAction: renders without error
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { WorkspaceSwitcher } from "./workspace-switcher";

afterEach(cleanup);

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

// Mock NewWorkspaceDialog (heavy dialog dependency)
vi.mock("./new-workspace-dialog", () => ({
  NewWorkspaceDialog: () => <div data-testid="new-workspace-dialog" />,
}));

const current = { publicId: "ws-1", slug: "prod", name: "Production" };
const workspaces = [
  { publicId: "ws-1", slug: "prod", name: "Production" },
  { publicId: "ws-2", slug: "staging", name: "Staging" },
];

describe("WorkspaceSwitcher — rendering", () => {
  it("renders the current workspace name", () => {
    render(
      <WorkspaceSwitcher
        orgSlug="acme"
        current={current}
        workspaces={workspaces}
      />,
    );
    expect(screen.getByText("Production")).toBeInTheDocument();
  });

  it("renders a trigger button", () => {
    render(
      <WorkspaceSwitcher
        orgSlug="acme"
        current={current}
        workspaces={workspaces}
      />,
    );
    // Trigger is a button
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("renders with createWorkspaceAction without crashing", () => {
    const action = vi
      .fn()
      .mockResolvedValue({ ok: true, workspaceSlug: "new-ws" });
    render(
      <WorkspaceSwitcher
        orgSlug="acme"
        current={current}
        workspaces={workspaces}
        createWorkspaceAction={action}
      />,
    );
    expect(screen.getByText("Production")).toBeInTheDocument();
  });
});
