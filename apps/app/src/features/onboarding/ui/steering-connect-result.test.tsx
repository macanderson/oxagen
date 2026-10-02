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

/** Stands in for the shell's sign-out button, which the page passes in. */
const signOut = (
  <button type="button" data-testid="sign-out-stub">
    Sign out
  </button>
);

function renderResult(result: SteeringResult | null) {
  return render(
    <IntlProvider>
      <SteeringConnectResult result={result} signOut={signOut} />
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
    expect(panel).toContainElement(screen.getByTestId("sign-out-stub"));
  });

  it("offers sign out on a failed connection too", () => {
    renderResult({ kind: "error", code: "store_failed" });
    expect(screen.getByTestId("steering-connect-error")).toContainElement(
      screen.getByTestId("sign-out-stub"),
    );
  });

  it("offers no sign out when there is no result", () => {
    renderResult(null);
    expect(screen.queryByTestId("sign-out-stub")).toBeNull();
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

  it.each([
    {
      code: "state_expired",
      body: "The link to connect GitHub expired before the install finished, so Oxagen didn't save the connection.",
    },
    {
      code: "state_invalid",
      body: "Oxagen couldn't read the link GitHub sent back, so it didn't save the connection.",
    },
  ])(
    "says to start again for $code and offers only the way home",
    ({ code, body }) => {
      renderResult({ kind: "error", code });
      const panel = screen.getByTestId("steering-connect-error");
      expect(
        screen.getByRole("heading", { name: "GitHub connection failed" }),
      ).toBeInTheDocument();
      expect(panel).toHaveTextContent(body);
      expect(panel).toHaveTextContent(
        "Start the connection again from your organization in Oxagen.",
      );
      // The link ran out or couldn't be read. That isn't about the account.
      expect(panel).not.toHaveTextContent("The account you're signed in with");
      expect(screen.queryByTestId("sign-out-stub")).toBeNull();
      expect(
        screen.getByRole("link", { name: "Go to Oxagen" }),
      ).toHaveAttribute("href", "/");
    },
  );

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
    { kind: "error", code: "state_expired" },
    { kind: "error", code: "state_invalid" },
    null,
  ] satisfies (SteeringResult | null)[])(
    "never reads as a missing page (%o)",
    (result) => {
      renderResult(result);
      expect(document.body).not.toHaveTextContent("Page not found");
    },
  );
});
