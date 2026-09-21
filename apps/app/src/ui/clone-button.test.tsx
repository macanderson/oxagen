// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { IntlProvider } from "@/test/intl";
import { CREATE_EVENT, createRequestOf } from "@/shared/create";
import { CloneButton } from "./clone-button";
afterEach(cleanup);
it("opens the workspace clone editor with the selected source", () => {
  const receive = vi.fn((event: Event) => createRequestOf(event));
  window.addEventListener(CREATE_EVENT, receive);
  try {
    render(
      <IntlProvider>
        <CloneButton kind="record" sourceRef="ctx.review" />
      </IntlProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));
    expect(receive).toHaveReturnedWith({
      kind: "record",
      cloneSourceRef: "ctx.review",
    });
  } finally {
    window.removeEventListener(CREATE_EVENT, receive);
  }
});
