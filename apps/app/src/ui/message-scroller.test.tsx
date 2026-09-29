// @vitest-environment jsdom
// The message scroller around a conversation: a named region the keyboard can
// scroll, a log a screen reader follows as messages arrive, and a button back
// to the newest message that stays out of the tab order while that message is
// in view. jsdom lays nothing out, so the newest message always reads as in
// view here.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./message-scroller";

afterEach(cleanup);

function renderScroller() {
  return render(
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
      <MessageScroller>
        <MessageScrollerViewport aria-label="Conversation with stella">
          <MessageScrollerContent>
            <MessageScrollerItem messageId="q1" scrollAnchor>
              <p>What ran overnight?</p>
            </MessageScrollerItem>
            <MessageScrollerItem messageId="a1">
              <p>Three runs, all within budget.</p>
            </MessageScrollerItem>
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton label="Scroll to the newest message" />
      </MessageScroller>
    </MessageScrollerProvider>,
  );
}

describe("MessageScroller", () => {
  it("names the scrolling region and lets the keyboard reach it", async () => {
    const { container } = renderScroller();
    const region = screen.getByRole("region", {
      name: "Conversation with stella",
    });
    expect(region).toHaveAttribute("tabindex", "0");
    await expectNoAxe(container);
  });

  it("holds the messages in a log that announces additions", () => {
    renderScroller();
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-relevant", "additions");
    expect(log).toHaveTextContent("What ran overnight?");
    expect(log).toHaveTextContent("Three runs, all within budget.");
  });

  it("marks only the question as the scroll anchor", () => {
    const { container } = renderScroller();
    const question = container.querySelector('[data-message-id="q1"]');
    const answer = container.querySelector('[data-message-id="a1"]');
    expect(question).toHaveAttribute("data-scroll-anchor", "true");
    expect(answer).toHaveAttribute("data-scroll-anchor", "false");
  });

  it("keeps the button out of the tab order while the newest message is in view", () => {
    renderScroller();
    const button = screen.getByRole("button", {
      name: "Scroll to the newest message",
    });
    expect(button).toHaveAttribute("data-active", "false");
    expect(button).toHaveAttribute("inert");
    expect(button).toHaveAttribute("tabindex", "-1");
  });
});
