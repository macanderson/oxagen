// @vitest-environment jsdom
// The Steering header's own entry into a creation wizard (roadmap
// creation-spec §1): "Add a skill" on the Skills tab opens the skill wizard
// over the page. Every other tab's "Write a context record" stays hidden until
// the host carries the record wizard, so the header never offers a button
// that opens nothing.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREATE_EVENT } from "@/shared/create";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { SteeringCreate } from "./create-action";

function mount(searchParams: Record<string, string>) {
  return render(
    <IntlProvider>
      <SteeringCreate searchParams={searchParams} />
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

describe("SteeringCreate", () => {
  it("opens the skill wizard from the Skills tab", () => {
    const heard = vi.fn();
    window.addEventListener(CREATE_EVENT, heard);
    try {
      mount({ tab: "skills" });
      fireEvent.click(screen.getByRole("button", { name: "Add a skill" }));
      expect(heard).toHaveBeenCalledTimes(1);
      const event = heard.mock.calls[0]?.[0] as CustomEvent;
      expect(event.detail).toEqual({ kind: "skill" });
    } finally {
      window.removeEventListener(CREATE_EVENT, heard);
    }
  });

  it("offers no record button while the record wizard is not carried (negative)", () => {
    const tabs: Record<string, string>[] = [
      {},
      { tab: "proposals" },
      { tab: "prs" },
    ];
    for (const tab of tabs) {
      const { container } = mount(tab);
      expect(container.querySelector("button")).toBeNull();
      cleanup();
    }
  });
});
