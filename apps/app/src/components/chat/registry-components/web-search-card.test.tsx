// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import WebSearchCard from "./web-search-card";

// TruncatedText (the result snippet) measures scroll overflow via
// ResizeObserver, which isn't implemented in JSDOM.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(cleanup);

describe("WebSearchCard", () => {
  it("renders search results with external links, domain, and snippet", () => {
    render(
      <WebSearchCard
        output={{
          results: [
            {
              title: "USS Nautilus (SSN-571)",
              url: "https://www.wikipedia.org/USS_Nautilus",
              content:
                "The world's first operational nuclear-powered submarine.",
              score: 0.98,
            },
          ],
          totalResults: 1,
          searchId: "s_1",
        }}
      />,
    );
    expect(screen.getByText("Web search · 1 result")).toBeTruthy();
    const link = screen.getByText("USS Nautilus (SSN-571)").closest("a");
    expect(link?.getAttribute("href")).toBe(
      "https://www.wikipedia.org/USS_Nautilus",
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    // www. stripped from the displayed domain
    expect(screen.getByText("wikipedia.org")).toBeTruthy();
    expect(
      screen.getByText(
        "The world's first operational nuclear-powered submarine.",
      ),
    ).toBeTruthy();
  });

  it("renders an empty state", () => {
    render(
      <WebSearchCard
        output={{ results: [], totalResults: 0, searchId: "s_0" }}
      />,
    );
    expect(screen.getByText("No results.")).toBeTruthy();
  });
});
