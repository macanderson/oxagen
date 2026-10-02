// @vitest-environment jsdom
// The steering connect's result page body (#5151): what a person sees when the
// browser that finished a GitHub install can't open the organization that
// started it. Each outcome says how the install ended and offers the way home,
// and none reads as "Page not found". Axe runs after every test.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { SteeringConnectResult } from "./steering-connect-result";
import type { SteeringResult } from "./steering-result";

function renderResult(result: SteeringResult | null) {
  return render(
    <IntlProvider>
      <SteeringConnectResult result={result} />
    </IntlProvider>,
  );
}

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("SteeringConnectResult", () => {
  it("says GitHub connected and how to see the connection", () => {
    renderResult({ kind: "connected" });
    const panel = screen.getByTestId("steering-connect-connected");
    expect(
      screen.getByRole("heading", { name: "GitHub connected" }),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent("Oxagen Connect is installed on GitHub.");
    expect(panel).toHaveTextContent(
      "sign out, then sign in with an account in that organization.",
    );
    expect(screen.getByRole("link", { name: "Go to Oxagen" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("names the reason the connection failed", () => {
    renderResult({ kind: "error", code: "store_failed" });
    expect(
      screen.getByRole("heading", { name: "GitHub connection failed" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("steering-connect-error")).toHaveTextContent(
      "GitHub didn't connect (store_failed).",
    );
  });

  it("says the connection failed when the query carried no reason", () => {
    renderResult({ kind: "error", code: null });
    const panel = screen.getByTestId("steering-connect-error");
    expect(panel).toHaveTextContent("GitHub didn't connect.");
    expect(panel).not.toHaveTextContent("()");
  });

  it("says there is no result when the query names none (negative)", () => {
    renderResult(null);
    expect(
      screen.getByRole("heading", { name: "No connection result" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("steering-connect-connected")).toBeNull();
    expect(screen.queryByTestId("steering-connect-error")).toBeNull();
  });

  it.each([
    { kind: "connected" },
    { kind: "error", code: "store_failed" },
    { kind: "error", code: null },
    null,
  ] satisfies (SteeringResult | null)[])(
    "never reads as a missing page (%o)",
    (result) => {
      renderResult(result);
      expect(document.body).not.toHaveTextContent("Page not found");
    },
  );
});
