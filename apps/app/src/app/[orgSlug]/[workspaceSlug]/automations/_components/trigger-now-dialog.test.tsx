// @vitest-environment jsdom
/**
 * trigger-now-dialog.test.tsx — unit tests for the on-demand trigger dialog's
 * JSON payload parsing and result rendering.
 *
 * Dialog primitives are mocked to plain controlled elements — same
 * convention as trigger-form-dialog.test.tsx and launch-workflow-dialog.
 * test.tsx.
 *
 * Covers:
 *   - Empty payload → onTrigger called with `undefined` (no parse attempted).
 *   - Valid JSON object payload → onTrigger called with the parsed object.
 *   - Invalid JSON → inline parse error, onTrigger never called.
 *   - Valid JSON that isn't an object (array / primitive) → inline "must be a
 *     JSON object" error, onTrigger never called.
 *   - A successful result renders the execution id + status.
 *   - A failed result renders the capability's own error message.
 *   - Closing while pending is a no-op; closing resets the form (result +
 *     payload text cleared) on the next open.
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

import { TriggerNowDialog } from "./trigger-now-dialog";

afterEach(() => cleanup());

function renderDialog(
  over: {
    onTrigger?: ReturnType<typeof vi.fn>;
    onOpenChange?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const onTrigger =
    over.onTrigger ??
    vi
      .fn()
      .mockResolvedValue({ ok: true, executionId: "aex_1", status: "running" });
  const onOpenChange = over.onOpenChange ?? vi.fn();
  render(
    <TriggerNowDialog
      open={true}
      onOpenChange={onOpenChange}
      automationName="Notify on high-value deal"
      onTrigger={onTrigger}
    />,
  );
  return { onTrigger, onOpenChange };
}

describe("TriggerNowDialog — payload parsing", () => {
  it("fires with undefined payload when the textarea is empty", async () => {
    const { onTrigger } = renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-trigger"));
    });
    await waitFor(() => expect(onTrigger).toHaveBeenCalledWith(undefined));
  });

  it("parses a valid JSON object and forwards it to onTrigger", async () => {
    const { onTrigger } = renderDialog();
    fireEvent.change(screen.getByTestId("trigger-payload"), {
      target: { value: '{ "reason": "manual test" }' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-trigger"));
    });
    await waitFor(() =>
      expect(onTrigger).toHaveBeenCalledWith({ reason: "manual test" }),
    );
  });

  it("shows a parse error for invalid JSON and never calls onTrigger", async () => {
    const { onTrigger } = renderDialog();
    fireEvent.change(screen.getByTestId("trigger-payload"), {
      target: { value: "{ not json" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-trigger"));
    });
    await waitFor(() => {
      expect(screen.getByText("Payload is not valid JSON.")).toBeTruthy();
    });
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("shows a 'must be an object' error for a JSON array and never calls onTrigger", async () => {
    const { onTrigger } = renderDialog();
    fireEvent.change(screen.getByTestId("trigger-payload"), {
      target: { value: "[1, 2, 3]" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-trigger"));
    });
    await waitFor(() => {
      expect(screen.getByText("Payload must be a JSON object.")).toBeTruthy();
    });
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("shows a 'must be an object' error for a JSON primitive and never calls onTrigger", async () => {
    const { onTrigger } = renderDialog();
    fireEvent.change(screen.getByTestId("trigger-payload"), {
      target: { value: "42" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-trigger"));
    });
    await waitFor(() => {
      expect(screen.getByText("Payload must be a JSON object.")).toBeTruthy();
    });
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("treats whitespace-only payload as empty (undefined, not a parse error)", async () => {
    const { onTrigger } = renderDialog();
    fireEvent.change(screen.getByTestId("trigger-payload"), {
      target: { value: "   " },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-trigger"));
    });
    await waitFor(() => expect(onTrigger).toHaveBeenCalledWith(undefined));
  });
});

describe("TriggerNowDialog — result rendering", () => {
  it("renders the execution id and status on success", async () => {
    renderDialog({
      onTrigger: vi.fn().mockResolvedValue({
        ok: true,
        executionId: "aex_42",
        status: "running",
      }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-trigger"));
    });
    await waitFor(() => {
      const result = screen.getByTestId("trigger-result");
      expect(result.textContent).toContain("aex_42");
      expect(result.textContent).toContain("running");
    });
  });

  it("renders the capability's own error message on failure", async () => {
    renderDialog({
      onTrigger: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "Automation is disabled." }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-trigger"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("trigger-result").textContent).toBe(
        "Automation is disabled.",
      );
    });
  });
});

describe("TriggerNowDialog — close behavior", () => {
  it("Close calls onOpenChange(false)", () => {
    const { onOpenChange } = renderDialog();
    fireEvent.click(screen.getByText("Close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismissing via the Dialog's own onOpenChange resets the form and forwards false", async () => {
    const { onOpenChange } = renderDialog({
      onTrigger: vi.fn().mockResolvedValue({
        ok: true,
        executionId: "aex_1",
        status: "running",
      }),
    });
    fireEvent.change(screen.getByTestId("trigger-payload"), {
      target: { value: '{ "a": 1 }' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("confirm-trigger"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("trigger-result")).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("dialog-dismiss"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("blocks dismissal via the Dialog's own onOpenChange while a trigger is pending", async () => {
    let resolveTrigger: (v: { ok: boolean }) => void = () => {};
    const { onOpenChange } = renderDialog({
      onTrigger: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveTrigger = resolve;
          }),
      ),
    });
    fireEvent.click(screen.getByTestId("confirm-trigger"));
    await waitFor(() =>
      expect(screen.getByTestId("confirm-trigger").textContent).toBe(
        "Triggering…",
      ),
    );

    fireEvent.click(screen.getByTestId("dialog-dismiss"));
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => {
      resolveTrigger({ ok: true });
    });
  });
});
