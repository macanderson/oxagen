// @vitest-environment jsdom
/**
 * message-tree.test.tsx
 *
 * Render tests for MessageTree:
 *   - Renders all messages in order
 *   - Renders empty list without crashing
 *   - Passes callbacks to MessageBubble
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);

vi.mock("motion/react", () => ({
  motion: {
    div: ({
      children,
      layout: _layout,
      initial: _initial,
      animate: _animate,
      variants: _variants,
      className,
      ...rest
    }: React.HTMLAttributes<HTMLDivElement> & {
      layout?: unknown;
      initial?: unknown;
      animate?: unknown;
      variants?: unknown;
    }) => (
      <div className={className} {...rest}>
        {children}
      </div>
    ),
  },
}));

vi.mock("@oxagen/ui/lib/motion", () => ({
  fadeInUp: { hidden: { opacity: 0 }, visible: { opacity: 1 } },
}));

vi.mock("./message-bubble", () => ({
  MessageBubble: ({
    message,
    callbacks: _callbacks,
  }: {
    message: { publicId: string; role: string; content: string };
    callbacks?: unknown;
  }) => (
    <div data-testid={`message-${message.publicId}`} data-role={message.role}>
      {message.content}
    </div>
  ),
}));

describe("MessageTree", () => {
  const makeMsg = (
    id: string,
    role: "user" | "assistant",
    content: string,
  ) => ({
    publicId: id,
    role,
    content,
    branchReason: null,
    siblingCount: 1,
  });

  it("renders all messages", async () => {
    const { MessageTree } = await import("./message-tree");
    render(
      <MessageTree
        messages={[
          makeMsg("m1", "user", "Hello"),
          makeMsg("m2", "assistant", "Hi there"),
          makeMsg("m3", "user", "Follow up"),
        ]}
      />,
    );
    expect(screen.getByTestId("message-m1")).toHaveTextContent("Hello");
    expect(screen.getByTestId("message-m2")).toHaveTextContent("Hi there");
    expect(screen.getByTestId("message-m3")).toHaveTextContent("Follow up");
  });

  it("renders empty list without crashing", async () => {
    const { MessageTree } = await import("./message-tree");
    const { container } = render(<MessageTree messages={[]} />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it("renders messages in DOM order (oldest first)", async () => {
    const { MessageTree } = await import("./message-tree");
    render(
      <MessageTree
        messages={[
          makeMsg("first", "user", "First message"),
          makeMsg("second", "assistant", "Second message"),
        ]}
      />,
    );
    const items = screen.getAllByTestId(/^message-/);
    expect(items[0]).toHaveTextContent("First message");
    expect(items[1]).toHaveTextContent("Second message");
  });

  it("passes role to each message bubble", async () => {
    const { MessageTree } = await import("./message-tree");
    render(
      <MessageTree
        messages={[
          makeMsg("a", "user", "From user"),
          makeMsg("b", "assistant", "From assistant"),
        ]}
      />,
    );
    expect(screen.getByTestId("message-a")).toHaveAttribute(
      "data-role",
      "user",
    );
    expect(screen.getByTestId("message-b")).toHaveAttribute(
      "data-role",
      "assistant",
    );
  });
});
