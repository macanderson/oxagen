// @vitest-environment jsdom
// The root error page: it draws its own document on ink with inline styles,
// names the failure, hands Try again to Next's `retry`, and prints the digest
// as the trace id, or says none was recorded.
import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import GlobalError from "./global-error";

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe("GlobalError", () => {
  it("draws the error state on ink with the retry and the trace id", () => {
    const retry = vi.fn();
    const html = new DOMParser().parseFromString(
      renderToStaticMarkup(
        <GlobalError
          error={Object.assign(new Error("boom"), { digest: "1618033988" })}
          retry={retry}
        />,
      ),
      "text/html",
    );
    expect(html.body.getAttribute("style")).toContain(
      "background:#09090B",
    );
    expect(html.querySelector("main#main h1")?.textContent).toBe(
      "Something went wrong",
    );
    expect(html.querySelector("[role=alert]")?.textContent).toContain(
      "Oxagen hit an unexpected error.",
    );
    expect(
      html.querySelector("[data-testid=global-error-trace]")?.textContent,
    ).toBe("trace 1618033988 · region not recorded");
    expect(html.body.textContent).not.toContain("boom");
  });

  it("says no trace was recorded when the error carries no digest", () => {
    const html = renderToStaticMarkup(
      <GlobalError error={new Error("boom")} retry={vi.fn()} />,
    );
    expect(html).toContain("trace and region not recorded");
    expect(html).toContain('data-recorded="false"');
  });

  it("calls retry from Try again", () => {
    const retry = vi.fn();
    act(() => {
      root = createRoot(document);
      root.render(<GlobalError error={new Error("boom")} retry={retry} />);
    });
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Try again",
    );
    expect(button).toBeDefined();
    fireEvent.click(button as HTMLButtonElement);
    expect(retry).toHaveBeenCalledOnce();
  });
});
