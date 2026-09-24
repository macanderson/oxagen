// @vitest-environment jsdom
// The Working copies tab and its Connect a directory dialog on their own: the
// gold moves off Connect when another tab holds it, and copying the command
// says whether it worked and forgets that once the dialog closes.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { ConnectDirectoryDialog, WorkingCopies } from "./working-copies";

/**
 * Replace the clipboard for one test. `userEvent.setup()` installs its own,
 * so this runs after it and puts the original descriptor back.
 */
function stubClipboard(writeText: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return () => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  };
}

/** The dialog behind a button that opens it, the way the page holds it. */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <WorkingCopies
        primary={false}
        onConnect={() => {
          setOpen(true);
        }}
      />
      <ConnectDirectoryDialog
        org="acme"
        ws="core-platform"
        open={open}
        onClose={() => {
          setOpen(false);
        }}
      />
    </>
  );
}

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Working copies", () => {
  it("draws Connect a directory as the small secondary when the tab does not hold the gold", async () => {
    const { container } = render(
      <IntlProvider>
        <WorkingCopies primary={false} onConnect={vi.fn()} />
      </IntlProvider>,
    );
    const connect = screen.getByTestId("working-copies-connect");
    expect(connect.className).not.toContain("bg-button-primary-bg");
    await expectNoAxe(container);
  });

  it("copies the command and says so, then forgets it once the dialog closes", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    const restore = stubClipboard(writeText);
    try {
      render(
        <IntlProvider>
          <Harness />
        </IntlProvider>,
      );
      await user.click(screen.getByTestId("working-copies-connect"));
      const dialog = await screen.findByTestId("linkdir-dialog");
      const copy = within(dialog).getByTestId("linkdir-copy");
      expect(copy).toHaveTextContent("Copy command");
      await user.click(copy);
      expect(writeText).toHaveBeenCalledWith(
        "oxagen init --org acme --workspace core-platform",
      );
      expect(copy).toHaveTextContent("Copied");
      await expectNoAxe(dialog);

      await user.keyboard("{Escape}");
      await waitFor(() => {
        expect(screen.queryByTestId("linkdir-dialog")).toBeNull();
      });
      await user.click(screen.getByTestId("working-copies-connect"));
      expect(
        within(await screen.findByTestId("linkdir-dialog")).getByTestId(
          "linkdir-copy",
        ),
      ).toHaveTextContent("Copy command");
    } finally {
      restore();
    }
  });

  it("says copying did not work and leaves the command to select (negative)", async () => {
    const user = userEvent.setup();
    const restore = stubClipboard(() =>
      Promise.reject(new Error("clipboard denied")),
    );
    try {
      render(
        <IntlProvider>
          <Harness />
        </IntlProvider>,
      );
      await user.click(screen.getByTestId("working-copies-connect"));
      const dialog = await screen.findByTestId("linkdir-dialog");
      await user.click(within(dialog).getByTestId("linkdir-copy"));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "Copying did not work. Select the command and copy it.",
      );
      expect(within(dialog).getByTestId("linkdir-copy")).toHaveTextContent(
        "Copy command",
      );
    } finally {
      restore();
    }
  });
});
