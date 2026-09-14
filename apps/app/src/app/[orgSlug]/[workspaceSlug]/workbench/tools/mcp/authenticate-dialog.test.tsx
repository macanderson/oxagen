// @vitest-environment jsdom
/**
 * authenticate-dialog.test.tsx — unit tests for AuthenticateDialog.
 *
 * The dialog is the post-install OAuth prompt: the install succeeded, but the
 * server is unusable until the user authenticates with the provider.
 *
 * Covers:
 *   - renders the "Authentication required" title
 *   - renders the "will not work until you authenticate" copy naming the server
 *   - renders an enabled "Authenticate with <title>" button (we deliberately do
 *     NOT click it — it navigates via window.location, which jsdom can't do)
 *   - clicking "Later" closes the dialog (onOpenChange(false))
 *   - renders nothing when open=false
 *
 * Uses the real @/components/ui/dialog + button (same convention as
 * marketplace-modal.test.tsx) so "Later" exercises the real DialogClose
 * close path, not a mock's.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  AuthenticateDialog,
  type AuthenticateDialogProps,
} from "./authenticate-dialog";

afterEach(cleanup);

function renderDialog(overrides: Partial<AuthenticateDialogProps> = {}) {
  const onOpenChange = vi.fn();
  const utils = render(
    <AuthenticateDialog
      open
      onOpenChange={onOpenChange}
      orgSlug="acme"
      workspaceSlug="main"
      orgListingId="listing-1"
      serverTitle="Stripe"
      {...overrides}
    />,
  );
  return { onOpenChange, ...utils };
}

describe("AuthenticateDialog", () => {
  it("renders the 'Authentication required' title", () => {
    renderDialog();
    expect(screen.getByTestId("mcp-authenticate-dialog")).toBeInTheDocument();
    expect(screen.getByText("Authentication required")).toBeInTheDocument();
  });

  it("explains the server will not work until authenticated, naming the server", () => {
    renderDialog();
    expect(
      screen.getByText(
        /Stripe was installed successfully, but it will not work until you authenticate with your Stripe credentials\./,
      ),
    ).toBeInTheDocument();
  });

  it("renders an enabled 'Authenticate with <title>' button", () => {
    renderDialog();
    const btn = screen.getByRole("button", {
      name: "Authenticate with Stripe",
    });
    expect(btn).toBeInTheDocument();
    expect(btn).toBeEnabled();
    expect(btn).toHaveAttribute("data-testid", "mcp-authenticate-now");
  });

  it("uses the given serverTitle throughout", () => {
    renderDialog({ serverTitle: "E2E OAuth Server" });
    expect(
      screen.getByRole("button", {
        name: "Authenticate with E2E OAuth Server",
      }),
    ).toBeInTheDocument();
  });

  it("clicking 'Later' closes the dialog via onOpenChange(false)", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog();

    await user.click(screen.getByTestId("mcp-authenticate-later"));

    expect(onOpenChange).toHaveBeenCalled();
    // Base UI may pass extra args (event details) — the contract we rely on is
    // the first arg: open=false.
    expect(onOpenChange.mock.calls.at(-1)?.[0]).toBe(false);
  });

  it("renders nothing when open=false", () => {
    renderDialog({ open: false });
    expect(
      screen.queryByTestId("mcp-authenticate-dialog"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Authentication required"),
    ).not.toBeInTheDocument();
  });
});
