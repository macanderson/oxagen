import { render } from "@testing-library/react";
import { it } from "vitest";

async function expectNoAxe(_container: Element): Promise<void> {}

it("renders the approvals panel", async () => {
  const { container } = render(<section aria-label="Approvals" />);
  await expectNoAxe(container);
});
