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
  it("draws the header × only when asked, and it closes the dialog", async () => {
    const change = vi.fn();
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <SheetDialog
          open
          headerClose
          onOpenChange={change}
          title="Governance"
          testId="with-x"
        >
          <p>Pick one</p>
        </SheetDialog>
      </IntlProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Close the dialog" }));
    expect(change).toHaveBeenCalledWith(false);
  });
  it("draws no header × by default (negative)", () => {
    render(
      <IntlProvider>
        <SheetDialog open onOpenChange={vi.fn()} title="Plain" testId="plain">
          <p>Ready</p>
        </SheetDialog>
      </IntlProvider>,
    );
    expect(
      screen.queryByRole("button", { name: "Close the dialog" }),
    ).toBeNull();
  });
});
