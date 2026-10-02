// @vitest-environment jsdom
// The Memories tab of the Steering hub over a fake DataSource (#4914; roadmap
// pages/steering-memories.md): the rows as the read ranks them with their
// seven columns and the waiting count on the tab, No signal for a source
// that reports no use, the empty, no-match and failed states, the filters as
// addresses, the drawer for one memory, Promote with one draft per row and
// the forces each kind allows, and Dismiss and Restore. An axe check runs in
// every one.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceMemoryQuery } from "@/data/contracts/steering";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { nth } from "@/test/nth";
import { optionNames, pickOption } from "@/test/select";
import {
  agentPage,
  enrolledAgent,
  MEMORY_ID,
  MEMORY_PR_URL,
  type SteeringReads,
  steeringSource,
  workspaceMemory,
  workspaceMemoryDetail,
  workspaceMemoryPage,
} from "@/test/steering-views";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
const { router, promoteMemories, dismissMemories, toast } = vi.hoisted(
  () => ({
    router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
    promoteMemories: vi.fn(),
    dismissMemories: vi.fn(),
    toast: vi.fn(),
  }),
);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ promoteMemories, dismissMemories }));
vi.mock("@/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ui/toast")>()),
  toast,
}));
vi.mock("../actions", () => ({
  openContextPr: vi.fn(),
  mergeContextPr: vi.fn(),
  dismissProposal: vi.fn(),
  approveContextPr: vi.fn(),
  mergePrWithoutReview: vi.fn(),
  restoreManagedBlock: vi.fn(),
  dropMemoryRecord: vi.fn(),
  setSteeringGate: vi.fn(),
  setGovernanceMode: vi.fn(),
}));
vi.mock("../import/actions", () => ({
  parseMarkdownImport: vi.fn(),
  matchMarkdownImport: vi.fn(),
  commitMarkdownImport: vi.fn(),
}));
vi.mock("@/server/session", () => ({
  getSession: vi.fn(),
  getAuthUser: vi.fn(() =>
    Promise.resolve({ name: "Marcus Bell", email: "marcus@acme.test" }),
  ),
}));
vi.mock("@/features/skills", () => ({
  Skills: () => null,
  SkillsLoading: () => null,
}));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
// jsdom has no layout, so it has no scrollIntoView; the tab strip calls it.
Element.prototype.scrollIntoView = vi.fn();

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Steering } = await import("../steering");
const { resolveSteeringRoute } = await import("../view");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const BASE = "/acme/core-platform/steering";

/** Draft releases only: waiting, nine runs, Claude Code's Feedback type, an agent the registry holds. */
const DRAFT = workspaceMemory();
/** A Codex memory with twelve uses, an agent the registry does not hold, and no label. */
const WEBHOOK = workspaceMemory({
  id: "mem_01k5rw3webhook",
  label: null,
  summary: null,
  statement:
    "Check the webhook secret before a deploy. The staging one rotates weekly.",
  harness: "codex",
  agent: "acme.core-platform.deploy-bot",
  source: "codex:thread/019a",
  repos: ["github.com/acme/api"],
  memoryType: null,
  kind: "code-rule",
  uses: 12,
});
/** A lesson Cursor's agent wrote through remember_lesson: no use signal, no agent Oxagen could tell. */
const SHOTS = workspaceMemory({
  id: "mem_01k5rw3shots",
  label: "Docs screenshots",
  summary: null,
  statement: "Retake the docs screenshots after a UI change.",
  capture: "remember",
  harness: "cursor",
  agent: null,
  source: null,
  repos: null,
  memoryType: null,
  kind: "fact",
  uses: 0,
  useSignal: false,
  lastUsedAt: null,
});
/** A memory open memory PR #59 cites. */
const CACHE = workspaceMemory({
  id: "mem_01k5rw3cache",
  label: "CI cache follows the lockfile",
  summary: null,
  state: "in_pr",
  uses: 4,
  memoryPr: { number: 59, url: MEMORY_PR_URL, status: "open" },
});
/** A promoted memory, which only the every-state read holds. */
const OLD = workspaceMemory({
  id: "mem_01k5rw3old",
  label: "Old release rule",
  state: "promoted",
  promotedLineage: "core.release.old",
  uses: 3,
});

