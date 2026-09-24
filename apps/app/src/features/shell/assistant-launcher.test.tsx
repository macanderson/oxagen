// @vitest-environment jsdom
// The launcher reads "Ask stella*" over "oxagen’s in-app AI agent", opens and
// closes the panel it controls, and shines for a reply the person has not seen.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { AssistantLauncher, ASSISTANT_PANEL_ID } from "./assistant-launcher";
import { ShellStateProvider, useShellState } from "./shell-state";

// The theme provider inside the shell state reads the colour scheme, and
// jsdom has no matchMedia.
beforeAll(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(cleanup);

/** Stands in for the flyout: a turn settling, and the panel's close button. */
function FlyoutStandIn() {
  const { noteAssistantReply, setAssistantOpen } = useShellState();
  return (
    <>
      <button type="button" onClick={noteAssistantReply}>
        settle a turn
      </button>
      <button
        type="button"
        onClick={() => {
          setAssistantOpen(false);
        }}
      >
        close the panel
      </button>
    </>
  );
}

function renderLauncher() {
  return render(
    <IntlProvider>
      <ShellStateProvider>
        <AssistantLauncher />
        <FlyoutStandIn />
      </ShellStateProvider>
    </IntlProvider>,
  );
}

describe("AssistantLauncher", () => {
  it("reads Ask stella* over oxagen’s in-app AI agent, in the wordmark face", async () => {
    const { container } = renderLauncher();
    const launcher = screen.getByRole("button", { name: /^Ask stella/ });
    expect(launcher).toHaveAttribute("aria-controls", ASSISTANT_PANEL_ID);
    expect(launcher).toHaveTextContent("Ask stella*oxagen’s in-app AI agent");
    // No capital S anywhere in the control.
    expect(launcher.textContent).not.toMatch(/Stella/);
    // The icon is gone: the asterisk is text now.
    expect(launcher.querySelector("svg[data-mark]")).toBeNull();

    const names = Array.from(launcher.querySelectorAll(".ox-wordmark")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["stella*", "oxagen’s"]);
    // The asterisk takes the theme-following gold and is not read aloud.
    const accent = launcher.querySelector(".ox-wordmark-accent");
    expect(accent?.textContent).toBe("*");
    expect(accent).toHaveAttribute("aria-hidden", "true");
    await expectNoAxe(container);
  });

  it("opens the panel and closes it again", async () => {
    const user = userEvent.setup();
    renderLauncher();
    const launcher = screen.getByRole("button", { name: /^Ask stella/ });
    expect(launcher).toHaveAttribute("aria-expanded", "false");
    await user.click(launcher);
    expect(launcher).toHaveAttribute("aria-expanded", "true");
    await user.click(launcher);
    expect(launcher).toHaveAttribute("aria-expanded", "false");
  });

  it("shines for a reply that lands while the panel is closed, until it opens", async () => {
    const user = userEvent.setup();
    const { container } = renderLauncher();
    const launcher = screen.getByTestId("assistant-launcher");
    expect(launcher).not.toHaveAttribute("data-unread");
    expect(launcher).not.toHaveClass("ox-launcher-unread");

    await user.click(screen.getByRole("button", { name: "settle a turn" }));
    expect(launcher).toHaveAttribute("data-unread");
    expect(launcher).toHaveClass("ox-launcher-unread");
    // Said in words too, so the cue is not colour or motion alone.
    expect(launcher).toHaveAccessibleName(/New reply/);
    await expectNoAxe(container);

    await user.click(launcher);
    expect(launcher).not.toHaveAttribute("data-unread");
    expect(launcher).not.toHaveClass("ox-launcher-unread");
    expect(screen.queryByTestId("assistant-launcher-unread")).toBeNull();
  });

  it("does not shine for a reply the person watched arrive (negative)", async () => {
    const user = userEvent.setup();
    renderLauncher();
    const launcher = screen.getByTestId("assistant-launcher");
    await user.click(launcher);
    await user.click(screen.getByRole("button", { name: "settle a turn" }));
    expect(launcher).not.toHaveAttribute("data-unread");

    // Closing the panel afterwards does not turn a read reply into a new one.
    await user.click(screen.getByRole("button", { name: "close the panel" }));
    expect(launcher).toHaveAttribute("aria-expanded", "false");
    expect(launcher).not.toHaveAttribute("data-unread");
  });

  // Only opening the panel reads a reply. A close that finds it already
  // closed keeps the cue, so the person still has something to open.
  it("keeps shining through a close of a panel that is already closed", async () => {
    const user = userEvent.setup();
    renderLauncher();
    const launcher = screen.getByTestId("assistant-launcher");
    await user.click(screen.getByRole("button", { name: "settle a turn" }));
    expect(launcher).toHaveAttribute("data-unread");

    await user.click(screen.getByRole("button", { name: "close the panel" }));
    expect(launcher).toHaveAttribute("aria-expanded", "false");
    expect(launcher).toHaveAttribute("data-unread");
    expect(screen.getByTestId("assistant-launcher-unread")).toHaveTextContent(
      "New reply",
    );
  });
});
