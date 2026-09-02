// @vitest-environment jsdom
/**
 * tooltip.test.tsx — Tooltip renders the Base UI tooltip and styles the popup
 * through the --tooltip-* token utilities. Forced open (controlled) so the
 * portalled popup is asserted deterministically without timing on hover delays.
 */
import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import {
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
  TooltipProvider,
} from "./tooltip";

afterEach(cleanup);

describe("Tooltip", () => {
  it("renders the trigger", () => {
    const { getByText } = render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipPopup>Tip body</TooltipPopup>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(getByText("Hover me")).toBeInTheDocument();
  });

  it("renders the popup content with --tooltip-* token classes when open", () => {
    const { getByText } = render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipPopup>Notifications</TooltipPopup>
        </Tooltip>
      </TooltipProvider>,
    );
    const popup = getByText("Notifications");
    expect(popup).toBeInTheDocument();
    expect(popup.className).toContain("bg-tooltip-bg");
    expect(popup.className).toContain("text-tooltip-fg");
    expect(popup.className).toContain("border-tooltip-border");
  });

  it("merges a custom className onto the popup", () => {
    const { getByText } = render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>T</TooltipTrigger>
          <TooltipPopup className="max-w-sm">Body</TooltipPopup>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(getByText("Body").className).toContain("max-w-sm");
    expect(getByText("Body").className).toContain("bg-tooltip-bg");
  });
});
