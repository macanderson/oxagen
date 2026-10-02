// @vitest-environment jsdom
// The Repositories table on its own, over rows in every `.oxagen/` state the
// page can hold: each state's badge, the banner's Add Oxagen on the first
// ungoverned repository, the rows whose tree is unsettled offering nothing,
// the note a truncated listing adds, a search that matches nothing, and the
// Issues switch that turns issue collection on and off for a linked repository.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import type { RepositoryTree } from "@/data/contracts/repository";
import { IntlProvider } from "@/test/intl";
import type { Load } from "./parts";
import type { RepositoryRow } from "./view";

const { setIssueCollection } = vi.hoisted(() => ({ setIssueCollection: vi.fn() }));
vi.mock("./actions", () => ({ setIssueCollection }));

const { RepositoriesTab, TreeBadge } = await import("./repositories-tab");

/** acme/docs is collected; the rest are not. */
const ISSUES: Load<{ collected: string[] }> = {
  kind: "ready",
  value: { collected: ["acme/docs"] },
};

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

beforeEach(() => {
  setIssueCollection.mockReset();
});

function tab(
  truncated = false,
  issues: Load<{ collected: string[] }> = ISSUES,
  onIssuesChanged = vi.fn(),
) {
  const onAddOxagen = vi.fn();
  render(
    <IntlProvider>
      <RepositoriesTab
        org="acme"
        ws="core-platform"
        issues={issues}
        onIssuesChanged={onIssuesChanged}
        rows={ROWS}
        reachableUnread={false}
        truncated={truncated}
        onOpen={vi.fn()}
        onAddOxagen={onAddOxagen}
      />
    </IntlProvider>,
  );
  return onAddOxagen;
}

describe("the Repositories table", () => {
  it("badges a missing branch, a tree still being read, and one that could not be read, and offers none of them Add Oxagen", () => {
    tab();
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
  });

  it("offers the main repository no Add Oxagen when it carries no .oxagen/ (#5082)", () => {
    render(
      <IntlProvider>
        <RepositoriesTab
          org="acme"
          ws="core-platform"
          issues={ISSUES}
          onIssuesChanged={vi.fn()}
          rows={[
            row(
              "oxagen-steering",
              { kind: "ready", value: { ...TREE, role: "main" } },
              { role: "main" },
            ),
            ...ROWS,
          ]}
          reachableUnread={false}
          truncated={false}
          onOpen={vi.fn()}
          onAddOxagen={vi.fn()}
        />
      </IntlProvider>,
    );
    expect(screen.getByTestId("repository-tree-acme/oxagen-steering")).toHaveAttribute(
      "data-tree",
      "absent",
    );
    expect(screen.queryByTestId("repository-add-acme/oxagen-steering")).toBeNull();
    expect(screen.getByTestId("repository-add-acme/docs")).toBeTruthy();
  });

  it("names every ungoverned linked repository in the banner, whose Add Oxagen opens on the first", async () => {
    const user = userEvent.setup();
    const onAddOxagen = tab();
    const add = screen.getByTestId("repositories-ungoverned-add");
    expect(add.parentElement).toHaveTextContent("acme/docs, acme/site");
    await user.click(add);
    expect(onAddOxagen).toHaveBeenCalledWith("acme/docs");
  });

  it("says the listing was cut short when the installation reaches more than it returned", () => {
    tab(true);
    expect(screen.getByTestId("repositories-reachable-note")).toHaveTextContent(
      "The installation reaches more repositories than this list holds.",
    );
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

describe("the Issues switch", () => {
  it("shows which linked repositories a collector reads, and offers no switch on a repository that is not linked", () => {
    render(
      <IntlProvider>
        <RepositoriesTab
          org="acme"
          ws="core-platform"
          issues={ISSUES}
          onIssuesChanged={vi.fn()}
          rows={[...ROWS, row("elsewhere", null, { role: "available", bindingId: null })]}
          reachableUnread={false}
          truncated={false}
          onOpen={vi.fn()}
          onAddOxagen={vi.fn()}
        />
      </IntlProvider>,
    );
    const docs = screen.getByRole("switch", { name: "Collect issues from acme/docs" });
    expect(docs).toHaveAttribute("aria-checked", "true");
    expect(docs).toHaveTextContent("On");
    expect(screen.getByRole("switch", { name: "Collect issues from acme/site" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.queryByTestId("repository-issues-acme/elsewhere")).toBeNull();
  });

  it("turns collection on for a repository and says the read started", async () => {
    const user = userEvent.setup();
    setIssueCollection.mockResolvedValue({
      ok: true,
      value: { collecting: true, reconcileQueued: true },
    });
    const onIssuesChanged = vi.fn();
    tab(false, ISSUES, onIssuesChanged);
    await user.click(screen.getByRole("switch", { name: "Collect issues from acme/site" }));
    expect(setIssueCollection).toHaveBeenCalledWith("acme", "core-platform", {
      repository: "acme/site",
      collect: true,
    });
    expect(onIssuesChanged).toHaveBeenCalledWith(
      "oxagen is reading the open issues in acme/site now. They show up in Work in a few minutes.",
    );
  });

  it("turns collection off for a repository a collector reads", async () => {
    const user = userEvent.setup();
    setIssueCollection.mockResolvedValue({
      ok: true,
      value: { collecting: false, reconcileQueued: false },
    });
    tab();
    await user.click(screen.getByRole("switch", { name: "Collect issues from acme/docs" }));
    expect(setIssueCollection).toHaveBeenCalledWith("acme", "core-platform", {
      repository: "acme/docs",
      collect: false,
    });
  });

  it("shows the refusal beside the switch and changes nothing (negative)", async () => {
    const user = userEvent.setup();
    setIssueCollection.mockResolvedValue({ ok: false, reason: "denied", code: "work.collectors.set" });
    const onIssuesChanged = vi.fn();
    tab(false, ISSUES, onIssuesChanged);
    await user.click(screen.getByRole("switch", { name: "Collect issues from acme/site" }));
    expect(await screen.findByTestId("repository-issues-failure-acme/site")).toBeTruthy();
    expect(onIssuesChanged).not.toHaveBeenCalled();
  });

  it("does nothing while the collectors could not be read (negative)", async () => {
    const user = userEvent.setup();
    tab(false, {
      kind: "failed",
      failure: { ok: false, reason: "unavailable", code: "control_plane_unavailable" },
    });
    const docs = screen.getByRole("switch", { name: "Collect issues from acme/docs" });
    expect(docs).toHaveAttribute("aria-checked", "false");
    expect(docs).toHaveTextContent("Unknown");
    await user.click(docs);
    expect(setIssueCollection).not.toHaveBeenCalled();
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
