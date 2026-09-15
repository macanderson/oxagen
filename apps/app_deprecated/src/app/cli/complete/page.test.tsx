// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * page.test.tsx — /cli/complete renders the completion card without a session.
 */
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("@/components/ui/brand", () => ({
  OxagenWordmark: ({ className }: { className?: string }) => (
    <span data-testid="wordmark" className={className} />
  ),
}));

import CliLoginCompletePage, { metadata } from "./page";

afterEach(cleanup);

describe("/cli/complete", () => {
  it("tells the user the CLI has its token and the tab can close", () => {
    render(<CliLoginCompletePage />);
    expect(
      screen.getByRole("heading", { name: "Login complete" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/close this tab and return to your terminal/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("wordmark")).toBeInTheDocument();
  });

  it("titles the tab so the browser history reads correctly", () => {
    expect(metadata.title).toBe("Login complete");
  });
});
