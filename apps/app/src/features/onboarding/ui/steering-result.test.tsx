// @vitest-environment jsdom
// The line a GitHub install leaves on Connect a code host and on Create the
// first workspace: which queries name a result, the reason a query may carry
// and the one it may not, and the three lines the result draws. Axe runs
// after every test.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  parseSteeringResult,
  type SteeringResult,
  SteeringResultLine,
} from "./steering-result";

function renderLine(result: SteeringResult | null) {
  return render(
    <IntlProvider>
      <SteeringResultLine result={result} />
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

describe("parseSteeringResult", () => {
  it("reads a connected install", () => {
    expect(parseSteeringResult("connected", null)).toEqual({
      kind: "connected",
    });
    expect(parseSteeringResult("connected", "ignored")).toEqual({
      kind: "connected",
    });
  });

  it("reads a refused install with its reason", () => {
    expect(parseSteeringResult("error", "installation_denied")).toEqual({
      kind: "error",
      code: "installation_denied",
    });
  });

  it("drops a reason that is not a short snake_case word (negative)", () => {
    expect(parseSteeringResult("error", "<script>")).toEqual({
      kind: "error",
      code: null,
    });
    expect(parseSteeringResult("error", "a".repeat(65))).toEqual({
      kind: "error",
      code: null,
    });
    expect(parseSteeringResult("error", "Denied")).toEqual({
      kind: "error",
      code: null,
    });
    expect(parseSteeringResult("error", undefined)).toEqual({
      kind: "error",
      code: null,
    });
  });

  it("names no result for a query that names none (negative)", () => {
    expect(parseSteeringResult(null, null)).toBeNull();
    expect(parseSteeringResult(undefined, "installation_denied")).toBeNull();
    expect(parseSteeringResult("pending", null)).toBeNull();
  });
});

describe("SteeringResultLine", () => {
  it("says GitHub is connected as a status", () => {
    renderLine({ kind: "connected" });
    expect(screen.getByTestId("steering-connected")).toHaveTextContent(
      "GitHub is connected.",
    );
    expect(screen.getByRole("status")).toBe(
      screen.getByTestId("steering-connected"),
    );
    expect(screen.queryByTestId("steering-error")).toBeNull();
  });

  it("names the reason GitHub refused as an alert", () => {
    renderLine({ kind: "error", code: "installation_denied" });
    expect(screen.getByTestId("steering-error")).toHaveTextContent(
      "GitHub did not connect (installation_denied). Install the app again.",
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("says GitHub did not connect when the query carried no reason", () => {
    renderLine({ kind: "error", code: null });
    expect(screen.getByTestId("steering-error")).toHaveTextContent(
      "GitHub did not connect. Install the app again.",
    );
  });

  it("draws nothing when the query names no result (negative)", () => {
    const { container } = renderLine(null);
    expect(container).toBeEmptyDOMElement();
  });
});
