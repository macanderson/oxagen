// @vitest-environment jsdom
/**
 * not-found.test.tsx — render coverage for the shared 404 surface, including
 * the default vs custom homeHref branch.
 */
import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { NotFoundPage } from "./not-found";

afterEach(cleanup);

describe("NotFoundPage", () => {
  it("renders the 404 surface and defaults the home link to /", () => {
    const { getByText, getByRole } = render(<NotFoundPage />);
    expect(getByText("404")).toBeInTheDocument();
    expect(getByText("Page not found")).toBeInTheDocument();
    expect(getByRole("link", { name: "Back to home" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("uses a custom homeHref when provided", () => {
    const { getByRole } = render(<NotFoundPage homeHref="/acme/dashboard" />);
    expect(getByRole("link", { name: "Back to home" })).toHaveAttribute(
      "href",
      "/acme/dashboard",
    );
  });
});
