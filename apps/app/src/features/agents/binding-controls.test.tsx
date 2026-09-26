// @vitest-environment jsdom
// The agent's two binding writes drawn on their own (ADR-192): the toolbelt
// picker saves another belt, the runtime picker moves the agent, each names
// the version it wrote and refreshes the page, a refusal is named and changes
// nothing, and a viewer who may not write sees the binding and no control.
// Axe runs after every test (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { ALL_TOOLS, BUILD_BOX, beltList, runtimeList } from "./agents.builders";

const { moveAgent, assignAgentToolbelt, refresh } = vi.hoisted(() => ({
  moveAgent: vi.fn(),
  assignAgentToolbelt: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));
vi.mock("./actions", () => ({ moveAgent, assignAgentToolbelt }));

const { RuntimeMove, ToolbeltChoice } = await import("./binding-controls");

const PLACE = { org: "acme", ws: "core-platform", agent: "release-bot" };

beforeEach(() => {
  moveAgent.mockReset();
  assignAgentToolbelt.mockReset();
  refresh.mockReset();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

function renderBelt(canChange = true) {
  render(
    <IntlProvider>
      <ToolbeltChoice
        place={PLACE}
        current={ALL_TOOLS}
        belts={beltList()}
        canChange={canChange}
      />
    </IntlProvider>,
  );
}

function renderMove(canMove = true) {
  render(
    <IntlProvider>
      <RuntimeMove
        place={PLACE}
        agentId="agt_releasebot"
        harness="claude-code"
        current={BUILD_BOX}
        runtimes={runtimeList()}
        canMove={canMove}
      />
    </IntlProvider>,
  );
}

describe("ToolbeltChoice", () => {
  it("links to the Toolbelts tab and saves another belt as a new version", async () => {
    assignAgentToolbelt.mockResolvedValue({ ok: true, value: { version: 2 } });
    renderBelt();
    expect(
      screen.getByRole("link", { name: "Manage toolbelts" }),
    ).toHaveAttribute("href", "/acme/core-platform/tools/toolbelts");
    const save = screen.getByTestId("agent-belt-save");
    // The belt it carries is chosen, so Save has nothing to write yet.
    expect(save).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("radio", { name: /Review belt/ }));
    expect(save).not.toHaveAttribute("aria-disabled");
    fireEvent.click(save);
    expect(await screen.findByTestId("agent-belt-done")).toHaveTextContent(
      "Saved as version 2.",
    );
    expect(assignAgentToolbelt).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "release-bot",
      "tbt_reviewbelt",
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("names a refusal and refreshes nothing (negative)", async () => {
    assignAgentToolbelt.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "same_toolbelt",
    });
    renderBelt();
    fireEvent.click(screen.getByRole("radio", { name: /Review belt/ }));
    fireEvent.click(screen.getByTestId("agent-belt-save"));
    expect(await screen.findByTestId("agent-belt-failure")).toHaveTextContent(
      "The agent already carries that toolbelt. Nothing was changed.",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows the belt and who can change it to a viewer who may not (negative)", () => {
    renderBelt(false);
    expect(screen.getByTestId("agent-belt-current")).toHaveTextContent(
      "It carries All tools.",
    );
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(
      screen.getByText("An organization owner or admin can change it."),
    ).toBeInTheDocument();
  });

  it("names a belt read that failed and offers no picker (negative)", () => {
    render(
      <IntlProvider>
        <ToolbeltChoice
          place={PLACE}
          current={null}
          belts={readError("toolbelts_unavailable", 503)}
          canChange
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("agent-belt-current")).toHaveTextContent(
      "It carries no toolbelt yet.",
    );
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByTestId("agent-belt-choice")).toHaveTextContent(
      "toolbelts_unavailable",
    );
  });
});

describe("RuntimeMove", () => {
  it("disables the runtime it is on and one already running its harness, and moves it to a free one", async () => {
    moveAgent.mockResolvedValue({
      ok: true,
      value: { version: 3, revokedHosts: 1 },
    });
    renderMove();
    const group = screen.getByRole("radiogroup", { name: "Runtime placement" });
    expect(
      within(group).getByRole("radio", { name: /Build box/ }),
    ).toHaveAccessibleDescription("The agent runs here now.");
    expect(
      within(group).getByRole("radio", { name: /Mac's laptop/ }),
    ).toHaveAccessibleDescription(
      "Claude Code already runs on Mac's laptop as mac-claude.",
    );
    fireEvent.click(within(group).getByRole("radio", { name: /GPU box/ }));
    fireEvent.click(screen.getByTestId("agent-runtime-save"));
    expect(await screen.findByTestId("agent-runtime-done")).toHaveTextContent(
      "Moved as version 3. 1 host enrollment was revoked.",
    );
    expect(moveAgent).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "release-bot",
      "rtm_gpubox",
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("writes nothing until a runtime is chosen, and names a refusal (negative)", async () => {
    moveAgent.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "runtime_harness_taken",
    });
    renderMove();
    fireEvent.click(screen.getByTestId("agent-runtime-save"));
    expect(moveAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: /GPU box/ }));
    fireEvent.click(screen.getByTestId("agent-runtime-save"));
    expect(
      await screen.findByTestId("agent-runtime-failure"),
    ).toHaveTextContent(
      "Another agent already runs this harness on that runtime. Nothing was changed.",
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows where the agent runs and no control to a viewer who may not move it (negative)", () => {
    renderMove(false);
    expect(screen.getByTestId("agent-runtime-current")).toHaveTextContent(
      "It runs on Build box.",
    );
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
