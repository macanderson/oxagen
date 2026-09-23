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
          closeLabel="Cancel"
          onOpenChange={change}
          title="Governance"
          testId="with-x"
        >
          <p>Pick one</p>
        </SheetDialog>
      </IntlProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
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
    expect(document.querySelector("[data-header-close]")).toBeNull();
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

describe("SheetDialog header close", () => {
  it("draws the mockup's x labelled Close beside the title and dismisses with it", async () => {
    const change = vi.fn();
    const user = userEvent.setup();
    render(
      <IntlProvider>
        <SheetDialog
          open
          headerClose
          closeLabel="Cancel"
          onOpenChange={change}
          title="Pause this run"
          testId="pause"
        >
          <p>Body</p>
        </SheetDialog>
      </IntlProvider>,
    );
    const header = document.querySelector<HTMLElement>("[data-sheet-header]");
    if (!header) throw new Error("Missing dialog header");
    const close = screen.getByRole("button", { name: "Close" });
    expect(header).toContainElement(close);
    await user.click(close);
    expect(change).toHaveBeenCalledWith(false);
  });

  it("holds the header close with the footer when the dialog is held (negative)", () => {
    render(
      <IntlProvider>
        <SheetDialog
          open
          headerClose
          dismissible={false}
          closeLabel="Cancel"
          onOpenChange={vi.fn()}
          title="Held"
          testId="held-x"
        >
          <p>Body</p>
        </SheetDialog>
      </IntlProvider>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });

  it("draws no header close unless asked", () => {
    render(
      <IntlProvider>
        <SheetDialog open onOpenChange={vi.fn()} title="Plain" testId="plain-x">
          <p>Body</p>
        </SheetDialog>
      </IntlProvider>,
    );
    expect(document.querySelector("[data-header-close]")).toBeNull();
  });
});
