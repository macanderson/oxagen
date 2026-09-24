// @vitest-environment jsdom
// Organization › Workspaces (pages/organization.md): the design's columns in
// order, the recorded name, slug and namespace, the main repository,
// production branch, linked repositories and agent count read inside each
// workspace the viewer may enter, "not recorded" where nothing was read, the Governance chip that states the mode is
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
vi.mock("./workspace-reads", () => ({
  readRepositoryChoices: vi.fn(),
  readWorkspaceFacts: vi.fn(),
}));

const { WorkspacesTab } = await import("./workspaces");
type Facts = NonNullable<Parameters<typeof WorkspacesTab>[0]["facts"]>;

/** What the tab read inside core-platform: its main, two linked, 64 agents. */
const CORE_FACTS: Facts = new Map([
  [
    "core-platform",
    {
      ok: true,
      value: {
        repositories: [
          { role: "main", fullName: "acme/platform", defaultRef: "main" },
          { role: "linked", fullName: "acme/billing", defaultRef: "main" },
          { role: "linked", fullName: "acme/infra", defaultRef: "trunk" },
        ],
        agents: 64,
      },
    },
  ],
]);

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

async function renderTab(
  value: WorkspaceList = list,
  facts: Facts = CORE_FACTS,
) {
  const view = render(
    <IntlProvider>
      <WorkspacesTab
        org="acme"
        workspaces={value}
        facts={facts}
        enterable={["core-platform"]}
      />
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

  it("prints the repositories and agents read inside the workspace, and says not recorded for the owner", async () => {
    await renderTab();
    const cells = within(row("wrk_0a1b2c3d4e5f6g7h8j9k0m")).getAllByRole(
      "cell",
    );
    expect(cells[0]).toHaveTextContent("Core platform");
    expect(cells[0]).toHaveTextContent("core-platform");
    expect(cells[1]).toHaveTextContent("acme/platform");
    expect(cells[2]).toHaveTextContent("main");
    expect(cells[3]).toHaveTextContent("acme/billing, acme/infra");
    expect(cells[4]).toHaveTextContent("64");
    expect(cells[5]).toHaveTextContent("not recorded");
    // The governance cell names the issues that would back it.
    expect(cells[6]).toHaveTextContent("mode not recorded (#3907)");
    expect(cells[6]).toHaveTextContent("retention not recorded (#3933)");
    expect(cells[6]).toHaveTextContent("ns core");
    expect(
      cells[6]?.querySelector('[data-governance="not-recorded"]'),
    ).toHaveAttribute("data-issue", "3907");
  });

  it("says not recorded for a workspace the viewer cannot enter, and for an archived one (negative)", async () => {
    await renderTab();
    for (const id of [
      "wrk_1b2c3d4e5f6g7h8j9k0m1n",
      "wrk_2c3d4e5f6g7h8j9k0m1n2p",
    ]) {
      const cells = within(row(id)).getAllByRole("cell");
      for (const index of [1, 2, 3, 4, 5]) {
        expect(cells[index]).toHaveTextContent("not recorded");
      }
    }
  });

  it("says a read that failed could not be read, never not recorded or zero (negative)", async () => {
    await renderTab(
      list,
      new Map([
        [
          "core-platform",
          {
            ok: false,
            reason: "unavailable",
            code: "installation_unreachable",
          },
        ],
      ]),
    );
    const cells = within(row("wrk_0a1b2c3d4e5f6g7h8j9k0m")).getAllByRole(
      "cell",
    );
    for (const index of [1, 2, 3, 4]) {
      expect(cells[index]).toHaveTextContent("could not be read");
      expect(
        cells[index]?.querySelector("[data-facts-unread]"),
      ).toHaveAttribute("data-facts-unread", "unavailable");
    }
    expect(cells[4]).not.toHaveTextContent("0");
  });

  it("says none for a workspace with no linked repository", async () => {
    await renderTab(
      list,
      new Map([
        [
          "core-platform",
          {
            ok: true,
            value: {
              repositories: [
                { role: "main", fullName: "acme/platform", defaultRef: "main" },
              ],
              agents: 0,
            },
          },
        ],
      ]),
    );
    const cells = within(row("wrk_0a1b2c3d4e5f6g7h8j9k0m")).getAllByRole(
      "cell",
    );
    expect(cells[3]).toHaveTextContent("none");
    expect(cells[4]).toHaveTextContent("0");
  });

  it("filters by the production branch the rows carry", async () => {
    await renderTab();
    const branch = screen.getByLabelText("Production branch");
    expect(
      within(branch)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All · Production branch", "main"]);
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
