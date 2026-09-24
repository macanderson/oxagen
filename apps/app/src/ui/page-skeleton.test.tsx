// @vitest-environment jsdom
// The shared page skeleton: the design's shape (four 64px tiles, a panel with
// a 22px by 180px title bar and seven 38px rows), the shimmer on every bone,
// and a busy landmark with a hidden label and no `id`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { PageLoading } from "./page-skeleton";

afterEach(cleanup);

describe("PageLoading", () => {
  it("draws four tiles, a title bar and seven rows, all shimmering", async () => {
    const { container } = render(
      <IntlProvider>
        <PageLoading />
      </IntlProvider>,
    );
    const tiles = screen.getAllByTestId("skeleton-tile");
    expect(tiles).toHaveLength(4);
    for (const tile of tiles)
      expect(tile).toHaveClass("sk", "h-16", "rounded-[11px]");
    expect(screen.getByTestId("skeleton-title")).toHaveClass(
      "sk",
      "h-[22px]",
      "w-[180px]",
      "rounded-[7px]",
    );
    const rows = screen.getAllByTestId("skeleton-row");
    expect(rows).toHaveLength(7);
    for (const row of rows)
      expect(row).toHaveClass("sk", "h-[38px]", "rounded-[9px]");
    for (const bone of container.querySelectorAll(".sk"))
      expect(bone).toHaveClass("motion-reduce:animate-none");
    await expectNoAxe(container);
  });

  it("marks the page busy with a hidden label, and takes no main id", () => {
    const { container } = render(
      <IntlProvider>
        <PageLoading />
      </IntlProvider>,
    );
    const main = container.querySelector("main");
    expect(main).toHaveAttribute("aria-busy", "true");
    expect(main).not.toHaveAttribute("id");
    expect(container.querySelector("#main")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });
});

describe("the shimmer in globals.css", () => {
  const css = readFileSync(
    join(process.cwd(), "src/app/globals.css"),
    "utf8",
  ).replace(/\s+/g, " ");

  it("sweeps a panel band across the highlight every 1.5 seconds", () => {
    expect(css).toContain(
      "background: linear-gradient( 90deg, var(--hl) 25%, var(--panel) 50%, var(--hl) 75% );",
    );
    expect(css).toContain("background-size: 220% 100%;");
    expect(css).toContain("animation: shim 1.5s linear infinite;");
    expect(css).toMatch(
      /@keyframes shim \{ from \{ background-position: 130% 0; \} to \{ background-position: -30% 0; \} \}/,
    );
  });

  it("stops under reduced motion", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{ \.sk \{ animation: none;/,
    );
  });

  it("puts the busy landmark in the page's frame", () => {
    expect(css).toContain(
      "[data-shell-page] :is(main#main, main[aria-busy]) { max-width: 1500px;",
    );
  });
});
