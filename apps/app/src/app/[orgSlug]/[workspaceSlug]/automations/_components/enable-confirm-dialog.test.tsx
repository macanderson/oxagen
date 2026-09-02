// @vitest-environment jsdom
/**
 * enable-confirm-dialog.test.tsx — unit tests for the human activation gate.
 *
 * Dialog primitives are mocked to plain controlled elements — same
 * convention as trigger-form-dialog.test.tsx and launch-workflow-dialog.
 * test.tsx — so the test exercises real component state/callback logic
 * without depending on Base UI portals/floating-ui positioning in jsdom.
 *
 * Covers:
 *   - Renders nothing when closed.
 *   - Renders the automation name in the warning copy when open.
 *   - Cancel calls onOpenChange(false) without calling onConfirm.
 *   - Confirm calls onConfirm and shows the pending label while in flight,
 *     then reverts once the confirm promise resolves.
 *   - While pending, the Dialog's own onOpenChange is swallowed (can't be
 *     dismissed mid-confirm).
 */
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";

// Dialog primitives → plain divs (skip Base UI portals/animation in jsdom).
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (next: boolean) => void;
  }) =>
    open ? (
      <div data-testid="dialog">
        <button
          type="button"
          data-testid="dialog-dismiss"
          onClick={() => onOpenChange?.(false)}
        >
          dismiss
        </button>
        {children}
      </div>
    ) : null,
  DialogPopup: ({
    children,
    ...rest
  }: React.HTMLAttributes<HTMLDivElement>) => <div {...rest}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { EnableConfirmDialog } from "./enable-confirm-dialog";

afterEach(() => cleanup());

describe("EnableConfirmDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <EnableConfirmDialog
        open={false}
        onOpenChange={vi.fn()}
        automationName="Alpha"
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("renders the automation name in the confirmation copy", () => {
    render(
      <EnableConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        automationName="Notify on high-value deal"
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText("Notify on high-value deal")).toBeTruthy();
    expect(
      screen.getByText(/Enabling is a deliberate human action/i),
    ).toBeTruthy();
  });

  it("Cancel closes the dialog without calling onConfirm", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <EnableConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        automationName="Alpha"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Confirm calls onConfirm and shows the pending label while in flight, then reverts", async () => {
    let resolveConfirm: () => void = () => {};
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    render(
      <EnableConfirmDialog
        open={true}
        onOpenChange={vi.fn()}
        automationName="Alpha"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-enable"));
    expect(onConfirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("confirm-enable").textContent).toBe(
        "Enabling…",
      ),
    );

    await act(async () => {
      resolveConfirm();
    });
    await waitFor(() =>
      expect(screen.getByTestId("confirm-enable").textContent).toBe(
        "Enable automation",
      ),
    );
  });

  it("swallows onOpenChange while pending (dialog can't be dismissed mid-confirm)", async () => {
    let resolveConfirm: () => void = () => {};
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        }),
    );
    render(
      <EnableConfirmDialog
        open={true}
        onOpenChange={onOpenChange}
        automationName="Alpha"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-enable"));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-enable").textContent).toBe(
        "Enabling…",
      ),
    );

    fireEvent.click(screen.getByTestId("dialog-dismiss"));
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => {
      resolveConfirm();
    });
  });
});
