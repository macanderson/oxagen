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
  STELLA_WORDMARK_ACCENT,
  STELLA_WORDMARK_LETTERS,
  STELLA_WORDMARK_VIEWBOX,
  StellaIcon,
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

describe("the Stella marks match the house kit", () => {
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
    const { getByRole, container } = render(<StellaWordmark title="Stella" />);
    expect(getByRole("img", { name: "Stella" })).toBeTruthy();
    await expectNoAxe(container);
  });
});

describe("StellaIcon", () => {
  it("draws the gold asterisk alone", async () => {
    const { container } = render(<StellaIcon title="Stella" />);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.getAttribute("fill")).toBe(STELLA_GOLD);
    await expectNoAxe(container);
  });
});
