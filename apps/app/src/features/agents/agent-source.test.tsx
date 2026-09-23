// @vitest-environment jsdom
// The definition source page over a fake DataSource, and the editor itself:
// the committed file or the seed as the base, a parse error named at its line
// and blocking Save, modified with a diff stat and Discard, and the commit
// dialog's ok, invalid and refused outcomes. Axe runs after every test.
import {
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
const { AgentSource, AgentSourceLoading } = await import("./agent-source");
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

function renderEditor(base = DEFINITION_SOURCE) {
  render(
    <IntlProvider>
      <SourceEditor
        org="acme"
        ws="core-platform"
        agentId="agt_releasebot"
        slug="release-bot"
        path={PATH}
        base={base}
        branch="agents/release-bot"
        back={routes.agent("acme", "core-platform", "release-bot", {
          tab: "definition",
        })}
        after={AFTER}
      />
    </IntlProvider>,
  );
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
});

afterEach(async () => {
  await expectNoAxe(document.body);
  cleanup();
});

describe("AgentSource", () => {
  it("opens the committed file with the branch and commit it came from", async () => {
    const calls = await renderPage({
      get: readOk(agentDetail({ definition: committedDefinition() })),
    });
    expect(calls.get).toEqual([[ctx, "release-bot"]]);
    expect(
      within(screen.getByRole("list", { name: "Definition file" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      PATH,
      "agents/release-bot at 9c1e2f0",
      "source of truth",
      "acme.core.release-bot",
    ]);
    expect(editor()).toHaveValue(DEFINITION_SOURCE);
    expect(screen.getByTestId("draft-state")).toHaveTextContent("unchanged");
    expect(
      screen.getByRole("link", { name: "Back to the configuration" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/agents/release-bot/definition",
    );
  });

  it("seeds an agent with no committed file with the keys every file needs", async () => {
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
    ).toEqual([PATH, "no committed definition", "source of truth"]);
    expect(button("Save")).toBeEnabled();
  });

  it("is a 404 for an agent the workspace does not have (negative)", async () => {
    const { source } = agentsSource({ get: readError("not_found", 404) });
    await expect(AgentSource({ ctx, source, agent: "nobody" })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
  });

  it.each([
    [
      { ok: false, reason: "denied", permission: "agent.read" } as const,
      "You cannot see release-bot in this workspace. Your roles do not include agent.read",
    ],
    [
      readError("iam_principals_unavailable", 503),
      "release-bot could not be loaded: the control plane answered iam_principals_unavailable.",
    ],
  ])("draws a refused read with no editor (negative)", async (read, text) => {
    await renderPage({ get: read });
    expect(document.body).toHaveTextContent(text);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("holds the page's place with a labelled loading state", () => {
    render(
      <IntlProvider>
        <AgentSourceLoading />
      </IntlProvider>,
    );
    const loading = screen.getByRole("status");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveTextContent("Loading the definition file");
  });
});

describe("SourceEditor", () => {
  it.each([
    DEFINITION_SOURCE.replace('slug = "release-bot"', 'slug = "renamed"'),
    DEFINITION_SOURCE.replace('slug = "release-bot"', "# slug removed"),
  ])(
    "blocks a changed or missing registered slug before commit",
    async (draft) => {
      renderEditor();
      expect(
        screen.getByText(
          "This registered agent’s slug and filename are fixed.",
        ),
      ).toBeVisible();
      edit(draft);
      expect(screen.getByTestId("source-slug-error")).toHaveTextContent(
        'Restore slug = "release-bot" before saving.',
      );
      expect(button("Save")).toBeDisabled();
      expect(editor()).toHaveValue(draft);
      expect(commitAgentDefinition).not.toHaveBeenCalled();
      await userEvent.click(button("Discard"));
      expect(screen.queryByTestId("source-slug-error")).toBeNull();
      expect(button("Save")).toBeEnabled();
    },
  );

  it("marks an edit modified with its diff stat, and Discard returns to the base", async () => {
    renderEditor();
    expect(button("Discard")).toBeDisabled();
    edit(DEFINITION_SOURCE.replace('"complex"', '"light"'));
    expect(screen.getByTestId("draft-state")).toHaveTextContent("modified");
    expect(screen.getByTestId("draft-stat")).toHaveTextContent("+1 −1");
    await userEvent.click(button("Discard"));
    expect(editor()).toHaveValue(DEFINITION_SOURCE);
    expect(screen.getByTestId("draft-state")).toHaveTextContent("unchanged");
    expect(screen.queryByTestId("draft-stat")).toBeNull();
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

  it("commits the draft to the branch with its message, then reloads the page on the committed file", async () => {
    commitAgentDefinition.mockResolvedValue({
      ok: true,
      value: {
        branch: "agents/release-bot",
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
    expect(dialog).toHaveTextContent(`Commit ${PATH}`);
    expect(dialog).toHaveTextContent(
      "1 lines added and 1 removed against the file you started from.",
    );
    expect(within(dialog).getByLabelText("Branch")).toHaveValue(
      "agents/release-bot",
    );
    await userEvent.type(
      within(dialog).getByLabelText("Message"),
      "Light tier",
    );
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Commit and open a pull request",
      }),
    );
    expect(commitAgentDefinition).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        agentId: "agt_releasebot",
        branch: "agents/release-bot",
        message: "Light tier",
        source: draft,
      },
    );
    expect(await screen.findByTestId("commit-done")).toHaveTextContent(
      "Committed 4d5e6f7 to agents/release-bot.Pull request 12: https://github.com/acme/core/pull/12",
    );
    expect(router.replace).toHaveBeenCalledWith(AFTER);
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it.each([
    ["branch", "Name a branch: letters, digits, dots, slashes and hyphens"],
    ["message", "The message is at most 200 characters."],
    ["source", "The file is empty or larger than 64 KB."],
    ["agentId", "The request was refused as invalid. Nothing was changed."],
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
      await userEvent.click(
        screen.getByRole("button", { name: "Commit and open a pull request" }),
      );
      expect(
        await screen.findByText(text, { exact: false }),
      ).toBeInTheDocument();
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      { ok: false, reason: "denied", code: "delegation_ceiling" },
      "The file names tools you do not hold, so you cannot grant them to the agent. Nothing was committed.",
    ],
    [
      { ok: false, reason: "conflict", code: "no_repository" },
      "This workspace has no repository bound. Bind a repository to the workspace, then commit.",
    ],
    [
      { ok: false, reason: "conflict", code: "repository_ambiguous" },
      "This workspace binds more than one repository, so the commit has no single target. Nothing was committed.",
    ],
    [
      { ok: false, reason: "conflict", code: "branch_is_default" },
      "That branch is the repository's default branch. Choose another branch.",
    ],
    [
      { ok: false, reason: "conflict", code: "definition_schema" },
      "The file's schema line is missing or names another schema. Nothing was committed.",
    ],
    [
      { ok: false, reason: "conflict", code: "definition_slug" },
      "The file's slug does not match this agent's slug. Nothing was committed.",
    ],
    [
      { ok: false, reason: "not_found", code: "agent_not_found" },
      "This agent no longer exists.",
    ],
    [
      { ok: false, reason: "conflict", code: "github_ref_moved" },
      "The change was refused: github_ref_moved. Nothing was changed.",
    ],
    [
      { ok: false, reason: "unavailable", code: "github_unreachable" },
      "The change could not be made: github_unreachable. Nothing was changed.",
    ],
  ])(
    "names a refused commit and reloads nothing (negative)",
    async (result, text) => {
      commitAgentDefinition.mockResolvedValue(result);
      renderEditor();
      await userEvent.click(button("Save"));
      await userEvent.click(
        screen.getByRole("button", { name: "Commit and open a pull request" }),
      );
      expect(await screen.findByTestId("commit-failure")).toHaveTextContent(
        text,
      );
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it("names a commit that threw before it answered (negative)", async () => {
    commitAgentDefinition.mockRejectedValue(new Error("network"));
    renderEditor();
    await userEvent.click(button("Save"));
    await userEvent.click(
      screen.getByRole("button", { name: "Commit and open a pull request" }),
    );
    expect(await screen.findByTestId("commit-failure")).toHaveTextContent(
      "The change could not be made: action_failed.",
    );
  });
});
