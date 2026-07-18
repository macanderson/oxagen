// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { ReviewLinks } from "./review-links";

afterEach(cleanup);

describe("ReviewLinks", () => {
  it("renders the three review-surface links with workspace-scoped hrefs", () => {
    render(<ReviewLinks orgSlug="acme" workspaceSlug="prod" />);

    expect(screen.getByTestId("overview-review-links")).toBeInTheDocument();

    const inference = screen.getByRole("link", {
      name: /review inferred edges/i,
    });
    expect(inference).toHaveAttribute("href", "/acme/prod/knowledge/inference");

    const memories = screen.getByRole("link", { name: /review memories/i });
    expect(memories).toHaveAttribute("href", "/acme/prod/knowledge/memory");

    const sessions = screen.getByRole("link", { name: /open sessions/i });
    expect(sessions).toHaveAttribute("href", "/acme/prod/sessions");
  });
});
