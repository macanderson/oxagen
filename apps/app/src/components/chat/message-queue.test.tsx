// @vitest-environment jsdom
/**
 * message-queue.test.tsx
 *
 * Unit tests for the MessageQueue panel:
 *   - Renders nothing when empty
 *   - Renders an ordered list with position badges + content
 *   - Header pluralisation + streaming vs draining copy
 *   - Remove fires onRemove with the item id
 *   - Reorder up/down fire onReorder with index + direction; ends are disabled
 *   - Send-now fires onSendNow with the item id
 *   - Inline edit: pencil/content-button opens editor, Enter commits via onEdit,
 *     Escape cancels, empty edit removes, Shift+Enter does NOT commit
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueuedItem } from "./message-queue";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    disabled,
    "aria-label": ariaLabel,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      {...rest}
    >
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", () => ({
  ArrowUp: () => <span data-testid="icon-up" />,
  ArrowDown: () => <span data-testid="icon-down" />,
  Check: () => <span data-testid="icon-check" />,
  ListOrdered: () => <span data-testid="icon-list" />,
  Pencil: () => <span data-testid="icon-pencil" />,
  Send: () => <span data-testid="icon-send" />,
  X: () => <span data-testid="icon-x" />,
}));

const ITEMS: QueuedItem[] = [
  { id: "q-1", content: "first message" },
  { id: "q-2", content: "second message" },
  { id: "q-3", content: "third message" },
];

function makeHandlers() {
  return {
    onRemove: vi.fn(),
    onReorder: vi.fn(),
    onEdit: vi.fn(),
    onSendNow: vi.fn(),
  };
}

async function renderQueue(
  items: QueuedItem[] = ITEMS,
  isStreaming = true,
  handlers = makeHandlers(),
) {
  const { MessageQueue } = await import("./message-queue");
  render(
    <MessageQueue items={items} isStreaming={isStreaming} {...handlers} />,
  );
  return handlers;
}

describe("MessageQueue — rendering", () => {
  it("renders nothing when items is empty", async () => {
    const { MessageQueue } = await import("./message-queue");
    const { container } = render(
      <MessageQueue
        items={[]}
        isStreaming
        onRemove={vi.fn()}
        onReorder={vi.fn()}
        onEdit={vi.fn()}
        onSendNow={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders each queued item's content", async () => {
    await renderQueue();
    expect(screen.getByText("first message")).toBeInTheDocument();
    expect(screen.getByText("second message")).toBeInTheDocument();
    expect(screen.getByText("third message")).toBeInTheDocument();
  });

  it("renders an ordered list with one li per item", async () => {
    await renderQueue();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("pluralises the header count for multiple items", async () => {
    await renderQueue();
    expect(screen.getByText("3 messages queued")).toBeInTheDocument();
  });

  it("uses the singular header for a single item", async () => {
    await renderQueue([{ id: "q-1", content: "solo" }]);
    expect(screen.getByText("1 message queued")).toBeInTheDocument();
  });

  it("shows streaming copy when isStreaming is true", async () => {
    await renderQueue(ITEMS, true);
    expect(
      screen.getByText("Sends when this turn finishes"),
    ).toBeInTheDocument();
  });

  it("shows draining copy when isStreaming is false", async () => {
    await renderQueue(ITEMS, false);
    expect(screen.getByText("Draining…")).toBeInTheDocument();
  });
});

describe("MessageQueue — remove", () => {
  it("fires onRemove with the item id", async () => {
    const handlers = await renderQueue();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove queued message 2" }),
    );
    expect(handlers.onRemove).toHaveBeenCalledWith("q-2");
  });
});

describe("MessageQueue — reorder", () => {
  it("fires onReorder up with index + direction", async () => {
    const handlers = await renderQueue();
    await userEvent.click(
      screen.getByRole("button", { name: "Move queued message 2 up" }),
    );
    expect(handlers.onReorder).toHaveBeenCalledWith(1, "up");
  });

  it("fires onReorder down with index + direction", async () => {
    const handlers = await renderQueue();
    await userEvent.click(
      screen.getByRole("button", { name: "Move queued message 2 down" }),
    );
    expect(handlers.onReorder).toHaveBeenCalledWith(1, "down");
  });

  it("disables move-up on the first item", async () => {
    await renderQueue();
    expect(
      screen.getByRole("button", { name: "Move queued message 1 up" }),
    ).toBeDisabled();
  });

  it("disables move-down on the last item", async () => {
    await renderQueue();
    expect(
      screen.getByRole("button", { name: "Move queued message 3 down" }),
    ).toBeDisabled();
  });
});

describe("MessageQueue — send now", () => {
  it("fires onSendNow with the item id", async () => {
    const handlers = await renderQueue();
    await userEvent.click(
      screen.getByRole("button", { name: "Send queued message 1 now" }),
    );
    expect(handlers.onSendNow).toHaveBeenCalledWith("q-1");
  });
});

describe("MessageQueue — inline edit", () => {
  it("opens the editor when the pencil is clicked", async () => {
    await renderQueue();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    expect(
      screen.getByRole("textbox", { name: "Edit queued message 1" }),
    ).toBeInTheDocument();
  });

  it("opens the editor when the content button is clicked", async () => {
    await renderQueue();
    await userEvent.click(
      screen.getByRole("button", {
        name: /Edit queued message 1: first message/,
      }),
    );
    expect(
      screen.getByRole("textbox", { name: "Edit queued message 1" }),
    ).toBeInTheDocument();
  });

  it("commits an edit on Enter via onEdit with trimmed content", async () => {
    const handlers = await renderQueue();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    const ta = screen.getByRole("textbox", { name: "Edit queued message 1" });
    await userEvent.clear(ta);
    await userEvent.type(ta, "  edited content  ");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(handlers.onEdit).toHaveBeenCalledWith("q-1", "edited content");
  });

  it("Shift+Enter does NOT commit the edit", async () => {
    const handlers = await renderQueue();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    const ta = screen.getByRole("textbox", { name: "Edit queued message 1" });
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(handlers.onEdit).not.toHaveBeenCalled();
  });

  it("commits an edit via the save button", async () => {
    const handlers = await renderQueue();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    const ta = screen.getByRole("textbox", { name: "Edit queued message 1" });
    await userEvent.clear(ta);
    await userEvent.type(ta, "saved via button");
    await userEvent.click(
      screen.getByRole("button", { name: "Save queued message 1" }),
    );
    expect(handlers.onEdit).toHaveBeenCalledWith("q-1", "saved via button");
  });

  it("Escape cancels the edit without firing onEdit", async () => {
    const handlers = await renderQueue();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    const ta = screen.getByRole("textbox", { name: "Edit queued message 1" });
    await userEvent.type(ta, "extra");
    fireEvent.keyDown(ta, { key: "Escape" });
    expect(handlers.onEdit).not.toHaveBeenCalled();
    // Editor closed → content button is back.
    expect(
      screen.getByRole("button", {
        name: /Edit queued message 1: first message/,
      }),
    ).toBeInTheDocument();
  });

  it("cancels the edit via the cancel button", async () => {
    const handlers = await renderQueue();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel editing queued message 1" }),
    );
    expect(handlers.onEdit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: /Edit queued message 1: first message/,
      }),
    ).toBeInTheDocument();
  });

  it("removes the item when the edit is committed empty", async () => {
    const handlers = await renderQueue();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    const ta = screen.getByRole("textbox", { name: "Edit queued message 1" });
    await userEvent.clear(ta);
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(handlers.onRemove).toHaveBeenCalledWith("q-1");
    expect(handlers.onEdit).not.toHaveBeenCalled();
  });

  it("commits the edit on blur", async () => {
    const handlers = await renderQueue();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    const ta = screen.getByRole("textbox", { name: "Edit queued message 1" });
    await userEvent.clear(ta);
    await userEvent.type(ta, "blurred edit");
    fireEvent.blur(ta);
    expect(handlers.onEdit).toHaveBeenCalledWith("q-1", "blurred edit");
  });
});
