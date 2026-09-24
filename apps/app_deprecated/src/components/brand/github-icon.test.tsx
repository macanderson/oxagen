// @vitest-environment jsdom
/**
 * github-icon.test.tsx — the local GitHub mark that replaced lucide-react's
 * removed brand icons.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { GithubIcon } from "./github-icon";

afterEach(cleanup);

describe("GithubIcon", () => {
  it("draws one path in the current text colour", () => {
    const { container } = render(<GithubIcon />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg?.querySelectorAll("path")).toHaveLength(1);
  });

  it("is hidden from assistive technology unless the caller says otherwise", () => {
    const { container, rerender } = render(<GithubIcon />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    rerender(<GithubIcon aria-hidden={false} aria-label="GitHub" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("false");
    expect(svg?.getAttribute("aria-label")).toBe("GitHub");
  });

  it("passes the caller's class through for sizing", () => {
    const { container } = render(<GithubIcon className="h-4 w-4" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toBe(
      "h-4 w-4",
    );
  });
});