/** The page the filters name, in the read's ranking. */
const PAGE = readOk(workspaceMemoryPage([WEBHOOK, DRAFT, CACHE, SHOTS]));
/** Every memory in every state, which the filters and the open PR come from. */
const EVERY = readOk(workspaceMemoryPage([WEBHOOK, DRAFT, CACHE, OLD, SHOTS]));

const isEvery = (q: WorkspaceMemoryQuery) => q.limit === 200;

/** Answers the every-state read with EVERY and the page read with `page`. */
const memoriesWith =
  (page: SteeringReads["workspaceMemories"] = PAGE) =>
  (q: WorkspaceMemoryQuery) =>
    isEvery(q) ? EVERY : typeof page === "function" ? page(q) : page;

const AGENTS = readOk(
  agentPage([enrolledAgent({ operatorName: "Marcus Bell" })]),
);

async function renderSteering(path: string, reads: Partial<SteeringReads> = {}) {
  const { source, calls } = steeringSource({
    workspaceMemories: memoriesWith(),
    agents: AGENTS,
    ...reads,
  });
  const url = new URL(`http://oxagen.test${BASE}${path}`);
  const segments = url.pathname
    .slice(BASE.length)
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  const route = resolveSteeringRoute(
    { org: "acme", ws: "core-platform" },
    segments.length === 0 ? undefined : segments,
    Object.fromEntries(url.searchParams),
  );
  if (route.kind !== "view") throw new Error(`${path} is ${route.kind}`);
  const element = await Steering({
    ctx,
    source,
    view: route.view,
    header: (actions) => (
      <header data-testid="hub-header">
        <h1>Steering</h1>
        {actions}
      </header>
    ),
  });
  render(<IntlProvider>{element}</IntlProvider>);
  return calls;
}

const tab = (name: string) =>
  screen.getByRole("tab", { name: new RegExp(`^${name}`) });

