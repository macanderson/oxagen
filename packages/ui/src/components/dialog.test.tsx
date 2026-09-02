// @vitest-environment jsdom
/**
 * dialog.test.tsx — render tests for Dialog and its sub-parts.
 *
 * Covers: coss naming (DialogPopup not DialogContent), open/close,
 * DialogHeader/Panel/Footer, DialogTitle, DialogDescription, DialogClose.
 */

import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach } from "vitest";
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "./dialog";

afterEach(cleanup);

// Helper: render a dialog in its open state via controlled prop
function OpenDialog({ children }: { children?: React.ReactNode }) {
  return (
    <Dialog open>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Dialog Title</DialogTitle>
          <DialogDescription>Dialog description text.</DialogDescription>
        </DialogHeader>
        <DialogPanel>{children ?? <p>Dialog body</p>}</DialogPanel>
        <DialogFooter>
          <DialogClose render={<button type="button" />}>
            Close Dialog
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

describe("Dialog — open state render", () => {
  it("renders the dialog popup with dialog role", () => {
    const { getByRole } = render(<OpenDialog />);
    expect(getByRole("dialog")).toBeInTheDocument();
  });

  it("renders DialogTitle", () => {
    const { getByText } = render(<OpenDialog />);
    expect(getByText("Dialog Title")).toBeInTheDocument();
  });

  it("renders DialogDescription", () => {
    const { getByText } = render(<OpenDialog />);
    expect(getByText("Dialog description text.")).toBeInTheDocument();
  });

  it("renders DialogPanel children", () => {
    const { getByText } = render(
      <OpenDialog>
        <span>Panel content</span>
      </OpenDialog>,
    );
    expect(getByText("Panel content")).toBeInTheDocument();
  });

  it("renders DialogClose button", () => {
    const { getByRole } = render(<OpenDialog />);
    expect(getByRole("button", { name: "Close Dialog" })).toBeInTheDocument();
  });

  it("has an accessible close icon button (sr-only label)", () => {
    const { getByText } = render(<OpenDialog />);
    expect(getByText("Close")).toBeInTheDocument();
  });
});

describe("Dialog — trigger open", () => {
  it("opens dialog when trigger is clicked", async () => {
    const { queryByRole, getByRole, getByText } = render(
      <Dialog>
        <DialogTrigger render={<button type="button" />}>
          Open Dialog
        </DialogTrigger>
        <DialogPopup>
          <DialogTitle>Triggered Dialog</DialogTitle>
        </DialogPopup>
      </Dialog>,
    );
    expect(queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(getByRole("button", { name: "Open Dialog" }));
    expect(getByRole("dialog")).toBeInTheDocument();
    expect(getByText("Triggered Dialog")).toBeInTheDocument();
  });
});

describe("DialogHeader / DialogPanel / DialogFooter — standalone", () => {
  it("DialogHeader renders children", () => {
    const { getByText } = render(<DialogHeader>Header content</DialogHeader>);
    expect(getByText("Header content")).toBeInTheDocument();
  });

  it("DialogPanel renders children", () => {
    const { getByText } = render(<DialogPanel>Panel content</DialogPanel>);
    expect(getByText("Panel content")).toBeInTheDocument();
  });

  it("DialogFooter renders children", () => {
    const { getByText } = render(<DialogFooter>Footer</DialogFooter>);
    expect(getByText("Footer")).toBeInTheDocument();
  });
});
