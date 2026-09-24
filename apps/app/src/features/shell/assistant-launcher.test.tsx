// @vitest-environment jsdom
// The launcher names Stella and carries Stella's asterisk, and it still opens
// and closes the panel it controls.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { AssistantLauncher, ASSISTANT_PANEL_ID } from "./assistant-launcher";
import { ShellStateProvider } from "./shell-state";

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

function renderLauncher() {
  return render(
    <IntlProvider>
      <ShellStateProvider>
        <AssistantLauncher />
      </ShellStateProvider>
    </IntlProvider>,
  );
}

describe("AssistantLauncher", () => {
  it("reads Ask Stella beside the Stella asterisk", async () => {
    const { container } = renderLauncher();
    const launcher = screen.getByRole("button", { name: /Ask Stella/ });
    expect(launcher).toHaveAttribute("aria-controls", ASSISTANT_PANEL_ID);
    const icon = screen.getByTestId("assistant-launcher-icon");
    expect(icon.tagName.toLowerCase()).toBe("svg");
    expect(icon.querySelector("path")?.getAttribute("fill")).toBe("#D4AF37");
    await expectNoAxe(container);
  });

  it("opens the panel and closes it again", async () => {
    const user = userEvent.setup();
    renderLauncher();
    const launcher = screen.getByRole("button", { name: /Ask Stella/ });
    expect(launcher).toHaveAttribute("aria-expanded", "false");
    await user.click(launcher);
    expect(launcher).toHaveAttribute("aria-expanded", "true");
    await user.click(launcher);
    expect(launcher).toHaveAttribute("aria-expanded", "false");
  });
});
