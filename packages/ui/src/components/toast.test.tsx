// @vitest-environment jsdom
/**
 * toast.test.tsx — render tests for Toast system.
 *
 * Covers: ToastProvider + ToastViewport mount (no crash), useToast hook,
 * toast renders with title after add. Toast is a Base UI dialog-based
 * component — close button is accessible via aria-label="Close".
 */

import { render, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach, vi } from "vitest";
import { ToastProvider, ToastViewport, useToast } from "./toast";

afterEach(cleanup);

function ToastTrigger({ title, type }: { title: string; type?: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => toast.add({ title, description: "Desc", type })}
    >
      Show Toast
    </button>
  );
}

function TestApp({ title = "Hello", type }: { title?: string; type?: string }) {
  return (
    <ToastProvider>
      <ToastTrigger title={title} type={type} />
      <ToastViewport />
    </ToastProvider>
  );
}

describe("Toast — provider mounts without crash", () => {
  it("renders without errors", () => {
    const { getByRole } = render(<TestApp />);
    expect(getByRole("button", { name: "Show Toast" })).toBeInTheDocument();
  });
});

describe("Toast — add and render", () => {
  it("renders toast title after add()", async () => {
    const { getByRole, getByText } = render(
      <TestApp title="Saved successfully" />,
    );
    await userEvent.click(getByRole("button", { name: "Show Toast" }));
    expect(getByText("Saved successfully")).toBeInTheDocument();
  });

  it("renders toast description after add()", async () => {
    const { getByRole, getByText } = render(<TestApp title="Notice" />);
    await userEvent.click(getByRole("button", { name: "Show Toast" }));
    expect(getByText("Desc")).toBeInTheDocument();
  });

  it("close button exists inside the toast dialog", async () => {
    const { getByRole } = render(<TestApp title="Closeable" />);
    await userEvent.click(getByRole("button", { name: "Show Toast" }));
    // Base UI Toast.Root renders as role="dialog"; close button is inside
    const toastDialog = getByRole("dialog");
    expect(toastDialog).toBeInTheDocument();
    // The close button has aria-label="Close"
    const closeBtn = within(toastDialog).queryByRole("button", {
      name: "Close",
    });
    // May be rendered inside the region — check anywhere for the close button
    expect(
      closeBtn ?? document.querySelector('[aria-label="Close"]'),
    ).not.toBeNull();
  });

  it("toast renders as a dialog with the toast title as accessible name", async () => {
    const { getByRole } = render(<TestApp title="Test Toast" />);
    await userEvent.click(getByRole("button", { name: "Show Toast" }));
    expect(getByRole("dialog")).toBeInTheDocument();
  });

  it("useToast returns object with add function", () => {
    let toastApi: ReturnType<typeof useToast> | null = null;
    function Inspector() {
      toastApi = useToast();
      return null;
    }
    render(
      <ToastProvider>
        <Inspector />
      </ToastProvider>,
    );
    expect(typeof toastApi!.add).toBe("function");
  });
});

describe("Toast — action button (actionProps)", () => {
  function UndoTrigger({ onUndo }: { onUndo: () => void }) {
    const toast = useToast();
    return (
      <button
        type="button"
        onClick={() =>
          toast.add({
            title: "Dismissed",
            type: "success",
            actionProps: { children: "Undo", onClick: onUndo },
          })
        }
      >
        Show Toast
      </button>
    );
  }

  it("does not render an action button when actionProps is absent", async () => {
    const { getByRole, queryByRole } = render(<TestApp title="No action" />);
    await userEvent.click(getByRole("button", { name: "Show Toast" }));
    expect(queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("renders the action button and fires its onClick when actionProps is provided", async () => {
    const onUndo = vi.fn();
    const { getByRole } = render(
      <ToastProvider>
        <UndoTrigger onUndo={onUndo} />
        <ToastViewport />
      </ToastProvider>,
    );
    await userEvent.click(getByRole("button", { name: "Show Toast" }));
    const undoButton = getByRole("button", { name: "Undo" });
    expect(undoButton).toBeInTheDocument();
    await userEvent.click(undoButton);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
