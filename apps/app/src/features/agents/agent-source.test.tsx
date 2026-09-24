// @vitest-environment jsdom
// The agent source page (spec pages/agent-source.md) over a fake DataSource,
// and the editor itself: the header with its chips and three actions, the
// editor bar with find, the status line and the key bindings, the draft
// shared with the form, a parse error named at its line, and the commit
// dialog's ok, invalid and refused outcomes. Then the page's loading, error
// and denied states. Axe runs after every test.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  agentDetail,
  agentsSource,
  committedDefinition,
  DEFINITION_SOURCE,
} from "./agents.builders";

const { router, commitAgentDefinition } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  commitAgentDefinition: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./actions", () => ({ commitAgentDefinition }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { AgentSource } = await import("./agent-source");
const { AgentLoading } = await import("./page-states");
const { SourceEditor } = await import("./source-editor");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const PATH = ".oxagen/agents/release-bot.toml";
const AFTER = routes.agentSource("acme", "core-platform", "release-bot");

async function renderPage(reads: Parameters<typeof agentsSource>[0]) {
  const { source, calls } = agentsSource(reads);
  const element = await AgentSource({ ctx, source, agent: "release-bot" });
  render(<IntlProvider>{element}</IntlProvider>);
  return calls;
}

function editorElement(base = DEFINITION_SOURCE) {
  return (
    <IntlProvider>
      <SourceEditor
        org="acme"
        ws="core-platform"
        agentId="agt_releasebot"
        agentKey="acme.core.release-bot"
        slug="release-bot"
        path={PATH}
        base={base}
        branch="agents/release-bot"
        commit="9c1e2f0"
        repository="acme/core"
        back={routes.agent("acme", "core-platform", "release-bot", {
          tab: "definition",
        })}
        after={AFTER}
      />
    </IntlProvider>
  );
}

function renderEditor(base = DEFINITION_SOURCE) {
  return render(editorElement(base));
}

const editor = () => screen.getByRole("textbox", { name: PATH });
const button = (name: string) => screen.getByRole("button", { name });
const edit = (text: string) => {
  fireEvent.change(editor(), { target: { value: text } });
};

