import { render } from "@testing-library/react";
import { it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";

it("renders the approvals panel", async () => {
  const { container } = render(<section aria-label="Approvals" />);
  await expectNoAxe(container);
});
