// @vitest-environment jsdom
// Organization › Workspaces (pages/organization.md): the design's columns in
// order, the recorded name, slug and namespace, "not recorded" where
// `list_workspaces` has no value, the Governance chip that states the mode is
// not recorded with the namespace beneath it, Open only onto a workspace the
// viewer can enter, Edit and Archive only on a live workspace, the panel's
// Create a workspace, and the note. Checked with axe.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceList } from "@/data/contracts/org";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { workspaceRow } from "./organization.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  archiveWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  editWorkspace: vi.fn(),
}));

const { WorkspacesTab } = await import("./workspaces");

afterEach(cleanup);

const list: WorkspaceList = {
  workspaces: [
    workspaceRow(),
    workspaceRow({
      id: "wrk_1b2c3d4e5f6g7h8j9k0m1n",
      slug: "finops",
      namespace: "finops",
      name: "FinOps",
      role: null,
    }),
    workspaceRow({
      id: "wrk_2c3d4e5f6g7h8j9k0m1n2p",
      slug: "legacy",
      namespace: "legacy",
      name: "Legacy",
      archivedAt: "2026-06-01T00:00:00.000Z",
    }),
  ],
};

async function renderTab(value: WorkspaceList = list) {
  const view = render(
    <IntlProvider>
      <WorkspacesTab org="acme" workspaces={value} />
    </IntlProvider>,
  );
  await expectNoAxe(view.container);
  return view;
}

function row(id: string): HTMLElement {
  const found = document.querySelector(`[data-row="${id}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no row ${id}`);
  return found;
}

describe("Workspaces", () => {
  it("draws the panel with Create a workspace, the design's columns and the note", async () => {
    await renderTab();
    const panel = screen.getByRole("region", { name: "Workspaces" });
    const create = within(panel).getByRole("button", {
      name: "Create a workspace",
    });
    // The panel's create is plain: the header carries the one gold action.
    expect(create.className).not.toContain("bg-button-primary-bg");
    expect(
      within(within(panel).getByRole("table", { name: "Workspaces" }))
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual([
      "Workspace",
      "Main repo",
      "Production branch",
      "Linked repos",
      "Agents",
      "Owner",
      "Governance",
      "",
    ]);
    expect(panel).toHaveTextContent(
      "Changing which repository is main is an org-owner action with approval, recorded as a security event.",
    );
  });

  it("prints what list_workspaces records and says not recorded for the rest", async () => {
    await renderTab();
    const cells = within(row("wrk_0a1b2c3d4e5f6g7h8j9k0m")).getAllByRole(
      "cell",
    );
    expect(cells[0]).toHaveTextContent("Core platform");
    expect(cells[0]).toHaveTextContent("core-platform");
    for (const index of [1, 2, 3, 4, 5]) {
      expect(cells[index]).toHaveTextContent("not recorded");
    }
    // The governance cell names the issues that would back it.
    expect(cells[6]).toHaveTextContent("mode not recorded (#3907)");
    expect(cells[6]).toHaveTextContent("retention not recorded (#3933)");
    expect(cells[6]).toHaveTextContent("ns core");
    expect(
      cells[6]?.querySelector('[data-governance="not-recorded"]'),
    ).toHaveAttribute("data-issue", "3907");
  });

  it("opens a workspace the viewer belongs to, and offers Edit and Archive on a live one", async () => {
    await renderTab();
    const mine = row("wrk_0a1b2c3d4e5f6g7h8j9k0m");
    expect(within(mine).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/acme/core-platform",
    );
    expect(within(mine).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(mine).getByRole("button", { name: "Archive" })).toBeTruthy();
    const other = row("wrk_1b2c3d4e5f6g7h8j9k0m1n");
    expect(within(other).queryByRole("link", { name: "Open" })).toBeNull();
    expect(within(other).getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("marks an archived workspace and offers it no control", async () => {
    await renderTab();
    const archived = row("wrk_2c3d4e5f6g7h8j9k0m1n2p");
    expect(archived).toHaveTextContent("archived");
    expect(within(archived).queryByRole("button")).toBeNull();
    expect(within(archived).queryByRole("link")).toBeNull();
  });

  it("says the organization has no workspaces when the list is empty", async () => {
    await renderTab({ workspaces: [] });
    expect(
      screen.getByText("This organization has no workspaces."),
    ).toBeInTheDocument();
  });
});