beforeEach(() => {
  router.replace.mockReset();
  router.refresh.mockReset();
  commitAgentDefinition.mockReset();
  window.sessionStorage.clear();
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("AgentSource", () => {
  it("opens the committed file under the path, its chips and the three actions", async () => {
    const calls = await renderPage({
      get: readOk(agentDetail({ definition: committedDefinition() })),
    });
    expect(calls.get).toEqual([[ctx, "release-bot"]]);
    expect(screen.getByText("Agent source")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(PATH);
    expect(
      within(screen.getByRole("list", { name: "Definition file" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "acme/core",
      "agents/release-bot @ 9c1e2f0",
      "source of truth",
      "acme.core.release-bot",
    ]);
    expect(
      screen.getByText(
        "Every field on the agent form is a view of this file. Saving opens the same commit dialog the form uses; nothing is written to Postgres.",
      ),
    ).toBeInTheDocument();
    expect(editor()).toHaveValue(DEFINITION_SOURCE);
    expect(screen.getByTestId("draft-state")).toHaveTextContent("unchanged");
    expect(
      screen.getByRole("link", { name: "Back to the form" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot/definition",
    );
    expect(button("Discard")).toBeDisabled();
    expect(button("Save")).toBeEnabled();
  });

  it("seeds an agent with no committed file and says no commit is recorded", async () => {
    await renderPage({
      get: readOk(
        agentDetail({
          identity: { description: 'Cuts "releases".', agentKey: null },
        }),
      ),
    });
    expect(editor()).toHaveValue(
      'schema = "agent-definition/v0.1"\nslug = "release-bot"\nname = "Release bot"\ndescription = "Cuts \\"releases\\"."\n',
    );
    expect(
      within(screen.getByRole("list", { name: "Definition file" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "no repository recorded",
      "no committed definition",
      "source of truth",
    ]);
    expect(button("Save")).toBeEnabled();
  });

  it("is a 404 for an agent the workspace does not have (negative)", async () => {
    const { source } = agentsSource({ get: readError("not_found", 404) });
    await expect(AgentSource({ ctx, source, agent: "nobody" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it("replaces the body with the denied state, naming the permission (negative)", async () => {
    await renderPage({
      get: { ok: false, reason: "denied", permission: "agent.write" },
    });
    const denied = screen.getByTestId("source-denied");
    expect(denied).toHaveTextContent("You cannot see this agent’s definition");
    expect(denied).toHaveTextContent(
      "Your roles on Acme Robotics do not include agent.write on core-platform. An organization owner can grant it; the grant is a governed action and lands in the audit record with your name on it.",
    );
    expect(denied).toHaveTextContent("Signed in as");
    expect(denied).toHaveTextContent("Neededagent.write on core-platform");
    expect(denied).toHaveTextContent("Decided by");
    expect(
      within(denied).getByRole("link", { name: "Back to Fleet" }),
    ).toHaveAttribute("href", "/acme/core-platform");
    await userEvent.click(
      within(denied).getByRole("button", { name: "Request access" }),
    );
    expect(screen.getByTestId("source-request-access-sheet")).toHaveTextContent(
      "No contract records an access request yet, so nothing is sent.",
    );
    expect(screen.queryByRole("textbox", { name: PATH })).toBeNull();
  });

  it("replaces the body with the error state, naming the code (negative)", async () => {
    await renderPage({ get: readError("git_read_unreachable", 502) });
    const error = screen.getByTestId("source-error");
    expect(error).toHaveTextContent("This file could not be loaded");
    expect(error).toHaveTextContent(
      "The control plane answered 502 git_read_unreachable. Nothing was changed. Runs kept recording while this page was down.",
    );
    expect(screen.getByTestId("state-trace")).toHaveTextContent(
      "502 git_read_unreachable · read at",
    );
    expect(
      within(error).getByRole("link", { name: "Try again" }),
    ).toHaveAttribute("href", AFTER);
    await userEvent.click(
      within(error).getByRole("button", { name: "Open an incident" }),
    );
    expect(screen.getByTestId("source-open-incident-sheet")).toHaveTextContent(
      "No contract files an incident yet, so nothing is sent.",
    );
  });

  it("holds the page's place with a skeleton and no editor while loading", () => {
    render(
      <IntlProvider>
        <AgentLoading />
      </IntlProvider>,
    );
    const loading = screen.getByRole("status");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveTextContent("Loading this agent");
    expect(screen.queryByRole("textbox")).toBeNull();
    // The streamed page owns main#main; the fallback beside it must not.
    expect(document.getElementById("main")).toBeNull();
  });
});

describe("SourceEditor", () => {
  it("draws the editor bar, the status line and exactly one primary action", () => {
    renderEditor();
    expect(
      screen.getByRole("searchbox", { name: "Find in file" }),
    ).toBeVisible();
    const status = screen.getByTestId("editor-status");
    expect(status).toHaveTextContent("Ln 1, Col 1");
    for (const word of ["TOML", "Spaces: 2", "LF", "UTF-8"]) {
      expect(status).toHaveTextContent(word);
    }
    expect(status).toHaveTextContent(
      "⌘S save · Tab indent · ⇧Tab outdent · ⌘/ comment · ⌘F find · ⌘Z undo",
    );
    expect(
      screen
        .getAllByRole("button")
        .filter((b) => b.className.includes("bg-button-primary-bg"))
        .map((b) => b.textContent),
    ).toEqual(["Save"]);
  });

  it("counts the matches of a find and steps through them with Enter", async () => {
    renderEditor();
    const find = screen.getByRole("searchbox", { name: "Find in file" });
    await userEvent.type(find, "release");
    expect(screen.getByTestId("find-count")).toHaveTextContent("3");
    await userEvent.type(find, "{Enter}");
    expect(screen.getByTestId("find-count")).toHaveTextContent("1 of 3");
  });

  it("indents with Tab, comments with ⌘/ and opens the commit dialog with ⌘S", () => {
    renderEditor('schema = "agent-definition/v0.1"\nslug = "release-bot"\n');
    const area = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: PATH,
    });
    area.setSelectionRange(0, 0);
    fireEvent.keyDown(area, { key: "Tab" });
    expect(area.value.startsWith('  schema = "agent-definition/v0.1"')).toBe(
      true,
    );
    area.setSelectionRange(0, 0);
    fireEvent.keyDown(area, { key: "Tab", shiftKey: true });
    expect(area.value.startsWith('schema = "agent-definition/v0.1"')).toBe(
      true,
    );
    area.setSelectionRange(0, 0);
    fireEvent.keyDown(area, { key: "/", metaKey: true });
    expect(area.value.startsWith('# schema = "agent-definition/v0.1"')).toBe(
      true,
    );
    fireEvent.keyDown(area, { key: "s", metaKey: true });
    expect(screen.getByTestId("commit-definition")).toBeVisible();
  });

  it("keeps an uncommitted draft across a remount, as the form and the editor share it", () => {
    const first = renderEditor();
    const draft = DEFINITION_SOURCE.replace('"complex"', '"light"');
    edit(draft);
    first.unmount();
    renderEditor();
    expect(editor()).toHaveValue(draft);
    expect(screen.getByTestId("draft-state")).toHaveTextContent("modified");
  });

  it.each([
    DEFINITION_SOURCE.replace('slug = "release-bot"', 'slug = "renamed"'),
    DEFINITION_SOURCE.replace('slug = "release-bot"', "# slug removed"),
  ])(
    "blocks a changed or missing registered slug before commit (negative)",
    async (draft) => {
      renderEditor();
      edit(draft);
      expect(screen.getByTestId("source-slug-error")).toHaveTextContent(
        'Restore slug = "release-bot" before saving.',
      );
      expect(button("Save")).toBeDisabled();
      expect(commitAgentDefinition).not.toHaveBeenCalled();
      await userEvent.click(button("Discard"));
      expect(screen.queryByTestId("source-slug-error")).toBeNull();
      expect(button("Save")).toBeEnabled();
    },
  );

  it("marks an edit modified, and Discard returns to the base", async () => {
    renderEditor();
    expect(button("Discard")).toBeDisabled();
    edit(DEFINITION_SOURCE.replace('"complex"', '"light"'));
    expect(screen.getByTestId("draft-state")).toHaveTextContent("modified");
    expect(screen.getByTestId("draft-state")).toHaveAttribute(
      "data-dirty",
      "true",
    );
    await userEvent.click(button("Discard"));
    expect(editor()).toHaveValue(DEFINITION_SOURCE);
    expect(screen.getByTestId("draft-state")).toHaveTextContent("unchanged");
  });

  it("names the line a draft does not parse at and refuses to save it (negative)", () => {
    renderEditor();
    edit('schema = "agent-definition/v0.1"\nname = "open\n');
    expect(screen.getByTestId("parse-error")).toHaveTextContent(
      "The file does not parse at line 2: a string is not closed.",
    );
    expect(button("Save")).toBeDisabled();
    edit(
      'schema = "agent-definition/v0.1"\nslug = "release-bot"\nname = "closed"\n',
    );
    expect(screen.queryByTestId("parse-error")).toBeNull();
    expect(button("Save")).toBeEnabled();
  });

  it("holds the commit until a summary is written, offers a new branch, then commits the draft", async () => {
    commitAgentDefinition.mockResolvedValue({
      ok: true,
      value: {
        branch: "agents/light",
        commitSha: "4d5e6f7",
        pullRequest: {
          number: 12,
          url: "https://github.com/acme/core/pull/12",
        },
      },
    });
    renderEditor();
    const draft = DEFINITION_SOURCE.replace('"complex"', '"light"');
    edit(draft);
    await userEvent.click(button("Save"));
    const dialog = screen.getByTestId("commit-definition");
    expect(dialog).toHaveTextContent("Commit the definition");
    expect(dialog).toHaveAttribute("role", "dialog");
    const submit = within(dialog).getByRole("button", {
      name: "Commit and open a pull request",
    });
    expect(submit).toBeDisabled();
    expect(
      within(dialog).getByRole("checkbox", { name: /Open a pull request/ }),
    ).toBeChecked();
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox"),
      "+ New branch",
    );
    await userEvent.type(
      within(dialog).getByLabelText("New branch name"),
      "agents/light",
    );
    await userEvent.type(
      within(dialog).getByLabelText(/Summary/),
      "Light tier",
    );
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(commitAgentDefinition).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        agentId: "agt_releasebot",
        branch: "agents/light",
        message: "Light tier",
        source: draft,
      },
    );
    expect(await screen.findByTestId("commit-done")).toHaveTextContent(
      "Committed 4d5e6f7 to agents/light.Pull request 12: https://github.com/acme/core/pull/12",
    );
    expect(router.replace).toHaveBeenCalledWith(AFTER);
  });

  it.each([
    ["branch", "Name a branch: letters, digits, dots, slashes and hyphens"],
    ["message", "The message is at most 200 characters."],
    ["source", "The file is empty or larger than 64 KB."],
  ])(
    "names an invalid %s and reloads nothing (negative)",
    async (field, text) => {
      commitAgentDefinition.mockResolvedValue({
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field,
      });
      renderEditor();
      await userEvent.click(button("Save"));
      await userEvent.type(screen.getByLabelText(/Summary/), "x");
      await userEvent.click(
        screen.getByRole("button", { name: "Commit and open a pull request" }),
      );
      expect(
        await screen.findByText(text, { exact: false }),
      ).toBeInTheDocument();
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it("names a refused commit and reloads nothing (negative)", async () => {
    commitAgentDefinition.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "branch_is_default",
    });
    renderEditor();
    await userEvent.click(button("Save"));
    await userEvent.type(screen.getByLabelText(/Summary/), "x");
    await userEvent.click(
      screen.getByRole("button", { name: "Commit and open a pull request" }),
    );
    expect(await screen.findByTestId("commit-failure")).toHaveTextContent(
      "That branch is the repository's default branch. Choose another branch.",
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("names a commit that threw before it answered (negative)", async () => {
    commitAgentDefinition.mockRejectedValue(new Error("network"));
    renderEditor();
    await userEvent.click(button("Save"));
    await userEvent.type(screen.getByLabelText(/Summary/), "x");
    await act(async () => {
      await userEvent.click(
        screen.getByRole("button", { name: "Commit and open a pull request" }),
      );
    });
    expect(await screen.findByTestId("commit-failure")).toHaveTextContent(
      "The change could not be made: action_failed.",
    );
  });
});

describe("SourceEditor find and keys", () => {
  const findBox = () => screen.getByRole("searchbox", { name: "Find in file" });
  const count = () => screen.getByTestId("find-count");

  it("steps backwards from the last match with ⇧Enter, wraps forwards, and Escape clears the find", async () => {
    renderEditor();
    await userEvent.type(findBox(), "release");
    await userEvent.type(findBox(), "{Shift>}{Enter}{/Shift}");
    expect(count()).toHaveTextContent("3 of 3");
    await userEvent.type(findBox(), "{Shift>}{Enter}{/Shift}");
    expect(count()).toHaveTextContent("2 of 3");
    // Each press is typed into the find box afresh: a jump moves focus to the
    // editor, so a second Enter in one burst would land there instead.
    await userEvent.type(findBox(), "{Enter}");
    expect(count()).toHaveTextContent("3 of 3");
    await userEvent.type(findBox(), "{Enter}");
    expect(count()).toHaveTextContent("1 of 3");
    await userEvent.type(findBox(), "{Escape}");
    expect(findBox()).toHaveValue("");
    expect(count()).toBeEmptyDOMElement();
    expect(editor()).toHaveFocus();
  });

  it("hands focus to the editor with the match selected, so a second Enter replaces the match (characterization)", async () => {
    // A wart, pinned rather than fixed: jump() focuses the textarea so the
    // selection is painted, and the next Enter is then typed into the file
    // over the selected match. Changing it is a focus-model decision (a
    // textarea paints no selection without focus), so this test records the
    // behaviour until that decision is made.
    renderEditor();
    await userEvent.type(findBox(), "release{Enter}");
    expect(editor()).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(count()).toHaveTextContent("1 of 2");
    expect(editor()).not.toHaveValue(DEFINITION_SOURCE);
  });

  it("moves nowhere on Enter when nothing matches (negative)", async () => {
    renderEditor();
    await userEvent.type(findBox(), "zzz{Enter}");
    expect(count()).toHaveTextContent("0");
    expect(findBox()).toHaveFocus();
  });

  it("focuses the find with ⌘F, and leaves the text alone for a key it does not bind (negative)", () => {
    renderEditor();
    const area = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: PATH,
    });
    fireEvent.keyDown(area, { key: "f", ctrlKey: true });
    expect(findBox()).toHaveFocus();
    fireEvent.keyDown(area, { key: "Tab", metaKey: true });
    fireEvent.keyDown(area, { key: "a" });
    expect(area).toHaveValue(DEFINITION_SOURCE);
  });
});

describe("CommitDialog", () => {
  it("sends nothing when the form is submitted with no summary (negative)", async () => {
    renderEditor();
    await userEvent.click(button("Save"));
    const dialog = screen.getByTestId("commit-definition");
    const form = dialog.querySelector("form");
    if (form === null) throw new Error("commit form not drawn");
    fireEvent.submit(form);
    expect(commitAgentDefinition).not.toHaveBeenCalled();
  });

  it("names an invalid new branch on its own field, and clears the refusal when the dialog closes", async () => {
    commitAgentDefinition.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "branch",
    });
    renderEditor();
    await userEvent.click(button("Save"));
    let dialog = screen.getByTestId("commit-definition");
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox"),
      "+ New branch",
    );
    await userEvent.type(
      within(dialog).getByLabelText("New branch name"),
      "refs/heads/x",
    );
    await userEvent.type(within(dialog).getByLabelText(/Summary/), "x");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Commit and open a pull request",
      }),
    );
    expect(
      await within(dialog).findByText(/Name a branch: letters, digits/),
    ).toBeInTheDocument();
    // The error sits on the field, not in the dialog's alert.
    expect(within(dialog).queryByTestId("commit-failure")).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByTestId("commit-definition")).toBeNull();
    await userEvent.click(button("Save"));
    dialog = screen.getByTestId("commit-definition");
    expect(
      within(dialog).queryByText(/Name a branch: letters, digits/),
    ).toBeNull();
  });
});
