// @vitest-environment jsdom
// The Steering header's own entry into a creation wizard (roadmap
// creation-spec §1): "Add a skill" on the Skills tab opens the skill wizard
// over the page, and every other tab's "Write a context record" opens the
// context-record wizard. Each tab carries exactly one of the two.
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
      const event: unknown = heard.mock.calls[0]?.[0];
      expect(event).toBeInstanceOf(CustomEvent);
      expect(event).toHaveProperty("detail", { kind: "skill" });
    } finally {
      window.removeEventListener(CREATE_EVENT, heard);
    }
  });

  it("opens the context-record wizard from every tab but Skills", () => {
    const tabs: Record<string, string>[] = [
      {},
      { tab: "records" },
      { tab: "proposals" },
      { tab: "prs" },
    ];
    const heard = vi.fn();
    window.addEventListener(CREATE_EVENT, heard);
    try {
      for (const tab of tabs) {
        const { container } = mount(tab);
        expect(container.querySelectorAll("button")).toHaveLength(1);
        fireEvent.click(
          screen.getByRole("button", { name: "Write a context record" }),
        );
        cleanup();
      }
      expect(heard).toHaveBeenCalledTimes(tabs.length);
      for (const [event] of heard.mock.calls)
        expect(event).toHaveProperty("detail", { kind: "record" });
    } finally {
      window.removeEventListener(CREATE_EVENT, heard);
    }
  });

  it("offers no record button on the Skills tab (negative)", () => {
    mount({ tab: "skills" });
    expect(
      screen.queryByRole("button", { name: "Write a context record" }),
    ).toBeNull();
  });
});
