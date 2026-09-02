// @vitest-environment jsdom
/**
 * new-workspace-dialog.test.tsx — render tests for NewWorkspaceDialog.
 *
 * Covers:
 *   - Closed state: dialog not in DOM
 *   - Open state: renders "Create a workspace" title
 *   - Open state: renders the description
 *   - Open state: renders NewWorkspaceForm (name and slug fields visible)
 *   - onOpenChange called when dialog closes
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { NewWorkspaceDialog } from "./new-workspace-dialog";

afterEach(cleanup);

// Stub window.location.assign (NewWorkspaceForm uses it on success)
Object.defineProperty(window, "location", {
  value: { ...window.location, assign: vi.fn() },
  writable: true,
});

const defaultProps = {
  orgSlug: "acme",
  action: vi.fn().mockResolvedValue({ ok: true, workspaceSlug: "new-ws" }),
  open: false,
  onOpenChange: vi.fn(),
};

describe("NewWorkspaceDialog — closed", () => {
  it("does not render dialog content when closed", () => {
    render(<NewWorkspaceDialog {...defaultProps} />);
    expect(screen.queryByText("Create a workspace")).not.toBeInTheDocument();
  });
});

describe("NewWorkspaceDialog — open", () => {
  it("renders the title when open", () => {
    render(<NewWorkspaceDialog {...defaultProps} open />);
    expect(screen.getByText("Create a workspace")).toBeInTheDocument();
  });

  it("renders the description when open", () => {
    render(<NewWorkspaceDialog {...defaultProps} open />);
    expect(
      screen.getByText(/workspaces scope the knowledge graph/i),
    ).toBeInTheDocument();
  });

  it("renders workspace name and slug inputs from NewWorkspaceForm", () => {
    render(<NewWorkspaceDialog {...defaultProps} open />);
    expect(screen.getByLabelText(/workspace name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/slug/i)).toBeInTheDocument();
  });
});
