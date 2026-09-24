// @vitest-environment jsdom
// Organization › Workspaces (pages/organization.md): the design's columns in
// order, the recorded name, slug and namespace, the main repository,
// production branch, linked repositories and agent count read inside each
// workspace the viewer may enter, why nothing was read for a workspace the
// viewer cannot enter or an archived one, the Governance chip that states the mode is
// not recorded with the namespace beneath it, Open only onto a workspace the
// viewer can enter, Edit and Archive only on a live workspace, the panel's
// Create a workspace, the note, and the public ids: the organization's under
// the panel title and each workspace's under its slug, each with a button that
// copies it exactly. Checked with axe.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
        archiveBlockers: { count: 63, more: false },
      },
    },
  ],
]);

/** The clipboard as the test left it, put back after each test. */
let restoreClipboard: (() => void) | null = null;

afterEach(() => {
  cleanup();
  restoreClipboard?.();
  restoreClipboard = null;
});

/**
 * Replace `navigator.clipboard` for one test: a spy that records what it was
 * asked to copy, or `undefined` for a browser that offers no clipboard (plain
 * HTTP). The original descriptor goes back after the test.
 */
function stubClipboard(writeText: (() => Promise<void>) | undefined) {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const spy = writeText === undefined ? undefined : vi.fn(writeText);
  Object.defineProperty(navigator, "clipboard", {
    value: spy === undefined ? undefined : { writeText: spy },
    configurable: true,
  });
  restoreClipboard = () => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  };
  return spy;
}

const ORG_ID = "org_7k2m9q4x8r1t5v3w6y0z2a";

const list: WorkspaceList = {
  orgId: ORG_ID,
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

/** The id and its copy button, found by the id it copies. */
function copyId(id: string): HTMLElement {
  const found = document.querySelector(`[data-copy-id="${id}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no copy id ${id}`);
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

  it("says why a non-member's or an archived workspace's facts are not shown, never not recorded (negative)", async () => {
    await renderTab();
    const cases = [
      [
        "wrk_1b2c3d4e5f6g7h8j9k0m1n",
        "membership",
        "not readable without membership",
      ],
      ["wrk_2c3d4e5f6g7h8j9k0m1n2p", "archived", "not read while archived"],
    ] as const;
    for (const [id, reason, words] of cases) {
      const cells = within(row(id)).getAllByRole("cell");
      for (const index of [1, 2, 3, 4]) {
        expect(cells[index]).toHaveTextContent(words);
        expect(cells[index]).not.toHaveTextContent("not recorded");
        expect(
          cells[index]?.querySelector("[data-facts-withheld]"),
        ).toHaveAttribute("data-facts-withheld", reason);
      }
      // The owner is the one fact nothing records (#3933).
      expect(cells[5]).toHaveTextContent("not recorded");
    }
  });

  it("says a live member workspace whose read never arrived could not be read", async () => {
    await renderTab(list, new Map());
    const cells = within(row("wrk_0a1b2c3d4e5f6g7h8j9k0m")).getAllByRole(
      "cell",
    );
    expect(cells[1]).toHaveTextContent("could not be read");
    expect(cells[1]?.querySelector("[data-facts-withheld]")).toHaveAttribute(
      "data-facts-withheld",
      "unread",
    );
  });

  it("says a read that failed could not be read, never not recorded or zero (negative)", async () => {
    await renderTab(
      list,
      new Map([
        [
          "core-platform",
          {
            ok: false,
            reason: "error",
            code: "installation_unreachable",
            status: 502,
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
      ).toHaveAttribute("data-facts-unread", "error");
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
              archiveBlockers: { count: 0, more: false },
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

  it("marks an archived workspace and offers it no control but copying its id", async () => {
    await renderTab();
    const archived = row("wrk_2c3d4e5f6g7h8j9k0m1n2p");
    expect(archived).toHaveTextContent("archived");
    const buttons = within(archived).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName("Copy workspace ID for Legacy");
    expect(within(archived).queryByRole("link")).toBeNull();
  });

  it("says the organization has no workspaces when the list is empty, and still prints its id", async () => {
    await renderTab({ orgId: ORG_ID, workspaces: [] });
    expect(
      screen.getByText("This organization has no workspaces."),
    ).toBeInTheDocument();
    expect(copyId(ORG_ID)).toHaveTextContent(ORG_ID);
  });
});

describe("Workspaces › public ids", () => {
  it("prints the organization's public id under the panel title, outside the table, and copies it exactly", async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    await renderTab();
    const panel = screen.getByRole("region", { name: "Workspaces" });
    const table = within(panel).getByRole("table", { name: "Workspaces" });
    const org = copyId(ORG_ID);
    expect(panel).toContainElement(org);
    expect(table).not.toContainElement(org);
    expect(org.parentElement).toHaveTextContent("Organization ID");
    fireEvent.click(
      within(org).getByRole("button", { name: "Copy organization ID" }),
    );
    await waitFor(() => {
      expect(within(org).getByRole("status")).toHaveTextContent("Copied");
    });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(ORG_ID);
    await expectNoAxe(document.body);
  });

  it("prints each workspace's public id below its name and slug, and each button copies that workspace's id", async () => {
    const writeText = stubClipboard(() => Promise.resolve());
    await renderTab();
    for (const workspace of list.workspaces) {
      const cell = within(row(workspace.id)).getAllByRole("cell")[0];
      if (cell === undefined) throw new Error(`no cell for ${workspace.id}`);
      // The name leads the cell; the id is a detail beneath it.
      expect(cell.firstElementChild).toHaveTextContent(workspace.name);
      const id = copyId(workspace.id);
      expect(cell).toContainElement(id);
      expect(id).toHaveTextContent(workspace.id);
      fireEvent.click(
        within(id).getByRole("button", {
          name: `Copy workspace ID for ${workspace.name}`,
        }),
      );
      await waitFor(() => {
        expect(writeText).toHaveBeenLastCalledWith(workspace.id);
      });
      expect(within(id).getByRole("status")).toHaveTextContent("Copied");
    }
    expect(writeText).toHaveBeenCalledTimes(list.workspaces.length);
  });

  it("says so when the browser refuses the clipboard, and leaves the id readable (negative)", async () => {
    stubClipboard(() => Promise.reject(new Error("not allowed")));
    await renderTab();
    const id = copyId("wrk_0a1b2c3d4e5f6g7h8j9k0m");
    fireEvent.click(
      within(id).getByRole("button", {
        name: "Copy workspace ID for Core platform",
      }),
    );
    await waitFor(() => {
      expect(within(id).getByRole("status")).toHaveTextContent(
        "Copy failed. Select the ID instead.",
      );
    });
    expect(id).toHaveTextContent("wrk_0a1b2c3d4e5f6g7h8j9k0m");
    expect(id).not.toHaveTextContent("Copied");
  });

  it("says so when the browser offers no clipboard at all (negative)", async () => {
    stubClipboard(undefined);
    await renderTab();
    const org = copyId(ORG_ID);
    fireEvent.click(
      within(org).getByRole("button", { name: "Copy organization ID" }),
    );
    await waitFor(() => {
      expect(within(org).getByRole("status")).toHaveTextContent(
        "Copy failed. Select the ID instead.",
      );
    });
  });
});
