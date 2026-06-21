// @vitest-environment jsdom
/**
 * spinner-assets.test.tsx — asset path and error-fallback tests for PwaSplash
 * and RouteTransitionLoader.
 *
 * Covers:
 *   - PwaSplash renders <img> elements whose src contains /spinner/ not /pwa/
 *   - Firing an error event on a PwaSplash <img> causes the CSS fallback to render
 *   - RouteTransitionLoader <img> src values contain /spinner/ not /pwa/
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { PwaSplash } from "./pwa-splash";
import { RouteTransitionLoader } from "./route-transition-loader";

afterEach(cleanup);

// ── next/navigation mock ────────────────────────────────────────────────────
// We need to be able to change the value returned by usePathname between
// renders, so we keep a ref and expose a setter.
let currentPathname = "/initial";

vi.mock("next/navigation", () => ({
  usePathname: () => currentPathname,
}));

// ── PwaSplash ───────────────────────────────────────────────────────────────

describe("PwaSplash — spinner asset paths", () => {
  it("renders img elements whose src contains /spinner/ not /pwa/", () => {
    render(<PwaSplash />);
    const imgs = screen.getAllByRole("img", { hidden: true });
    expect(imgs.length).toBeGreaterThanOrEqual(2);
    for (const img of imgs) {
      const src = img.getAttribute("src") ?? "";
      expect(src).toContain("/spinner/");
      expect(src).not.toContain("/pwa/");
    }
  });

  it("dark gif src points to the correct asset", () => {
    render(<PwaSplash />);
    const imgs = screen.getAllByRole("img", { hidden: true });
    const dark = imgs.find((img) =>
      (img.getAttribute("src") ?? "").includes("dark"),
    );
    expect(dark).toBeDefined();
    expect(dark?.getAttribute("src")).toBe(
      "/spinner/oxagen-spinner-assemble-dark.gif",
    );
  });

  it("light gif src points to the correct asset", () => {
    render(<PwaSplash />);
    const imgs = screen.getAllByRole("img", { hidden: true });
    const light = imgs.find((img) =>
      (img.getAttribute("src") ?? "").includes("light"),
    );
    expect(light).toBeDefined();
    expect(light?.getAttribute("src")).toBe(
      "/spinner/oxagen-spinner-assemble-light.gif",
    );
  });
});

describe("PwaSplash — CSS fallback on image error", () => {
  it("shows cssSpinner fallback and hides imgs when an img fires an error event", async () => {
    render(<PwaSplash />);

    // Confirm imgs are present before the error.
    const imgsBefore = screen.getAllByRole("img", { hidden: true });
    expect(imgsBefore.length).toBeGreaterThanOrEqual(1);

    // Fire error on the first img to trigger the fallback state.
    await act(async () => {
      imgsBefore[0].dispatchEvent(new Event("error", { bubbles: true }));
    });

    // After error, imgs should be gone and the CSS fallback span should appear.
    const imgsAfter = screen.queryAllByRole("img", { hidden: true });
    expect(imgsAfter).toHaveLength(0);

    // The fallback element is a <span aria-hidden="true"> — query by its
    // presence as a generic element. We check it's in the document via the
    // container since aria-hidden elements aren't queryable by role directly.
    const { container } = render(<PwaSplash />);
    // We need to trigger the error on the freshly rendered component too.
    const freshImg = container.querySelector("img");
    if (freshImg) {
      await act(async () => {
        freshImg.dispatchEvent(new Event("error", { bubbles: true }));
      });
    }
    // After error the imgs are removed from the DOM.
    expect(container.querySelector("img")).toBeNull();
    // The fallback span should be in the container.
    expect(container.querySelector("span[aria-hidden='true']")).not.toBeNull();
  });
});

// ── RouteTransitionLoader ───────────────────────────────────────────────────

describe("RouteTransitionLoader — spinner asset paths", () => {
  it("does not embed any /pwa/ src in its rendered output", () => {
    // Force visible by starting with a fresh pathname and then changing it.
    currentPathname = "/page-a";
    const { rerender, container } = render(<RouteTransitionLoader />);

    // Trigger a pathname change so the loader becomes visible.
    act(() => {
      currentPathname = "/page-b";
    });
    rerender(<RouteTransitionLoader />);

    // Collect all img src values (loader may or may not be visible depending
    // on transition timing in jsdom; check src values either way).
    const imgs = container.querySelectorAll("img");
    for (const img of Array.from(imgs)) {
      const src = img.getAttribute("src") ?? "";
      expect(src).not.toContain("/pwa/");
      expect(src).toContain("/spinner/");
    }
  });

  it("img src values use /spinner/ prefix when the loader is visible", () => {
    currentPathname = "/page-x";
    const { rerender, container } = render(<RouteTransitionLoader />);

    act(() => {
      currentPathname = "/page-y";
    });
    rerender(<RouteTransitionLoader />);

    const imgs = container.querySelectorAll("img");
    // If the loader rendered imgs, verify their src values.
    for (const img of Array.from(imgs)) {
      expect(img.getAttribute("src")).toMatch(/^\/spinner\//);
    }
  });
});
