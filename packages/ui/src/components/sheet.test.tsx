// @vitest-environment jsdom
/**
 * sheet.test.tsx — render tests for Sheet and sub-parts.
 */

import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach } from "vitest";
import {
  Sheet,
  SheetTrigger,
  SheetPopup,
  SheetHeader,
  SheetPanel,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SheetClose,
} from "./sheet";

afterEach(cleanup);

function OpenSheet({ side }: { side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Sheet open>
      <SheetPopup side={side}>
        <SheetHeader>
          <SheetTitle>Sheet Title</SheetTitle>
          <SheetDescription>Sheet description.</SheetDescription>
        </SheetHeader>
        <SheetPanel>
          <p>Sheet body content</p>
        </SheetPanel>
        <SheetFooter>
          <SheetClose render={<button type="button" />}>Close Sheet</SheetClose>
        </SheetFooter>
      </SheetPopup>
    </Sheet>
  );
}

describe("Sheet — open state render", () => {
  it("renders with dialog role when open", () => {
    const { getByRole } = render(<OpenSheet />);
    expect(getByRole("dialog")).toBeInTheDocument();
  });

  it("renders SheetTitle", () => {
    const { getByText } = render(<OpenSheet />);
    expect(getByText("Sheet Title")).toBeInTheDocument();
  });

  it("renders SheetDescription", () => {
    const { getByText } = render(<OpenSheet />);
    expect(getByText("Sheet description.")).toBeInTheDocument();
  });

  it("renders SheetPanel children", () => {
    const { getByText } = render(<OpenSheet />);
    expect(getByText("Sheet body content")).toBeInTheDocument();
  });

  it("renders SheetClose button", () => {
    const { getByRole } = render(<OpenSheet />);
    expect(getByRole("button", { name: "Close Sheet" })).toBeInTheDocument();
  });
});

describe("Sheet — trigger open", () => {
  it("opens sheet when trigger is clicked", async () => {
    const { queryByRole, getByRole } = render(
      <Sheet>
        <SheetTrigger render={<button type="button" />}>
          Open Sheet
        </SheetTrigger>
        <SheetPopup>
          <SheetTitle>Triggered Sheet</SheetTitle>
        </SheetPopup>
      </Sheet>,
    );
    expect(queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(getByRole("button", { name: "Open Sheet" }));
    expect(getByRole("dialog")).toBeInTheDocument();
  });
});

describe("SheetHeader / SheetPanel / SheetFooter — standalone", () => {
  it("SheetHeader renders children", () => {
    const { getByText } = render(<SheetHeader>Header</SheetHeader>);
    expect(getByText("Header")).toBeInTheDocument();
  });

  it("SheetPanel renders children", () => {
    const { getByText } = render(<SheetPanel>Content</SheetPanel>);
    expect(getByText("Content")).toBeInTheDocument();
  });

  it("SheetFooter renders children", () => {
    const { getByText } = render(<SheetFooter>Footer</SheetFooter>);
    expect(getByText("Footer")).toBeInTheDocument();
  });
});
