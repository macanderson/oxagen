// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import {
  STELLA_GOLD,
  STELLA_ICON_MARK,
  STELLA_ICON_TRANSFORM,
  STELLA_ICON_VIEWBOX,
  STELLA_SHIMMER,
  STELLA_SPINNER_TRANSFORM,
  STELLA_WORDMARK_ACCENT,
  STELLA_WORDMARK_LETTERS,
  STELLA_WORDMARK_VIEWBOX,
  StellaIcon,
  StellaSpinner,
  StellaWordmark,
} from "./stella-mark";

afterEach(cleanup);

/** A file `sync-brand-assets.mjs` vendors from the house kit. */
function vendored(name: string): string {
  return readFileSync(join(process.cwd(), "public/brand", name), "utf8");
}

function attr(svg: string, pattern: RegExp): string {
  const found = pattern.exec(svg)?.[1];
  if (found === undefined) throw new Error(`no match for ${pattern.source}`);
  return found;
}

describe("the stella marks match the house kit", () => {
  const wordmark = vendored("stella-wordmark.svg");
  const icon = vendored("stella-icon.svg");

  it("draws the wordmark with the kit's letters, asterisk, gold and box", () => {
    expect(STELLA_WORDMARK_LETTERS).toBe(
      attr(wordmark, /class="letters" d="([^"]+)"/),
    );
    expect(STELLA_WORDMARK_ACCENT).toBe(
      attr(wordmark, /class="accent" d="([^"]+)"/),
    );
    expect(STELLA_GOLD).toBe(
      attr(wordmark, /class="accent" d="[^"]+" fill="([^"]+)"/),
    );
    expect(STELLA_WORDMARK_VIEWBOX).toBe(attr(wordmark, /viewBox="([^"]+)"/));
  });

  it("draws the icon with the kit's asterisk and placement", () => {
    expect(STELLA_ICON_MARK).toBe(attr(icon, /class="mark" d="([^"]+)"/));
    expect(STELLA_ICON_TRANSFORM).toBe(attr(icon, /<g transform="([^"]+)"/));
    expect(STELLA_ICON_VIEWBOX).toBe(attr(icon, /viewBox="([^"]+)"/));
    expect(STELLA_GOLD).toBe(
      attr(icon, /class="mark" d="[^"]+" fill="([^"]+)"/),
    );
  });
});

describe("StellaWordmark", () => {
  it("takes the letters' colour from the text around it, so the app theme reaches them", () => {
    const { container } = render(<StellaWordmark className="h-4" />);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[0]?.getAttribute("fill")).toBe("currentColor");
    expect(paths[1]?.getAttribute("fill")).toBe(STELLA_GOLD);
  });

  it("is hidden from assistive technology without a title", async () => {
    const { container } = render(<StellaWordmark />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("role")).toBeNull();
    await expectNoAxe(container);
  });

  it("is an image named by its title", async () => {
    const { getByRole, container } = render(<StellaWordmark title="stella" />);
    expect(getByRole("img", { name: "stella" })).toBeTruthy();
    await expectNoAxe(container);
  });
});

describe("StellaIcon", () => {
  it("draws the gold asterisk alone", async () => {
    const { container } = render(<StellaIcon title="stella" />);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.getAttribute("fill")).toBe(STELLA_GOLD);
    await expectNoAxe(container);
  });
});

describe("StellaSpinner", () => {
  it("draws the kit spinner: the gold asterisk turning, a light sweeping across it", () => {
    const { container } = render(<StellaSpinner />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("data-mark")).toBe("stella-spinner");
    expect(svg?.getAttribute("viewBox")).toBe(STELLA_ICON_VIEWBOX);
    // The kit's placement for the spinner, and the kit's shimmer colour.
    expect(STELLA_SPINNER_TRANSFORM).toBe(
      "translate(8.813,117.886) scale(1.11248)",
    );
    expect(STELLA_SHIMMER).toBe("#F1CE65");
    expect(
      container.querySelector(`g[transform="${STELLA_SPINNER_TRANSFORM}"]`),
    ).not.toBeNull();

    const turn = container.querySelector(".ox-stella-turn");
    expect(turn).not.toBeNull();
    const mark = turn?.querySelector(":scope > path");
    expect(mark?.getAttribute("d")).toBe(STELLA_ICON_MARK);
    expect(mark?.getAttribute("fill")).toBe(STELLA_GOLD);
    // The sweep is clipped to the same asterisk, so the light stays on it.
    expect(container.querySelector("clipPath path")?.getAttribute("d")).toBe(
      STELLA_ICON_MARK,
    );
    const stops = Array.from(container.querySelectorAll("stop"));
    expect(stops.map((s) => s.getAttribute("stop-color"))).toEqual([
      STELLA_SHIMMER,
      STELLA_SHIMMER,
      STELLA_SHIMMER,
    ]);
    expect(container.querySelector("rect.ox-stella-sweep")).not.toBeNull();
  });

  it("gives each spinner its own clip and gradient ids, so two on a page do not share one", () => {
    const { container } = render(
      <>
        <StellaSpinner />
        <StellaSpinner />
      </>,
    );
    const clips = Array.from(container.querySelectorAll("clipPath")).map(
      (c) => c.id,
    );
    const gradients = Array.from(
      container.querySelectorAll("linearGradient"),
    ).map((g) => g.id);
    expect(new Set(clips).size).toBe(2);
    expect(new Set(gradients).size).toBe(2);
    // Each sweep points at its own spinner's gradient and clip.
    const svgs = container.querySelectorAll("svg");
    svgs.forEach((svg) => {
      const gradient = svg.querySelector("linearGradient")?.id ?? "";
      const clip = svg.querySelector("clipPath")?.id ?? "";
      expect(gradient).toMatch(/^stella-spin-sweep-[\w-]+$/);
      expect(svg.querySelector("rect")?.getAttribute("fill")).toBe(
        `url(#${gradient})`,
      );
      expect(svg.querySelector("g[clip-path]")?.getAttribute("clip-path")).toBe(
        `url(#${clip})`,
      );
    });
  });

  it("is hidden from assistive technology without a title, and named by one", async () => {
    const hidden = render(<StellaSpinner />);
    expect(
      hidden.container.querySelector("svg")?.getAttribute("aria-hidden"),
    ).toBe("true");
    await expectNoAxe(hidden.container);
    cleanup();

    const { getByRole, container } = render(
      <StellaSpinner title="stella is thinking" />,
    );
    expect(getByRole("img", { name: "stella is thinking" })).toBeTruthy();
    await expectNoAxe(container);
  });
});
