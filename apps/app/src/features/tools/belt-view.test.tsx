// @vitest-environment jsdom
// One open toolbelt (ADR-192): a custom belt's server and tool edits through
// update_toolbelt and its delete, the All tools belt's availability and
// defaults through set_tool_state for an admin, and a read-only belt for
// anyone else. Each write refreshes the page on success and names its refusal
// otherwise. axe checks the state each test ends in (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolbeltDetail } from "@/data/contracts/toolbelts";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const actions = vi.hoisted(() => ({
  cloneToolbelt: vi.fn(),
  updateToolbelt: vi.fn(),
  deleteToolbelt: vi.fn(),
  setToolState: vi.fn(),
}));
vi.mock("./actions", () => actions);

const { BeltView } = await import("./belt-view");
const { toolbeltDetail } = await import("./tools.builders");

const at = { org: "acme", ws: "core-platform" };
const carrier = { id: "agt_macclaude", name: "Mac Claude", slug: "mac-claude" };

function renderBelt(detail: ToolbeltDetail, canEdit: boolean) {
  return render(
    <IntlProvider>
      <BeltView at={at} detail={detail} canEdit={canEdit} />
    </IntlProvider>,
  );
}

/** The group a server heads, by its `data-server` key. */
function group(key: string) {
  const node = document.querySelector(`[data-server="${key}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`no group ${key}`);
  return within(node);
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  for (const fn of Object.values(router)) fn.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("BeltView › a custom belt, edited by an admin", () => {
  it("heads the belt with its slug and source, and groups every server", () => {
    renderBelt(toolbeltDetail("custom"), true);
    const belt = screen.getByTestId("tools-belt");
    expect(
      within(belt).getByRole("heading", { level: 2, name: "Review belt" }),
    ).toBeVisible();
    expect(within(belt).getByText("Clone of All tools")).toBeVisible();
    expect(
      screen
        .getAllByTestId("belt-server")
        .map((node) => [
          node.getAttribute("data-server"),
          node.getAttribute("data-included"),
        ]),
    ).toEqual([
      ["mcs_github", "true"],
      ["mcs_linear", "false"],
      ["declared", "true"],
    ]);
    expect(group("mcs_linear").getByText("Not in this toolbelt")).toBeVisible();
  });

  it("turns one tool off in the belt and refreshes the page", async () => {
    actions.updateToolbelt.mockResolvedValue({
      ok: true,
      value: { id: "tbt_reviewbelt" },
    });
    renderBelt(toolbeltDetail("custom"), true);
    const toggle = screen.getByLabelText("create_issue on in this toolbelt");
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(actions.updateToolbelt).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "tbt_reviewbelt",
      [{ op: "set_tool_active", toolId: "tol_createissue", active: false }],
    );
  });

  it("shows an unavailable tool as such and offers no way to turn it on", () => {
    renderBelt(toolbeltDetail("custom"), true);
    expect(group("declared").getByText("Unavailable")).toBeVisible();
    expect(
      screen.getByLabelText("summarize on in this toolbelt"),
    ).toBeDisabled();
  });

  it("names each group's region for its server, so a button's words need not repeat it", () => {
    renderBelt(toolbeltDetail("custom"), true);
    expect(screen.getByRole("region", { name: "github" })).toHaveAttribute(
      "data-server",
      "mcs_github",
    );
  });

  it.each([
    [
      "mcs_github",
      "Remove server",
      { op: "remove_server", serverId: "mcs_github" },
    ],
    [
      "mcs_github",
      "Turn all on",
      { op: "set_server_active", serverId: "mcs_github", active: true },
    ],
    [
      "declared",
      "Turn all off",
      { op: "set_server_active", serverId: null, active: false },
    ],
    [
      "mcs_linear",
      "Add server",
      { op: "add_server", serverId: "mcs_linear", active: true },
    ],
  ] as const)("on %s, %s sends one change", async (key, label, change) => {
    actions.updateToolbelt.mockResolvedValue({
      ok: true,
      value: { id: "tbt_reviewbelt" },
    });
    renderBelt(toolbeltDetail("custom"), true);
    fireEvent.click(group(key).getByRole("button", { name: label }));
    await waitFor(() => {
      expect(actions.updateToolbelt).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "tbt_reviewbelt",
        [change],
      );
    });
  });

  it("names a refused edit and leaves the page as it was", async () => {
    actions.updateToolbelt.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "tool_unavailable",
    });
    renderBelt(toolbeltDetail("custom"), true);
    fireEvent.click(screen.getByLabelText("delete_repo on in this toolbelt"));
    expect(await screen.findByTestId("belt-failure")).toHaveTextContent(
      "That tool is unavailable in this workspace, so no toolbelt can turn it on. Nothing was changed.",
    );
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("says a write went unanswered when the action throws", async () => {
    actions.updateToolbelt.mockRejectedValue(new Error("network"));
    renderBelt(toolbeltDetail("custom"), true);
    fireEvent.click(screen.getByLabelText("create_issue on in this toolbelt"));
    expect(await screen.findByTestId("belt-failure")).toHaveTextContent(
      "Could not be recorded (action_failed).",
    );
  });

  it("deletes a belt no agent carries and goes back to the list", async () => {
    actions.deleteToolbelt.mockResolvedValue({
      ok: true,
      value: { id: "tbt_reviewbelt" },
    });
    renderBelt(toolbeltDetail("custom"), true);
    fireEvent.click(screen.getByTestId("belt-delete"));
    const dialog = within(await screen.findByTestId("belt-delete-dialog"));
    fireEvent.click(dialog.getByTestId("belt-delete-confirm"));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(
        "/acme/core-platform/tools/toolbelts",
      );
    });
    expect(actions.deleteToolbelt).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "tbt_reviewbelt",
    );
  });

  it("names a refused delete in the dialog", async () => {
    actions.deleteToolbelt.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "toolbelt_in_use",
    });
    renderBelt(toolbeltDetail("custom"), true);
    fireEvent.click(screen.getByTestId("belt-delete"));
    const dialog = within(await screen.findByTestId("belt-delete-dialog"));
    fireEvent.click(dialog.getByTestId("belt-delete-confirm"));
    expect(await dialog.findByTestId("belt-delete-failure")).toHaveTextContent(
      "An agent still carries this toolbelt. Give it another toolbelt first. Nothing was changed.",
    );
  });

  it("offers no delete while an agent carries the belt, and says why", async () => {
    renderBelt(toolbeltDetail("custom", [carrier]), true);
    fireEvent.click(screen.getByTestId("belt-delete"));
    const dialog = within(await screen.findByTestId("belt-delete-dialog"));
    expect(dialog.getByTestId("belt-delete-in-use")).toHaveTextContent(
      "1 agent carries this toolbelt. Give each one another toolbelt first.",
    );
    expect(dialog.queryByTestId("belt-delete-confirm")).not.toBeInTheDocument();
  });

  it("links each agent carrying the belt", () => {
    renderBelt(toolbeltDetail("custom", [carrier]), true);
    expect(
      within(screen.getByTestId("belt-agent")).getByRole("link", {
        name: "Mac Claude",
      }),
    ).toHaveAttribute("href", "/acme/core-platform/agents/mac-claude");
  });
});

describe("BeltView › the All tools belt", () => {
  it("says it follows the workspace's tool settings, and offers no delete", () => {
    renderBelt(toolbeltDetail("all_tools"), true);
    expect(screen.getByText(/It cannot be edited directly/)).toBeVisible();
    expect(screen.getByText(/A tool you make unavailable/)).toBeVisible();
    expect(screen.queryByTestId("belt-delete")).not.toBeInTheDocument();
  });

  it("sets one tool's default for an admin", async () => {
    actions.setToolState.mockResolvedValue({ ok: true, value: { updated: 1 } });
    renderBelt(toolbeltDetail("all_tools"), true);
    const toggle = screen.getByLabelText("delete_repo on by default");
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(actions.setToolState).toHaveBeenCalledWith("acme", "core-platform", {
      toolIds: ["tol_deleterepo"],
      defaultActive: true,
    });
  });

  it("makes one tool available for an admin", async () => {
    actions.setToolState.mockResolvedValue({ ok: true, value: { updated: 1 } });
    renderBelt(toolbeltDetail("all_tools"), true);
    fireEvent.click(screen.getByLabelText("summarize available to toolbelts"));
    await waitFor(() => {
      expect(actions.setToolState).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        { toolIds: ["tol_summarize"], available: true },
      );
    });
  });

  it("makes every tool of a server unavailable at once", async () => {
    actions.setToolState.mockResolvedValue({ ok: true, value: { updated: 2 } });
    renderBelt(toolbeltDetail("all_tools"), true);
    fireEvent.click(
      group("mcs_github").getByRole("button", { name: "Make all unavailable" }),
    );
    await waitFor(() => {
      expect(actions.setToolState).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        { serverId: "mcs_github", available: false },
      );
    });
  });
});

describe("BeltView › read only", () => {
  it("shows each tool on or off and offers no control", () => {
    renderBelt(toolbeltDetail("custom"), false);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    const tool = document.querySelector('[data-tool="tol_createissue"]');
    if (!(tool instanceof HTMLElement)) throw new Error("no tool row");
    expect(within(tool).getByText("On")).toBeVisible();
    expect(screen.queryByText(/A tool you make unavailable/)).toBeNull();
  });

  it("points an empty workspace at Providers", () => {
    const empty = { ...toolbeltDetail("all_tools"), groups: [] };
    renderBelt(empty, false);
    expect(
      within(screen.getByTestId("belt-empty")).getByRole("link", {
        name: "Open Providers",
      }),
    ).toHaveAttribute("href", "/acme/core-platform/tools/providers");
    expect(screen.getByText("No agent carries this toolbelt.")).toBeVisible();
  });
});
