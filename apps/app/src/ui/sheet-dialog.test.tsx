// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntlProvider } from "@/test/intl";
import { SheetDialog } from "./sheet-dialog";

afterEach(cleanup);
describe("SheetDialog dismissal", () => {
  it("blocks Close, Escape, and backdrop dismissal when held", async () => {
    const change = vi.fn();
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <SheetDialog
          open
          dismissible={false}
          onOpenChange={change}
          title="Held"
          testId="held"
        >
          <p>Waiting for acknowledgement</p>
        </SheetDialog>
      </IntlProvider>,
    );
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toBeDisabled();
    await user.click(close);
    const dismiss = screen.getByRole("button", { name: "Close Held" });
    expect(dismiss).toBeDisabled();
    await user.click(dismiss);
    await user.keyboard("{Escape}");
    const backdrop = document.querySelector<HTMLElement>("[data-scrim]");
    if (!backdrop) throw new Error("Missing dialog backdrop");
    await user.click(backdrop);
    expect(change).not.toHaveBeenCalled();
  });
  it("allows dismissal by default", async () => {
    const change = vi.fn();
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <SheetDialog open onOpenChange={change} title="Open" testId="open">
          <p>Ready</p>
        </SheetDialog>
      </IntlProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(change).toHaveBeenCalledWith(false);
  });
  it("closes from the header's ✕, named for the dialog it closes", async () => {
    const change = vi.fn();
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <SheetDialog open onOpenChange={change} title="More" testId="more">
          <p>Tiles</p>
        </SheetDialog>
      </IntlProvider>,
    );
    const dismiss = screen.getByRole("button", { name: "Close More" });
    expect(dismiss).toHaveAttribute("data-dialog-dismiss");
    await user.click(dismiss);
    expect(change).toHaveBeenCalledWith(false);
  });
});
