// @vitest-environment jsdom
/**
 * brand.test.tsx — render tests for the ember brain mark components.
 *
 * The logomark is the brain SVG (role=img) with the ember gradient; the wordmark
 * is "Oxagen" as real text. BrandMark renders the brain directly. Note: SVG
 * elements in JSDOM expose className as SVGAnimatedString, not a plain string —
 * use getAttribute("class").
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

  it("paints the ember gradient by default (defs present)", () => {
    const { container } = render(<OxagenLogomark />);
    expect(container.querySelector("linearGradient#oxagenEmber")).toBeInTheDocument();
  });

  it("renders a flat stroke (no gradient defs) for a mono tone", () => {
    const { container } = render(<OxagenLogomark tone="mono-light" />);
    expect(container.querySelector("linearGradient")).not.toBeInTheDocument();
  });

  it("accepts className via getAttribute", () => {
    const { getByRole } = render(<OxagenLogomark className="size-7" />);
    expect(getByRole("img").getAttribute("class")).toContain("size-7");
  });
});

describe("OxagenWordmark — render", () => {
  it("renders the Oxagen wordmark as text", () => {
    const { getByText } = render(<OxagenWordmark />);
    expect(getByText("Oxagen")).toBeInTheDocument();
  });

  it("uses the wordmark class", () => {
    const { getByText } = render(<OxagenWordmark className="text-xl" />);
    const el = getByText("Oxagen");
    expect(el.className).toContain("ox-wordmark");
    expect(el.className).toContain("text-xl");
  });

  it("applies a mono color when toned", () => {
    const { getByText } = render(<OxagenWordmark tone="mono-dark" />);
    // JSDOM normalizes the hex (#16181D) to its rgb() form.
    expect(getByText("Oxagen").style.color).toBe("rgb(22, 24, 29)");
  });
});

describe("BrandMark — render", () => {
  it("renders the ember brain SVG", () => {
    const { container } = render(<BrandMark />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("merges custom className onto the brain", () => {
    const { container } = render(<BrandMark className="custom-brand" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("custom-brand");
  });
});

describe("OxagenLockup — render", () => {
  it("renders both the brain SVG and the wordmark text", () => {
    const { container, getByText } = render(<OxagenLockup />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(getByText("Oxagen")).toBeInTheDocument();
  });

  it("merges custom className on lockup span", () => {
    const { container } = render(<OxagenLockup className="custom-lockup" />);
    expect((container.firstChild as HTMLElement).className).toContain("custom-lockup");
  });
});

describe("OxagenLogo — variants", () => {
  it("mark variant renders only the brain", () => {
    const { container, queryByText } = render(<OxagenLogo variant="mark" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(queryByText("Oxagen")).not.toBeInTheDocument();
  });

  it("horizontal variant renders brain + wordmark", () => {
    const { container, getByText } = render(<OxagenLogo variant="horizontal" size={40} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(getByText("Oxagen")).toBeInTheDocument();
  });

  it("vertical variant renders ring + wordmark", () => {
    const { container, getByText } = render(<OxagenLogo variant="vertical" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
    expect(getByText("Oxagen")).toBeInTheDocument();
  });
});

describe("NodeChip — render", () => {
  it("renders the id in a mono chip", () => {
    const { getByText } = render(<NodeChip kind="document" id="doc_41be09" />);
    expect(getByText("doc_41be09")).toBeInTheDocument();
  });

  it("renders an optional label", () => {
    const { getByText } = render(<NodeChip kind="user" id="prn_8fa21c" label="Ada" />);
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
    const { queryByText } = render(<ConfidenceBar score={0.5} showValue={false} />);
    expect(queryByText("50%")).not.toBeInTheDocument();
  });
});
