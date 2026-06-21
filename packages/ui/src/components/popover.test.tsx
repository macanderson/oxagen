// @vitest-environment jsdom
/**
 * popover.test.tsx — render tests for Popover and its sub-parts.
 *
 * Covers: PopoverPopup renders inside an open Popover, PopoverTitle,
 * PopoverDescription, PopoverTrigger, PopoverClose sub-parts.
 * Uses coss-ui / Base UI naming (PopoverPopup not PopoverContent).
 */

import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, afterEach } from "vitest";
import {
  Popover,
  PopoverTrigger,
  PopoverClose,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
} from "./popover";

afterEach(cleanup);

// Helper: a pre-opened popover to avoid needing pointer interactions with the portal.
function OpenPopover({ children }: { children?: ReactNode }) {
  return (
    <Popover open>
      <PopoverPopup>
        {children ?? (
          <>
            <PopoverTitle>Popover title</PopoverTitle>
            <PopoverDescription>Popover description text.</PopoverDescription>
          </>
        )}
      </PopoverPopup>
    </Popover>
  );
}

describe("Popover — open state render", () => {
  it("renders PopoverPopup content when open", () => {
    const { getByText } = render(<OpenPopover />);
    expect(getByText("Popover title")).toBeInTheDocument();
    expect(getByText("Popover description text.")).toBeInTheDocument();
  });

  it("renders custom children inside PopoverPopup", () => {
    const { getByText } = render(
      <OpenPopover>
        <p>Custom content</p>
      </OpenPopover>,
    );
    expect(getByText("Custom content")).toBeInTheDocument();
  });

  it("PopoverTitle is rendered in the document", () => {
    const { getByText } = render(
      <Popover open>
        <PopoverPopup>
          <PopoverTitle>My Title</PopoverTitle>
        </PopoverPopup>
      </Popover>,
    );
    expect(getByText("My Title")).toBeInTheDocument();
  });

  it("PopoverDescription is rendered in the document", () => {
    const { getByText } = render(
      <Popover open>
        <PopoverPopup>
          <PopoverDescription>Some helpful text.</PopoverDescription>
        </PopoverPopup>
      </Popover>,
    );
    expect(getByText("Some helpful text.")).toBeInTheDocument();
  });
});

describe("Popover — trigger interaction", () => {
  it("opens when trigger is clicked", async () => {
    const { getByRole, getByText, queryByText } = render(
      <Popover>
        <PopoverTrigger render={<button type="button" />}>
          Open Popover
        </PopoverTrigger>
        <PopoverPopup>
          <PopoverTitle>Triggered Title</PopoverTitle>
        </PopoverPopup>
      </Popover>,
    );
    expect(queryByText("Triggered Title")).not.toBeInTheDocument();
    await userEvent.click(getByRole("button", { name: "Open Popover" }));
    expect(getByText("Triggered Title")).toBeInTheDocument();
  });
});

describe("Popover — close button", () => {
  it("renders a PopoverClose button in the open popover", () => {
    const { getByRole } = render(
      <Popover open>
        <PopoverPopup>
          <PopoverTitle>Closeable</PopoverTitle>
          <PopoverClose render={<button type="button" />}>Dismiss</PopoverClose>
        </PopoverPopup>
      </Popover>,
    );
    expect(getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});

describe("PopoverPopup — className forwarding", () => {
  it("merges custom className onto the popup element", () => {
    const { getByText } = render(
      <Popover open>
        <PopoverPopup className="custom-class">
          <PopoverTitle>Styled</PopoverTitle>
        </PopoverPopup>
      </Popover>,
    );
    const title = getByText("Styled");
    // The popup element is an ancestor; check it carries the custom class.
    const popup = title.closest("[class*='custom-class']");
    expect(popup).toBeInTheDocument();
  });
});
