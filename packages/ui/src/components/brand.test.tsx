// @vitest-environment jsdom
/**
 * brand.test.tsx — render tests for the "o + cursor" mark components.
 *
 * The logomark is an SVG (role=img) holding the "o" letterform plus the cursor
 * block; the wordmark is lowercase "oxagen" as real text. BrandMark renders the
 * mark directly. Note: SVG elements in JSDOM expose className as
 * SVGAnimatedString, not a plain string — use getAttribute("class").
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import {
  OxagenLogomark,
  OxagenWordmark,
  BrandMark,
  OxagenLockup,
  OxagenLogo,
  NodeChip,
  ConfidenceBar,
} from "./brand";

afterEach(cleanup);

describe("OxagenLogomark — render", () => {
  it("renders an SVG with role=img", () => {
    const { getByRole } = render(<OxagenLogomark />);
    expect(getByRole("img", { name: "Oxagen logomark" })).toBeInTheDocument();
  });

  it("paints the cursor block in the brand cursor hue by default", () => {
    const { container } = render(<OxagenLogomark />);
    const cursor = container.querySelector("rect");
    expect(cursor).toBeInTheDocument();
    expect(cursor?.getAttribute("fill")).toBe("var(--ox-cursor)");
  });

  it("lets the 'o' inherit the surrounding text colour so it flips with the theme", () => {
    const { container } = render(<OxagenLogomark />);
    expect(container.querySelector("path")?.getAttribute("fill")).toBe(
      "currentColor",
    );
  });

  it("carries no gradient — the mark is flat ink plus a solid cursor", () => {
    const { container } = render(<OxagenLogomark />);
    expect(container.querySelector("linearGradient")).not.toBeInTheDocument();
  });

  it("flattens BOTH the 'o' and the cursor to one colour for a mono tone", () => {
    const { container } = render(<OxagenLogomark tone="mono-light" />);
    expect(container.querySelector("path")?.getAttribute("fill")).toBe(
      "var(--ink-light)",
    );
    expect(container.querySelector("rect")?.getAttribute("fill")).toBe(
      "var(--ink-light)",
    );
  });

  it("keeps the canonical viewBox from oxagen-glyph-adaptive.svg", () => {
    const { getByRole } = render(<OxagenLogomark />);
    expect(getByRole("img").getAttribute("viewBox")).toBe(
      "-4.40 -80.00 143.40 90.20",
    );
  });

  it("accepts className via getAttribute", () => {
    const { getByRole } = render(<OxagenLogomark className="h-7" />);
    expect(getByRole("img").getAttribute("class")).toContain("h-7");
  });
});

describe("OxagenWordmark — render", () => {
  it("renders the Oxagen wordmark as text", () => {
    const { getByText } = render(<OxagenWordmark />);
    expect(getByText("oxagen")).toBeInTheDocument();
  });

  it("uses the wordmark class", () => {
    const { getByText } = render(<OxagenWordmark className="text-xl" />);
    const el = getByText("oxagen");
    expect(el.className).toContain("ox-wordmark");
    expect(el.className).toContain("text-xl");
  });

  it("applies a mono color when toned", () => {
    const { getByText } = render(<OxagenWordmark tone="mono-dark" />);
    expect(getByText("oxagen").style.color).toBe("var(--ink-dark)");
  });
});

describe("BrandMark — render", () => {
  it("renders the o + cursor SVG", () => {
    const { container } = render(<BrandMark />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("merges custom className onto the mark", () => {
    const { container } = render(<BrandMark className="custom-brand" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain(
      "custom-brand",
    );
  });

  /**
   * The mark is wider than it is tall, so it must be sized by HEIGHT. A square
   * utility (`size-7`) would letterbox it down to ~63% of the available height.
   */
  it("sizes by height, not into a square box", () => {
    const { container } = render(<BrandMark />);
    const cls = container.querySelector("svg")?.getAttribute("class") ?? "";
    expect(cls).toContain("h-7");
    expect(cls).toContain("w-auto");
    expect(cls).not.toContain("size-7");
  });
});

describe("OxagenLockup — render", () => {
  it("renders both the mark SVG and the wordmark text", () => {
    const { container, getByText } = render(<OxagenLockup />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(getByText("oxagen")).toBeInTheDocument();
  });

  it("merges custom className on lockup span", () => {
    const { container } = render(<OxagenLockup className="custom-lockup" />);
    expect((container.firstChild as HTMLElement).className).toContain(
      "custom-lockup",
    );
  });
});

describe("OxagenLogo — variants", () => {
  it("mark variant renders only the mark", () => {
    const { container, queryByText } = render(<OxagenLogo variant="mark" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(queryByText("oxagen")).not.toBeInTheDocument();
  });

  it("horizontal variant renders mark + wordmark", () => {
    const { container, getByText } = render(
      <OxagenLogo variant="horizontal" size={40} />,
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(getByText("oxagen")).toBeInTheDocument();
  });

  it("vertical variant renders mark + wordmark", () => {
    const { container, getByText } = render(<OxagenLogo variant="vertical" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(getByText("oxagen")).toBeInTheDocument();
  });
});

describe("NodeChip — render", () => {
  it("renders the id in a mono chip", () => {
    const { getByText } = render(<NodeChip kind="document" id="doc_41be09" />);
    expect(getByText("doc_41be09")).toBeInTheDocument();
  });

  it("renders an optional label", () => {
    const { getByText } = render(
      <NodeChip kind="user" id="prn_8fa21c" label="Ada" />,
    );
    expect(getByText("Ada")).toBeInTheDocument();
    expect(getByText("prn_8fa21c")).toBeInTheDocument();
  });
});

describe("ConfidenceBar — render", () => {
  it("clamps and renders the percentage", () => {
    const { getByText } = render(<ConfidenceBar score={0.82} />);
    expect(getByText("82%")).toBeInTheDocument();
  });

  it("clamps out-of-range scores to 100%", () => {
    const { getByText } = render(<ConfidenceBar score={1.5} />);
    expect(getByText("100%")).toBeInTheDocument();
  });

  it("hides the value when showValue is false", () => {
    const { queryByText } = render(
      <ConfidenceBar score={0.5} showValue={false} />,
    );
    expect(queryByText("50%")).not.toBeInTheDocument();
  });
});