function row(id: string): HTMLElement {
  const found = document.querySelector(`tr[data-memory="${id}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`no row for ${id}`);
  return found;
}

/** The text of each cell in the row, after the select box. */
const cells = (id: string) =>
  within(row(id))
    .getAllByRole("cell")
    .slice(1)
    .map((cell) => cell.textContent.trim());

const drawer = () => screen.getByTestId("memory-drawer");

beforeEach(() => {
  for (const fn of [
    router.push,
    router.replace,
    router.refresh,
    promoteMemories,
    dismissMemories,
    toast,
  ]) {
    fn.mockReset();
  }
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the Memories tab", () => {
  it("lists the memories in the order the read ranks them, with the seven columns and the waiting count on the tab", async () => {
    await renderSteering("/memories");
    expect(tab("Memories")).toHaveAttribute("aria-selected", "true");
    expect(tab("Memories")).toHaveTextContent(/^Memories2$/);
    const table = screen.getByRole("table", { name: "Memories" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((head) => head.textContent.trim()),
    ).toEqual([
      "",
      "Memory",
      "Uses",
      "Last used",
      "Harness",
      "Agent",
      "Repository",
      "State",
    ]);
    expect(
      [...table.querySelectorAll("tbody tr")].map((tr) =>
        tr.getAttribute("data-memory"),
      ),
    ).toEqual([WEBHOOK.id, DRAFT.id, CACHE.id, SHOTS.id]);
    const draft = cells(DRAFT.id);
    expect(nth(draft, 0, "the memory")).toBe(
      "Draft releases onlyOpen every release as a draft first.",
    );
    expect(nth(draft, 1, "the uses")).toBe("9");
    expect(nth(draft, 3, "the harness")).toBe("Claude CodeFeedback");
    // The avatar draws the agent's initials before its name.
    expect(nth(draft, 4, "the agent")).toContain("Release managerMarcus Bell");
    expect(nth(draft, 5, "the repository")).toBe("acme/platform");
    expect(nth(draft, 6, "the state")).toBe("Waiting");
    // A memory with no label is named by its first sentence.
    const webhook = cells(WEBHOOK.id);
    expect(nth(webhook, 0, "the memory")).toBe(
      "Check the webhook secret before a deploy.The staging one rotates weekly.",
    );
    expect(nth(webhook, 1, "the uses")).toBe("12");
    // An agent the registry's first page does not hold reads by its key.
    expect(nth(webhook, 4, "the agent")).toBe("acme.core-platform.deploy-bot");
    expect(screen.getByTestId("memory-count")).toHaveTextContent("4 memories");
    expect(
      screen.getByRole("heading", { level: 3, name: "Memories" }),
    ).toBeInTheDocument();
  });

  it("reads No signal for a source that reports no use, and names no agent it could not tell", async () => {
    await renderSteering("/memories");
    const shots = cells(SHOTS.id);
    expect(nth(shots, 1, "the uses")).toBe("No signal");
    expect(nth(shots, 2, "the last use")).toBe("No signal");
    expect(nth(shots, 3, "the harness")).toBe("Cursor");
    expect(nth(shots, 4, "the agent")).toBe("No known agent");
    expect(nth(shots, 5, "the repository")).toBe("None");
    // A memory with a use signal never reads No signal.
    expect(nth(cells(DRAFT.id), 2, "the last use")).not.toBe("No signal");
  });

  it("links an In PR memory to its memory PR and draws a box on waiting rows only", async () => {
    await renderSteering("/memories");
    const state = within(row(CACHE.id)).getByTestId("memory-pr-link");
    expect(state).toHaveTextContent("Memory PR #59");
    expect(state).toHaveAttribute("href", MEMORY_PR_URL);
    expect(within(row(CACHE.id)).queryByRole("checkbox")).toBeNull();
    expect(
      within(row(DRAFT.id)).getByRole("checkbox", {
        name: "Select Draft releases only",
      }),
    ).not.toBeChecked();
  });

  it("reads every memory for the filters, then the page the address names", async () => {
    const calls = await renderSteering(
      "/memories?state=all&harness=codex&type=feedback&rows=25",
    );
    const every = {
      states: ["waiting", "in_pr", "promoted", "dismissed", "retired"],
      harness: null,
      agent: null,
      repository: null,
      type: null,
      limit: 200,
      offset: 0,
    };
    expect(calls.workspaceMemories).toContainEqual([ctx, every]);
    expect(calls.workspaceMemories).toContainEqual([
      ctx,
      { ...every, harness: "codex", type: "feedback", limit: 25 },
    ]);
    expect(calls.workspaceMemory).toEqual([]);
  });

  it("keeps the header's gold and draws the selection's Promote secondary", async () => {
    await renderSteering("/memories");
    expect(
      within(screen.getByTestId("hub-header")).getByRole("button", {
        name: "Write a context record",
      }).className,
    ).toMatch(/button-primary/);
    fireEvent.click(
      within(row(DRAFT.id)).getByRole("checkbox", {
        name: "Select Draft releases only",
      }),
    );
    const bar = screen.getByRole("group", { name: "Selected memories" });
    expect(bar).toHaveTextContent("1 memory selected");
    expect(
      within(bar).getByRole("button", { name: "Promote memories" }).className,
    ).not.toMatch(/button-primary/);
    expect(
      document.querySelectorAll('[class*="bg-button-primary-bg"]'),
    ).toHaveLength(1);
  });

  it("says No memories yet and takes the gold from the header when the workspace holds none", async () => {
    await renderSteering("/memories", {
      workspaceMemories: readOk(workspaceMemoryPage([])),
    });
    expect(screen.getByTestId("memories-empty")).toHaveTextContent(
      "No memories yet",
    );
    expect(screen.getByTestId("memories-empty")).toHaveTextContent(
      "Oxagen collects them from enrolled hosts every five minutes.",
    );
    expect(
      within(screen.getByTestId("hub-header")).queryByRole("button", {
        name: "Write a context record",
      }),
    ).toBeNull();
    expect(screen.queryByRole("table", { name: "Memories" })).toBeNull();
  });

  it("says no memory matches and offers Clear filters when the filters match nothing", async () => {
    await renderSteering("/memories?state=dismissed", {
      workspaceMemories: memoriesWith(readOk(workspaceMemoryPage([]))),
    });
    const none = screen.getByTestId("memory-no-match");
    expect(none).toHaveTextContent("No memory matches these filters.");
    expect(
      within(none).getByRole("link", { name: "Clear filters" }),
    ).toHaveAttribute("href", `${BASE}/memories`);
    expect(screen.queryByTestId("memories-empty")).toBeNull();
  });

  it("shows a failed read in the panel with Try again and keeps the tabs (negative)", async () => {
    await renderSteering("/memories", {
      workspaceMemories: memoriesWith(
        readError("memory_store_unavailable", 503),
      ),
    });
    const failure = screen.getByTestId("memories-failure");
    expect(failure).toHaveTextContent(
      "Memories could not be loaded: memory_store_unavailable.",
    );
    expect(
      within(failure).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", `${BASE}/memories`);
    expect(screen.getAllByRole("tab")).toHaveLength(6);
    expect(screen.queryByTestId("steering-error")).toBeNull();
  });
});

describe("the filters", () => {
  it("offers every state, and only the harnesses and types the memories hold", async () => {
    const user = userEvent.setup();
    await renderSteering("/memories");
    expect(
      await optionNames(user, screen.getByRole("combobox", { name: "State" })),
    ).toEqual([
      "Waiting and In PR",
      "Waiting",
      "In PR",
      "Promoted",
      "Dismissed",
      "Retired",
      "Every state",
    ]);
    expect(
      await optionNames(
        user,
        screen.getByRole("combobox", { name: "Harness" }),
      ),
    ).toEqual(["Every harness", "Claude Code", "Codex", "Cursor"]);
    expect(
      await optionNames(user, screen.getByRole("combobox", { name: "Type" })),
    ).toEqual(["Every type", "Feedback"]);
    expect(
      await optionNames(user, screen.getByRole("combobox", { name: "Agent" })),
    ).toEqual([
      "Every agent",
      "acme.core-platform.deploy-bot",
      "Release manager",
    ]);
  });

  it("moves to the address a filter names, on its first page", async () => {
    const user = userEvent.setup();
    await renderSteering("/memories?offset=50");
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Harness" }),
      "Codex",
    );
    expect(router.push).toHaveBeenCalledWith(`${BASE}/memories?harness=codex`);
  });
});

describe("the drawer", () => {
  it("opens the memory the address names with its facts, statement, source, runs and memory PR", async () => {
    const calls = await renderSteering(`/memories?memory=${MEMORY_ID}`);
    expect(calls.workspaceMemory).toEqual([[ctx, MEMORY_ID]]);
    const sheet = drawer();
    expect(
      within(sheet).getByRole("heading", { name: "Draft releases only" }),
    ).toBeInTheDocument();
    const facts = within(sheet).getByTestId("memory-facts");
    expect(facts).toHaveTextContent("Uses9 uses");
    expect(facts).toHaveTextContent("HarnessClaude Code");
    expect(facts).toHaveTextContent("Release managerMarcus Bell");
    expect(facts).toHaveTextContent("TypeFeedback");
    expect(within(sheet).getByTestId("memory-source")).toHaveTextContent(
      "claude-code:~/.claude/projects/core/memory/feedback_draft_releases.md",
    );
    expect(within(sheet).getByTestId("memory-statement")).toHaveTextContent(
      DRAFT.statement,
    );
    expect(
      within(within(sheet).getByTestId("memory-runs"))
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["tse_01k5ru9a", "/acme/core-platform/runs/tse_01k5ru9a"],
      ["arun_01k5rs7m", "/acme/core-platform/runs/arun_01k5rs7m"],
    ]);
    expect(within(sheet).getByTestId("memory-standing")).toHaveTextContent(
      "In no memory PR yet. Promote adds a draft record to the open memory PR.",
    );
    expect(
      within(sheet).getByRole("button", { name: "Dismiss memory" }),
    ).toBeEnabled();
    expect(
      within(sheet).getByRole("button", { name: "Promote memory" }).className,
    ).toMatch(/button-primary/);
  });

  it("links the memory PR that cites a memory in a PR", async () => {
    await renderSteering(`/memories?memory=${CACHE.id}`, {
      workspaceMemory: readOk(
        workspaceMemoryDetail(CACHE, {
          memoryPr: {
            number: 59,
            url: MEMORY_PR_URL,
            repository: "acme/oxagen-core-platform",
            branch: "memory/2026-09-27",
            status: "open",
            openedAt: "2026-09-27T09:00:00.000Z",
            settledAt: null,
          },
        }),
      ),
    });
    const sheet = drawer();
    expect(within(sheet).getByTestId("memory-standing")).toHaveTextContent(
      "Memory PR #59open",
    );
    expect(
      within(sheet).getByRole("link", { name: "Open memory PR #59" }),
    ).toHaveAttribute("href", MEMORY_PR_URL);
    expect(
      within(sheet).queryByRole("button", { name: "Promote memory" }),
    ).toBeNull();
  });

  it("says why a memory with no use signal names no run", async () => {
    await renderSteering(`/memories?memory=${SHOTS.id}`, {
      workspaceMemory: readOk(
        workspaceMemoryDetail(SHOTS, { uses: [], usesTotal: 0 }),
      ),
    });
    const sheet = drawer();
    expect(within(sheet).getByTestId("memory-facts")).toHaveTextContent(
      "UsesNo signal",
    );
    expect(within(sheet).getByTestId("memory-why")).toHaveTextContent(
      "Its agent wrote it through remember_lesson. Nothing reports its uses.",
    );
  });

  it("says the workspace holds no such memory (negative)", async () => {
    await renderSteering("/memories?memory=mem_01k5rw3gone", {
      workspaceMemory: readError("not_found", 404),
    });
    expect(drawer()).toHaveTextContent("This workspace has no such memory.");
  });

  it("closes onto the tab, keeping the list where it was", async () => {
    await renderSteering(`/memories?offset=50&memory=${MEMORY_ID}`);
    fireEvent.click(
      nth(
        within(drawer()).getAllByRole("button", { name: "Close" }),
        0,
        "the drawer's Close",
      ),
    );
    expect(router.replace).toHaveBeenCalledWith(`${BASE}/memories?offset=50`, {
      scroll: false,
    });
  });
});

/** Ticks the row named `name`. */
function pick(id: string, name: string) {
  fireEvent.click(within(row(id)).getByRole("checkbox", { name }));
}

describe("Promote", () => {
  const PROMOTED = {
    ok: true,
    value: {
      pullRequest: { number: 59, url: MEMORY_PR_URL, opened: false },
      records: 2,
      skipped: 0,
    },
  } as const;

  it("drafts one record per selected row and adds them to the open memory PR", async () => {
    promoteMemories.mockResolvedValue(PROMOTED);
    await renderSteering("/memories");
    pick(WEBHOOK.id, "Select Check the webhook secret before a deploy.");
    pick(DRAFT.id, "Select Draft releases only");
    expect(screen.getByTestId("memory-selection")).toHaveTextContent(
      "2 memories selected",
    );
    fireEvent.click(screen.getByRole("button", { name: "Promote memories" }));
    const dialog = screen.getByTestId("promote-dialog");
    expect(dialog).toHaveTextContent(
      "Each draft joins memory PR #59 and steers nothing until it merges.",
    );
    const drafts = within(dialog).getAllByTestId("promote-draft");
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toHaveTextContent(
      "From 1 memory by acme.core-platform.deploy-bot",
    );
    const second = nth(drafts, 1, "the second draft");
    expect(within(second).getByTestId("promote-kind")).toHaveValue(
      "procedure",
    );
    expect(within(second).getByTestId("promote-force")).toHaveValue("should");
    expect(within(second).getByTestId("promote-scope")).toHaveTextContent(
      "github.com/acme/platform",
    );
    expect(screen.getByTestId("promote-summary")).toHaveTextContent(
      "2 draft records from 2 memories.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add to memory PR #59" }),
    );
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "Added 2 records to memory PR #59. Nothing steers until it merges.",
      );
    });
    expect(promoteMemories).toHaveBeenCalledWith("acme", "core-platform", [
      {
        memory_ids: [WEBHOOK.id],
        statement: WEBHOOK.statement,
        kind: "code-rule",
        force: "should",
      },
      {
        memory_ids: [DRAFT.id],
        statement: DRAFT.statement,
        kind: "procedure",
        force: "should",
      },
    ]);
    expect(router.refresh).toHaveBeenCalled();
    expect(screen.queryByTestId("promote-dialog")).toBeNull();
    expect(screen.queryByTestId("memory-selection")).toBeNull();
  });

  it("offers only the forces a kind allows, and asks a constraint for its effect", async () => {
    const user = userEvent.setup();
    promoteMemories.mockResolvedValue(PROMOTED);
    await renderSteering("/memories");
    pick(DRAFT.id, "Select Draft releases only");
    fireEvent.click(screen.getByRole("button", { name: "Promote memories" }));
    const draft = screen.getByTestId("promote-draft");
    const kind = within(draft).getByTestId("promote-kind");
    const forces = () =>
      within(within(draft).getByTestId("promote-force"))
        .getAllByRole("option")
        .map((option) => option.textContent);
    expect(forces()).toEqual(["must", "should", "may", "info"]);
    await user.selectOptions(kind, "fact");
    expect(forces()).toEqual(["info"]);
    expect(draft).toHaveTextContent("The only force this kind allows.");
    expect(within(draft).queryByTestId("promote-effect")).toBeNull();
    await user.selectOptions(kind, "constraint");
    // A constraint allows every force, so the fact's info stays.
    expect(forces()).toEqual(["must", "should", "may", "info"]);
    expect(within(draft).getByTestId("promote-force")).toHaveValue("info");
    expect(within(draft).getByTestId("promote-effect")).toHaveValue("require");
    await user.selectOptions(
      within(draft).getByTestId("promote-effect"),
      "forbid",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add to memory PR #59" }),
    );
    await waitFor(() => {
      expect(promoteMemories).toHaveBeenCalledWith("acme", "core-platform", [
        {
          memory_ids: [DRAFT.id],
          statement: DRAFT.statement,
          kind: "constraint",
          force: "info",
          effect: "forbid",
        },
      ]);
    });
  });

  it("keeps the dialog and its values when the write is refused (negative)", async () => {
    promoteMemories.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "steering_repo_required",
    });
    await renderSteering("/memories");
    pick(DRAFT.id, "Select Draft releases only");
    fireEvent.click(screen.getByRole("button", { name: "Promote memories" }));
    const statement = screen.getByTestId("promote-statement");
    fireEvent.change(statement, {
      target: { value: "Open every release as a draft first." },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Add to memory PR #59" }),
    );
    expect(await screen.findByTestId("promote-failure")).toHaveTextContent(
      "This workspace has no steering repo yet. Set one up on the Repositories page, then try again.",
    );
    expect(screen.getByTestId("promote-statement")).toHaveValue(
      "Open every release as a draft first.",
    );
    expect(toast).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("promotes the memory its drawer shows", async () => {
    promoteMemories.mockResolvedValue(PROMOTED);
    await renderSteering(`/memories?memory=${MEMORY_ID}`);
    fireEvent.click(
      within(drawer()).getByRole("button", { name: "Promote memory" }),
    );
    expect(screen.queryByTestId("memory-drawer")).toBeNull();
    expect(screen.getAllByTestId("promote-draft")).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Add to memory PR #59" }),
    );
    await waitFor(() => {
      expect(promoteMemories).toHaveBeenCalledWith("acme", "core-platform", [
        expect.objectContaining({ memory_ids: [DRAFT.id] }),
      ]);
    });
  });
});

describe("Dismiss and Restore", () => {
  it("dismisses the selected rows' waiting memories", async () => {
    dismissMemories.mockResolvedValue({
      ok: true,
      value: { changed: 1, skipped: 0 },
    });
    await renderSteering("/memories");
    pick(SHOTS.id, "Select Docs screenshots");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss memories" }));
    const dialog = screen.getByTestId("dismiss-dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Dismiss memory" }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "The curator does not propose a dismissed memory again.",
    );
    expect(within(dialog).getByTestId("dismiss-list")).toHaveTextContent(
      "Docs screenshotsNo known agent",
    );
    fireEvent.click(within(dialog).getByTestId("dismiss-submit"));
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith("Dismissed 1 memory.");
    });
    expect(dismissMemories).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      [SHOTS.id],
      false,
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("names a refused dismissal and keeps the dialog (negative)", async () => {
    dismissMemories.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    await renderSteering("/memories");
    pick(SHOTS.id, "Select Docs screenshots");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss memories" }));
    fireEvent.click(screen.getByTestId("dismiss-submit"));
    expect(await screen.findByTestId("dismiss-failure")).toHaveTextContent(
      "Your role in this workspace does not allow this change. Nothing was changed.",
    );
    expect(screen.getByTestId("dismiss-dialog")).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it("restores a dismissed memory from its drawer", async () => {
    dismissMemories.mockResolvedValue({
      ok: true,
      value: { changed: 1, skipped: 0 },
    });
    const dismissed = workspaceMemory({ state: "dismissed" });
    await renderSteering(`/memories?state=dismissed&memory=${MEMORY_ID}`, {
      workspaceMemory: readOk(workspaceMemoryDetail(dismissed)),
    });
    expect(within(drawer()).getByTestId("memory-standing")).toHaveTextContent(
      "Dismissed. The curator does not propose it again.",
    );
    fireEvent.click(within(drawer()).getByTestId("memory-restore"));
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        "Restored. The memory waits for promotion again.",
      );
    });
    expect(dismissMemories).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      [MEMORY_ID],
      true,
    );
    expect(router.refresh).toHaveBeenCalled();
  });
});
