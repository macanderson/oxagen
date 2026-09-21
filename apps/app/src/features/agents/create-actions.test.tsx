// @vitest-environment jsdom
// Agent IAM's header: New agent opens the agent wizard over the page, and
// Register an agent is a separate link to the flow that wraps an agent that
// already runs. The two stay distinct, and only New agent is gold.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREATE_EVENT, createRequestOf } from "@/shared/create";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import { buttonPrimary } from "@/ui/control-styles";
import { AgentsCreate } from "./create-actions";

const t = translator("agents.list.create");

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function mount() {
  render(
    <IntlProvider>
      <AgentsCreate org="acme" ws="core-platform" />
    </IntlProvider>,
  );
}

describe("AgentsCreate", () => {
  it("opens the agent wizard from New agent, the one gold action", () => {
    const seen = vi.fn((event: Event) => createRequestOf(event));
    window.addEventListener(CREATE_EVENT, seen);
    mount();
    const button = screen.getByRole("button", { name: t("newAgent") });
    expect(button.className).toBe(buttonPrimary);
    fireEvent.click(button);
    expect(seen.mock.results[0]?.value).toEqual({ kind: "agent" });
    window.removeEventListener(CREATE_EVENT, seen);
  });

  it("links Register an agent to its own flow, not to the wizard", () => {
    mount();
    const link = screen.getByTestId("agents-register");
    expect(link.textContent).toBe(t("register"));
    expect(link.getAttribute("href")).toBe(
      routes.register("acme", "core-platform", "name"),
    );
    expect(link.className).not.toContain("gold");
    expect(document.querySelectorAll('[data-create="agent"]')).toHaveLength(1);
  });
});
