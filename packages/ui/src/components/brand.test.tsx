// @vitest-environment jsdom
/**
 * brand.test.tsx — render tests for the house marks.
 *
 * These lock down the rules the brand system cannot enforce by review alone:
 * the geometry is the kit's (not hand-edited), exactly ONE glyph is gold, an
 * icon is one colour, and NO component composes Oxagen's mark beside its word.
 *
 * Note: SVG elements in JSDOM expose className as SVGAnimatedString, not a
 * plain string — use getAttribute("class").
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import {
  OxagenWordmark,
  OxagenIcon,
  StellaWordmark,
  StellaIcon,
  BrandMark,
  NodeChip,
  ConfidenceBar,
} from "./brand";
import * as brand from "./brand";
import { BRAND_GOLD, OXAGEN, STELLA } from "./brand-marks.generated";

afterEach(cleanup);

/**
 * The kit's pinned gold. If this ever changes the kit changed, and every asset
 * in the repo has to be re-synced with it — the generated module and the CSS
 * token file must not disagree.
 */
describe("the metal", () => {
  it("is the house gold", () => {
    expect(BRAND_GOLD).toBe("#D6962C");
  });
});

describe("OxagenWordmark — THE Oxagen logo", () => {
  it("renders an SVG labelled with the word", () => {
    const { getByRole } = render(<OxagenWordmark />);
    expect(getByRole("img", { name: "oxagen" })).toBeInTheDocument();
  });

  it("keeps the kit's own viewBox rather than re-fitting the word", () => {
    const { getByRole } = render(<OxagenWordmark />);
    expect(getByRole("img").getAttribute("viewBox")).toBe(OXAGEN.wordmark.viewBox);
  });

  it("draws exactly two paths: the letters, and the one gold glyph", () => {
    const { container } = render(<OxagenWordmark />);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[0]?.getAttribute("fill")).toBe("currentColor");
    expect(paths[1]?.getAttribute("fill")).toBe(BRAND_GOLD);
  });

  it("keeps the metal on the x in BOTH themes — the accent is never theme-flipped", () => {
    const { container } = render(<OxagenWordmark />);
    const accent = container.querySelectorAll("path")[1];
    expect(accent?.getAttribute("fill")).not.toContain("var(");
  });

  it("flattens the gold to currentColor for a mono tone", () => {
    const { container } = render(<OxagenWordmark tone="mono" />);
    for (const path of container.querySelectorAll("path")) {
      expect(path.getAttribute("fill")).toBe("currentColor");
    }
  });

  /**
   * A wordmark is far wider than it is tall, so it must be sized by HEIGHT.
   * A square utility would letterbox it to a fraction of its box.
   */
  it("sizes by height, not into a square box", () => {
    const { getByRole } = render(<OxagenWordmark />);
    const cls = getByRole("img").getAttribute("class") ?? "";
    expect(cls).toContain("h-7");
    expect(cls).toContain("w-auto");
    expect(cls).not.toContain("size-7");
  });

  it("accepts a caller className", () => {
    const { getByRole } = render(<OxagenWordmark className="h-10" />);
    expect(getByRole("img").getAttribute("class")).toContain("h-10");
  });
});

describe("OxagenIcon — the one-colour Ox lettermark", () => {
  it("renders a single path that takes the colour of what it sits on", () => {
    const { container } = render(<OxagenIcon />);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.getAttribute("fill")).toBe("currentColor");
  });

  it("never carries the metal — the gold belongs to the x of the word", () => {
    const { container } = render(<OxagenIcon />);
    expect(container.innerHTML).not.toContain(BRAND_GOLD);
  });

  it("keeps the kit's 96-unit box and its fitting transform", () => {
    const { getByRole, container } = render(<OxagenIcon />);
    expect(getByRole("img").getAttribute("viewBox")).toBe(OXAGEN.icon.viewBox);
    expect(container.querySelector("g")?.getAttribute("transform")).toBe(
      OXAGEN.icon.transform,
    );
  });
});

describe("StellaWordmark — the mark is inside the word", () => {
  it("renders the letters plus the gold asterisk", () => {
    const { container, getByRole } = render(<StellaWordmark />);
    expect(getByRole("img", { name: "stella" })).toBeInTheDocument();
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[1]?.getAttribute("fill")).toBe(BRAND_GOLD);
  });

  it("keeps the kit's viewBox", () => {
    const { getByRole } = render(<StellaWordmark />);
    expect(getByRole("img").getAttribute("viewBox")).toBe(STELLA.wordmark.viewBox);
  });
});

describe("StellaIcon — the asterisk IS the metal", () => {
  it("ships gold, unlike the Ox lettermark", () => {
    const { container } = render(<StellaIcon />);
    expect(container.querySelector("path")?.getAttribute("fill")).toBe(BRAND_GOLD);
  });

  it("flattens for a mono tone", () => {
    const { container } = render(<StellaIcon tone="mono" />);
    expect(container.querySelector("path")?.getAttribute("fill")).toBe(
      "currentColor",
    );
  });
});

describe("BrandMark — the icon at the app-chrome size", () => {
  it("renders the Ox lettermark", () => {
    const { getByRole } = render(<BrandMark />);
    expect(getByRole("img", { name: "Oxagen" })).toBeInTheDocument();
  });

  it("merges a custom className", () => {
    const { getByRole } = render(<BrandMark className="custom-brand" />);
    expect(getByRole("img").getAttribute("class")).toContain("custom-brand");
  });
});

/**
 * The rule the product must not be able to break by accident: Oxagen's logo is
 * the wordmark, so nothing in this module may hand a caller a composed lockup.
 * If someone re-adds one, this fails before a reviewer has to notice.
 */
describe("no Oxagen lockup exists", () => {
  it("exports no lockup or composed-logo component", () => {
    for (const name of Object.keys(brand)) {
      expect(name.toLowerCase()).not.toContain("lockup");
    }
    expect(brand).not.toHaveProperty("OxagenLogo");
    expect(brand).not.toHaveProperty("OxagenLogomark");
  });

  it("renders no component that puts the Ox mark and the word together", () => {
    const { container } = render(
      <>
        <OxagenWordmark />
        <OxagenIcon />
      </>,
    );
    // Two separate roots, deliberately composed by the TEST — no export does
    // this for a caller.
    expect(container.querySelectorAll("svg")).toHaveLength(2);
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
