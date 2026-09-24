// @vitest-environment jsdom
// The Repositories table on its own, over rows in every `.oxagen/` state the
// page can hold: each state's badge, the banner's Add Oxagen on the first
// ungoverned repository, the rows whose tree is unsettled offering nothing,
// the note a truncated listing adds, and a search that matches nothing.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import type { RepositoryTree } from "@/data/contracts/repository";
import { IntlProvider } from "@/test/intl";
import { RepositoriesTab, TreeBadge } from "./repositories-tab";
import type { RepositoryRow } from "./view";

const TREE: RepositoryTree = {
  bindingId: "rpb_x",
  role: "linked",
  fullName: "acme/x",
  productionBranch: "main",
  githubDefaultBranch: "main",
  head: "0123456789abcdef0123",
  oxagen: { present: false, files: [] },
  workspaceToml: null,
  governanceToml: null,
  governanceMode: "absent",
  initPullRequest: null,
  readAt: "2026-09-19T10:00:00.000Z",
};

const row = (
  name: string,
  tree: RepositoryRow["tree"],
  extra: Partial<RepositoryRow> = {},
): RepositoryRow => ({
  fullName: `acme/${name}`,
  owner: "acme",
  name,
  role: "linked",
  bindingId: `rpb_${name}`,
  productionBranch: "main",
  visibility: null,
  htmlUrl: `https://github.com/acme/${name}`,
  events: "installed",
  connectionLive: true,
  tree,
  ...extra,
});

const ROWS: RepositoryRow[] = [
  row("docs", { kind: "ready", value: TREE }),
  row("site", { kind: "ready", value: TREE }),
  row("moved", { kind: "ready", value: { ...TREE, head: null } }),
  row("slow", { kind: "loading" }),
  row("down", {
    kind: "failed",
    failure: { ok: false, reason: "unavailable", code: "github_down" },
  }),
];

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function tab(truncated = false) {
  const onAddOxagen = vi.fn();
  const { container } = render(
    <IntlProvider>
      <RepositoriesTab
        rows={ROWS}
        reachableUnread={false}
        truncated={truncated}
        onOpen={vi.fn()}
        onAddOxagen={onAddOxagen}
      />
    </IntlProvider>,
  );
  return { onAddOxagen, container };
}

describe("the Repositories table", () => {
  it("badges a missing branch, a tree still being read, and one that could not be read, and offers none of them Add Oxagen", async () => {
    const { container } = tab();
    const badge = (name: string) =>
      screen.getByTestId(`repository-tree-acme/${name}`);
    expect(badge("moved")).toHaveAttribute("data-tree", "branchMissing");
    expect(badge("moved")).toHaveTextContent("branch missing");
    expect(badge("slow")).toHaveAttribute("data-tree", "reading");
    expect(badge("slow")).toHaveTextContent("reading");
    expect(badge("down")).toHaveAttribute("data-tree", "unread");
    expect(badge("down")).toHaveAttribute("data-state", "not-recorded");
    for (const name of ["moved", "slow", "down"])
      expect(screen.queryByTestId(`repository-add-acme/${name}`)).toBeNull();
    expect(screen.getByTestId("repository-add-acme/docs")).toBeTruthy();
    await expectNoAxe(container);
  });

  it("names every ungoverned linked repository in the banner, whose Add Oxagen opens on the first", async () => {
    const user = userEvent.setup();
    const { onAddOxagen } = tab();
    const add = screen.getByTestId("repositories-ungoverned-add");
    expect(add.parentElement).toHaveTextContent("acme/docs, acme/site");
    await user.click(add);
    expect(onAddOxagen).toHaveBeenCalledWith("acme/docs");
  });

  it("says the listing was cut short when the installation reaches more than it returned", async () => {
    const { container } = tab(true);
    expect(screen.getByTestId("repositories-reachable-note")).toHaveTextContent(
      "The installation reaches more repositories than this list holds.",
    );
    await expectNoAxe(container);
  });

  it("says no rows match when a search hides every repository (negative)", async () => {
    const user = userEvent.setup();
    tab();
    await user.type(
      screen.getByRole("searchbox", { name: "Search this list" }),
      "nothing-like-this",
    );
    const table = screen.getByRole("table", {
      name: "Repositories this workspace can see",
    });
    expect(within(table).getByText("No rows match.")).toBeTruthy();
  });
});

describe("TreeBadge", () => {
  it("reads an unknown tree as not read, never as absent", () => {
    render(
      <IntlProvider>
        <TreeBadge state="unknown" testId="badge" />
      </IntlProvider>,
    );
    expect(screen.getByTestId("badge")).toHaveTextContent("not read");
    expect(screen.getByTestId("badge")).toHaveAttribute(
      "data-state",
      "not-recorded",
    );
  });
});
