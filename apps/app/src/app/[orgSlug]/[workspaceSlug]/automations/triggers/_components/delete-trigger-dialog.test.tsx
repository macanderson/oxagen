// @vitest-environment jsdom
/**
 * delete-trigger-dialog.test.tsx — unit tests for the destructive-action
 * confirm gate before soft-deleting an agent trigger. Mirrors
 * enable-confirm-dialog.test.tsx's shape/conventions.
 *
 * Dialog primitives are mocked to plain controlled elements — same
 * convention as trigger-form-dialog.test.tsx.
 *
 * Covers:
 *   - Renders nothing when closed.
 *   - Renders the trigger type + agent name in the warning copy when open.
 *   - Cancel calls onOpenChange(false) without calling onConfirm.
 *   - Confirm calls onConfirm and shows the pending label while in flight,
 *     then reverts once the confirm promise resolves.
 *   - While pending, the Dialog's own onOpenChange is swallowed.
 */
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";

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
        <button type="button" data-testid="dialog-dismiss" onClick={() => onOpenChange?.(false)}>
          dismiss
        </button>
        {children}
      </div>
    ) : null,
  DialogPopup: ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...rest}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { DeleteTriggerDialog } from "./delete-trigger-dialog";

afterEach(() => cleanup());

describe("DeleteTriggerDialog", () => {
  it("renders nothing when closed", () => {
    render(
      <DeleteTriggerDialog
        open={false}
        onOpenChange={vi.fn()}
        agentName="Agent One"
        triggerType="event"
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("renders the trigger type and agent name in the warning copy", () => {
    render(
      <DeleteTriggerDialog
        open={true}
        onOpenChange={vi.fn()}
        agentName="Agent One"
        triggerType="event"
        onConfirm={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText("event")).toBeTruthy();
    expect(screen.getByText("Agent One")).toBeTruthy();
    expect(screen.getByText(/soft-deletes the trigger/i)).toBeTruthy();
  });

  it("Cancel closes the dialog without calling onConfirm", () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <DeleteTriggerDialog
        open={true}
        onOpenChange={onOpenChange}
        agentName="Agent One"
        triggerType="event"
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
      <DeleteTriggerDialog
        open={true}
        onOpenChange={vi.fn()}
        agentName="Agent One"
        triggerType="event"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-delete-trigger"));
    expect(onConfirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("confirm-delete-trigger").textContent).toBe("Deleting…"),
    );

    await act(async () => {
      resolveConfirm();
    });
    await waitFor(() =>
      expect(screen.getByTestId("confirm-delete-trigger").textContent).toBe("Delete trigger"),
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
      <DeleteTriggerDialog
        open={true}
        onOpenChange={onOpenChange}
        agentName="Agent One"
        triggerType="event"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByTestId("confirm-delete-trigger"));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-delete-trigger").textContent).toBe("Deleting…"),
    );

    fireEvent.click(screen.getByTestId("dialog-dismiss"));
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => {
      resolveConfirm();
    });
  });
});
