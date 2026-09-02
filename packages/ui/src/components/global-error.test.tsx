// @vitest-environment jsdom
/**
 * global-error.test.tsx — render coverage for the self-contained top-level
 * crash boundary, including the reset action and the error.digest branch.
 */
import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach, vi } from "vitest";
import { GlobalErrorPage } from "./global-error";

afterEach(cleanup);

describe("GlobalErrorPage", () => {
  it("renders the fallback and calls reset when 'Try again' is clicked", async () => {
    const reset = vi.fn();
    const { getByText, getByRole } = render(
      <GlobalErrorPage error={new Error("boom")} reset={reset} />,
    );
    expect(getByText("Something went wrong")).toBeInTheDocument();
    await userEvent.click(getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("shows the error digest when present", () => {
    const error = Object.assign(new Error("x"), { digest: "DIGEST_ABC123" });
    const { getByText } = render(
      <GlobalErrorPage error={error} reset={() => {}} />,
    );
    expect(getByText("DIGEST_ABC123")).toBeInTheDocument();
  });

  it("omits the digest line when there is no digest", () => {
    const { queryByText } = render(
      <GlobalErrorPage error={new Error("x")} reset={() => {}} />,
    );
    expect(queryByText(/DIGEST/)).toBeNull();
  });
});
