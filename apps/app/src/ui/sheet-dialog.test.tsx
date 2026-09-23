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
});

describe("SheetDialog as a modal", () => {
  it("tells assistive technology it is modal", () => {
    render(
      <IntlProvider>
        <SheetDialog open onOpenChange={vi.fn()} title="Modal" testId="modal">
          <p>Body</p>
        </SheetDialog>
      </IntlProvider>,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("puts the footer note in the footer, before Close and the primary action", () => {
    render(
      <IntlProvider>
        <SheetDialog
          open
          onOpenChange={vi.fn()}
          title="Noted"
          testId="noted"
          footerNote="2 agents at the boundary"
          footer={<button type="button">Steer</button>}
        >
          <p>Body</p>
        </SheetDialog>
      </IntlProvider>,
    );
    const footer = document.querySelector<HTMLElement>("[data-sheet-footer]");
    if (!footer) throw new Error("Missing dialog footer");
    const note = footer.querySelector("[data-footer-note]");
    expect(note).toHaveTextContent("2 agents at the boundary");
    expect(footer.firstElementChild).toBe(note);
  });

  it("draws no note element when none is given", () => {
    render(
      <IntlProvider>
        <SheetDialog open onOpenChange={vi.fn()} title="Plain" testId="plain">
          <p>Body</p>
        </SheetDialog>
      </IntlProvider>,
    );
    expect(document.querySelector("[data-footer-note]")).toBeNull();
  });
});
