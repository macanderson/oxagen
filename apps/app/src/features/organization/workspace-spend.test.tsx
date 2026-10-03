// @vitest-environment jsdom
// The Model spend section of Organization › Workspaces › Edit workspace
// (#5426): the run enrichment switch and the three daily budgets, one per
// lane, and what the dialog sends for each.
//
// Four behaviours are load-bearing and each is asserted here rather than left
// to reading:
//
//   1. The controls open on what `get_workspace_settings` answered, so a
//      person reads the limits in force before changing one.
//   2. A cleared limit travels as null and a limit left as it opened does not
//      travel at all, so two editors on one workspace never overwrite each
//      other's lanes.
//   3. When the settings could not be read the dialog still opens, says so,
//      and sends nothing about the switch unless the person touched it.
//   4. A value the contract would refuse is refused on its own input.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceFacts } from "@/data/contracts/org";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  archiveWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  editWorkspace: vi.fn(),
  setOrgAvatar: vi.fn(),
  setWorkspaceAvatar: vi.fn(),
}));

const { editWorkspace } = await import("./actions");
const { workspaceFacts } = await import("./organization.builders");
const { EditWorkspace } = await import("./workspace-actions");

const workspace: Workspace = {
  id: "ws_7a000000000000000000000001",
  name: "Platform",
  slug: "platform",
  namespace: "platform",
  avatarUrl: null,
  role: "Admin",
  archivedAt: null,
  costCenter: null,
};

/** Enrichment on, run names capped at $2.50 a day, work orders switched off. */
const CAPPED: WorkspaceFacts = workspaceFacts({
  settings: {
    runEnrichmentEnabled: true,
    dailyBudgetUsd: { runEnrichment: 2.5, assistant: null, work: 0 },
  },
});

const edited = vi.mocked(editWorkspace);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Opens the Edit workspace dialog over `facts`, with the write answering ok. */
async function openDialog(facts: WorkspaceFacts | null) {
  edited.mockResolvedValue({
    ok: true,
    value: { slug: "platform", governance: null },
  });
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <EditWorkspace org="acme" workspace={workspace} facts={facts} />
    </IntlProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Edit" }));
  return user;
}

/** The draft the dialog sent on its one call. */
function sentDraft() {
  expect(edited).toHaveBeenCalledTimes(1);
  return edited.mock.calls[0]?.[2];
}

const enrichment = () =>
  screen.getByRole("checkbox", { name: /Name and summarize runs/ });
const runNames = () => screen.getByLabelText("Run names and summaries");
const chat = () => screen.getByLabelText("Stella chat");
const work = () => screen.getByLabelText("Work orders");

describe("EditWorkspace model spend", () => {
  it("opens on the switch and the limits in force", async () => {
    await openDialog(CAPPED);
    expect(screen.getByText("Model spend")).toBeInTheDocument();
    expect(enrichment()).toBeChecked();
    expect(enrichment()).toHaveAccessibleDescription(
      "Stella writes a name and a short account for each run. Turn it off to show run ids only.",
    );
    expect(runNames()).toHaveValue(2.5);
    // No limit is a blank input, and the placeholder says so.
    expect(chat()).toHaveValue(null);
    expect(chat()).toHaveAttribute("placeholder", "No limit");
    // 0 is a limit, the lane switched off, and it shows as 0, not as blank.
    expect(work()).toHaveValue(0);
    for (const input of [runNames(), chat(), work()]) {
      expect(input).toHaveAttribute("type", "number");
      expect(input).toHaveAttribute("min", "0");
      expect(input).toHaveAttribute("step", "0.01");
      expect(input).toHaveAttribute("inputmode", "decimal");
      expect(input).toHaveAccessibleDescription("US dollars a day");
    }
    expect(
      screen.getByText(/Blank is no limit, 0 switches the lane off/),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`edit-workspace-${workspace.id}-spend-unread`),
    ).toBeNull();
    await expectNoAxe(document.body);
  });

  it("sends the switch as stored and no lane when nothing was touched", async () => {
    const user = await openDialog(CAPPED);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(edited).toHaveBeenCalled();
    });
    expect(sentDraft()?.runEnrichmentEnabled).toBe(true);
    expect(sentDraft()?.dailyBudgetUsd).toEqual({});
  });

  it("sends a cleared limit as null, a typed one as a number, and the switch as set", async () => {
    const user = await openDialog(CAPPED);
    await user.clear(runNames());
    await user.type(chat(), "7.25");
    await user.click(enrichment());
    expect(enrichment()).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(edited).toHaveBeenCalled();
    });
    expect(sentDraft()).toMatchObject({
      name: "Platform",
      slug: "platform",
      runEnrichmentEnabled: false,
      // Run names cleared: the limit goes. Stella chat typed: 7.25. Work
      // orders left at 0: not in the patch, so another editor's change to
      // that lane survives this save.
      dailyBudgetUsd: { runEnrichment: null, assistant: 7.25 },
    });
    expect(sentDraft()?.dailyBudgetUsd).not.toHaveProperty("work");
  });

  it("opens blank and says the values were not read when the settings could not be, and sends nothing about them", async () => {
    const user = await openDialog(workspaceFacts({ settings: null }));
    expect(
      screen.getByTestId(`edit-workspace-${workspace.id}-spend-unread`),
    ).toHaveTextContent("The current values could not be read.");
    // Checked, because that is the default a workspace has, but not sent.
    expect(enrichment()).toBeChecked();
    expect(runNames()).toHaveValue(null);
    expect(chat()).toHaveValue(null);
    expect(work()).toHaveValue(null);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(edited).toHaveBeenCalled();
    });
    expect(sentDraft()?.runEnrichmentEnabled).toBeNull();
    expect(sentDraft()?.dailyBudgetUsd).toEqual({});
    await expectNoAxe(document.body);
  });

  it("opens the same way with no facts at all, which is how a workspace the viewer cannot enter arrives", async () => {
    await openDialog(null);
    expect(
      screen.getByTestId(`edit-workspace-${workspace.id}-spend-unread`),
    ).toBeInTheDocument();
    expect(enrichment()).toBeChecked();
  });

  it("sends only what was typed over unread settings, and the switch once touched", async () => {
    const user = await openDialog(workspaceFacts({ settings: null }));
    await user.type(work(), "12");
    await user.click(enrichment());
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(edited).toHaveBeenCalled();
    });
    expect(sentDraft()).toMatchObject({
      runEnrichmentEnabled: false,
      dailyBudgetUsd: { work: 12 },
    });
    expect(sentDraft()?.dailyBudgetUsd).not.toHaveProperty("runEnrichment");
    expect(sentDraft()?.dailyBudgetUsd).not.toHaveProperty("assistant");
  });

  it("refuses a negative limit on its own input, before any write (negative)", async () => {
    const user = await openDialog(CAPPED);
    const input = work();
    await user.clear(input);
    await user.type(input, "-1");
    // The input's own floor is the contract's: the browser refuses it before
    // the form is read.
    if (!(input instanceof HTMLInputElement))
      throw new Error("the budget is not an input");
    expect(input.validity.valid).toBe(false);
    expect(input.validity.rangeUnderflow).toBe(true);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(edited).not.toHaveBeenCalled();
  });
});
