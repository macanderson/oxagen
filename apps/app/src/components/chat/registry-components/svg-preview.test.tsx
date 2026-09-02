// @vitest-environment jsdom
/**
 * svg-preview.test.tsx
 *
 * Render + interaction tests for SvgPreview:
 *   - Renders title
 *   - Renders SVG as a data URI in an img element
 *   - Copy button exists and has correct aria-label
 *   - Copy button shows "Copied" after click (if clipboard available)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SvgPreview from "./svg-preview";

afterEach(cleanup);

describe("SvgPreview", () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="50"/></svg>';
  const TITLE = "My SVG diagram";

  it("renders the title", () => {
    render(<SvgPreview svg={SVG} title={TITLE} />);
    expect(screen.getByText(TITLE)).toBeInTheDocument();
  });

  it("renders an img element with the SVG data URI as src", () => {
    render(<SvgPreview svg={SVG} title={TITLE} />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute(
      "src",
      expect.stringContaining("data:image/svg+xml"),
    );
  });

  it("img alt text matches the title", () => {
    render(<SvgPreview svg={SVG} title={TITLE} />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("alt", TITLE);
  });

  it("renders the copy button with correct aria-label", () => {
    render(<SvgPreview svg={SVG} title={TITLE} />);
    expect(screen.getByLabelText("Copy SVG markup")).toBeInTheDocument();
  });

  it("uses the figure role with aria-label matching title", () => {
    render(<SvgPreview svg={SVG} title={TITLE} />);
    expect(screen.getByRole("figure")).toHaveAttribute("aria-label", TITLE);
  });

  it("copy button shows 'Copied' text after successful copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    render(<SvgPreview svg={SVG} title={TITLE} />);
    await userEvent.click(screen.getByLabelText("Copy SVG markup"));
    expect(writeText).toHaveBeenCalledWith(SVG);
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("encodes the SVG content in the data URI using encodeURIComponent", () => {
    render(<SvgPreview svg={SVG} title={TITLE} />);
    const img = screen.getByRole("img");
    const expected = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`;
    expect(img).toHaveAttribute("src", expected);
  });

  it("shows a Download link when the persisted serveUrl is provided", () => {
    render(
      <SvgPreview
        svg={SVG}
        title={TITLE}
        serveUrl="/api/v1/assets/gen_abc123"
        assetPublicId="gen_abc123"
      />,
    );
    const link = screen.getByLabelText(`Download ${TITLE} as SVG file`);
    expect(link).toHaveAttribute("href", "/api/v1/assets/gen_abc123");
    // The download attribute forces a save (with a readable name) even though
    // the serve route ships SVG with attachment disposition.
    expect(link).toHaveAttribute("download", `${TITLE}.svg`);
  });

  it("hides the Download link when no serveUrl is provided (persistence skipped/failed)", () => {
    render(<SvgPreview svg={SVG} title={TITLE} />);
    expect(
      screen.queryByLabelText(`Download ${TITLE} as SVG file`),
    ).not.toBeInTheDocument();
  });

  it("never renders the SVG markup into the DOM (no dangerouslySetInnerHTML)", () => {
    const malicious =
      '<svg xmlns="http://www.w3.org/2000/svg"><circle r="9"/></svg>';
    const { container } = render(<SvgPreview svg={malicious} title={TITLE} />);
    // The raw markup must only ever appear encoded inside the img src —
    // querying the DOM for an actual <circle> element must find nothing.
    expect(container.querySelector("circle")).toBeNull();
    expect(container.querySelector("svg:not([class])")).toBeNull();
  });
});
