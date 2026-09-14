// @vitest-environment jsdom
/**
 * spinner-assets.test.tsx — asset-path and error-fallback tests for PwaSplash
 * and RouteTransitionLoader.
 *
 * The spinner <img> elements are decorative (alt="" + aria-hidden), so they are
 * NOT exposed with role="img" to the a11y tree — query them via the DOM
 * (querySelectorAll) rather than getByRole.
 *
 * Covers:
 *   - PwaSplash <img> src values use /spinner/ (the real asset dir), never /pwa/
 *   - The splash renders ONE spinner, not a per-theme pair: the house asset
 *     carries its own light/dark and reduced-motion rules
 *   - An image load error swaps the spinner for the pure-CSS ring fallback
 *   - RouteTransitionLoader never emits a /pwa/ src
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { PwaSplash } from "./pwa-splash";
import { RouteTransitionLoader } from "./route-transition-loader";

afterEach(cleanup);

// usePathname is the only next/navigation hook these components use; keep a
// mutable ref so RouteTransitionLoader can observe a pathname change.
let currentPathname = "/initial";
vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
}));

describe("PwaSplash — spinner asset paths", () => {
  it("renders one spinner <img> using /spinner/ and never /pwa/", () => {
    const { container } = render(<PwaSplash />);
    const imgs = Array.from(container.querySelectorAll("img"));
    // ONE asset: the house spinner adapts to the colour scheme from inside the
    // file, so there is no dark/light pair to render.
    expect(imgs).toHaveLength(1);
    for (const img of imgs) {
      const src = img.getAttribute("src") ?? "";
      expect(src).toContain("/spinner/");
      expect(src).not.toContain("/pwa/");
    }
  });

  it("points at the house spinner asset", () => {
    const { container } = render(<PwaSplash />);
    const srcs = Array.from(container.querySelectorAll("img")).map((i) =>
      i.getAttribute("src"),
    );
    expect(srcs).toContain("/spinner/oxagen-spinner.svg");
  });
});

describe("PwaSplash — CSS fallback on image error", () => {
  it("swaps the spinner for the pure-CSS ring when the asset fails to load", () => {
    const { container } = render(<PwaSplash />);
    const firstImg = container.querySelector("img");
    expect(firstImg).not.toBeNull();

    // fireEvent.error triggers React's onError synthetic handler reliably.
    act(() => {
      fireEvent.error(firstImg as HTMLImageElement);
    });

    // imgs are gone; the decorative CSS ring (<span>) is rendered instead, so a
    // missing/renamed asset can never surface the broken-image placeholder.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("span")).not.toBeNull();
  });
});

describe("RouteTransitionLoader — spinner asset paths", () => {
  it("never embeds a /pwa/ src; any rendered img uses /spinner/", () => {
    currentPathname = "/page-a";
    const { rerender, container } = render(<RouteTransitionLoader />);

    // A pathname change is what makes the loader visible.
    act(() => {
      currentPathname = "/page-b";
    });
    rerender(<RouteTransitionLoader />);

    // A pathname change makes the loader visible, so it MUST have rendered its
    // spinner. Asserting the count first keeps the src checks below from
    // passing vacuously on an empty NodeList if the loader ever stops
    // rendering.
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      const src = img.getAttribute("src") ?? "";
      expect(src).not.toContain("/pwa/");
      expect(src).toContain("/spinner/");
    }
  });
});
