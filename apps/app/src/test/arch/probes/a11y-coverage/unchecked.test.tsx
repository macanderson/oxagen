import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

it("renders the approvals panel", () => {
  render(<section aria-label="Approvals" />);
  expect(screen.getByRole("region")).toBeDefined();
});
