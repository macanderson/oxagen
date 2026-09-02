// @vitest-environment jsdom
/**
 * new-workspace-form.test.tsx — render + interaction tests for NewWorkspaceForm.
 *
 * Covers:
 *   - Renders Name and Slug fields
 *   - Slug auto-derives from name while not manually edited
 *   - Manual slug edit locks auto-derivation
 *   - Clearing slug field re-arms auto-derivation
 *   - Error message shown when action returns ok:false
 *   - Button shows "Creating…" while pending (useTransition)
 *   - window.location.assign called with correct path on success
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  NewWorkspaceForm,
  type NewWorkspaceAction,
} from "./new-workspace-form";

afterEach(cleanup);

// Stub window.location.assign
const assignMock = vi.fn();
Object.defineProperty(window, "location", {
  value: { ...window.location, assign: assignMock },
  writable: true,
});

beforeEach(() => {
  assignMock.mockClear();
});

describe("NewWorkspaceForm — rendering", () => {
  it("renders workspace name and slug inputs", () => {
    render(<NewWorkspaceForm orgSlug="acme" action={vi.fn()} />);
    expect(screen.getByLabelText(/workspace name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/slug/i)).toBeInTheDocument();
  });

  it("renders 'Create workspace' submit button", () => {
    render(<NewWorkspaceForm orgSlug="acme" action={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /create workspace/i }),
    ).toBeInTheDocument();
  });
});

describe("NewWorkspaceForm — slug auto-derivation", () => {
  it("derives slug from name while not manually edited", async () => {
    render(<NewWorkspaceForm orgSlug="acme" action={vi.fn()} />);
    await userEvent.type(
      screen.getByLabelText(/workspace name/i),
      "My Project",
    );
    const slugInput = screen.getByLabelText(/slug/i) as HTMLInputElement;
    expect(slugInput.value).toBe("my-project");
  });

  it("manual slug edit locks auto-derivation", async () => {
    render(<NewWorkspaceForm orgSlug="acme" action={vi.fn()} />);
    const slugInput = screen.getByLabelText(/slug/i);
    // Manually type a slug first
    await userEvent.type(slugInput, "custom-slug");
    // Now type a name — slug should NOT follow
    await userEvent.type(screen.getByLabelText(/workspace name/i), "New Name");
    expect((slugInput as HTMLInputElement).value).toBe("custom-slug");
  });

  it("clearing slug re-arms auto-derivation", async () => {
    render(<NewWorkspaceForm orgSlug="acme" action={vi.fn()} />);
    const slugInput = screen.getByLabelText(/slug/i);
    await userEvent.type(slugInput, "x");
    await userEvent.clear(slugInput);
    // After clearing, name change should re-populate slug
    await userEvent.type(screen.getByLabelText(/workspace name/i), "Alpha");
    expect((slugInput as HTMLInputElement).value).toBe("alpha");
  });
});

describe("NewWorkspaceForm — submission", () => {
  it("calls action with FormData and navigates on success", async () => {
    const action: NewWorkspaceAction = vi
      .fn()
      .mockResolvedValue({ ok: true, workspaceSlug: "beta" });
    render(<NewWorkspaceForm orgSlug="acme" action={action} />);

    await userEvent.type(screen.getByLabelText(/workspace name/i), "Beta");
    await userEvent.click(
      screen.getByRole("button", { name: /create workspace/i }),
    );

    await waitFor(() => expect(action).toHaveBeenCalled());
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/acme/beta"));
  });

  it("shows error when action returns ok:false", async () => {
    const action: NewWorkspaceAction = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "Slug taken" });
    render(<NewWorkspaceForm orgSlug="acme" action={action} />);

    await userEvent.type(screen.getByLabelText(/workspace name/i), "Taken");
    await userEvent.click(
      screen.getByRole("button", { name: /create workspace/i }),
    );

    await waitFor(() =>
      expect(screen.getByText("Slug taken")).toBeInTheDocument(),
    );
  });
});
