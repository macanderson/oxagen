// @vitest-environment jsdom
// The agent wizard as a person drives it, through the host the workspace
// layout mounts: describe the job, name the identity, read the drafted
// definition, pick a belt from the registry, and open the pull request. The
// cases pin what propose_agent is sent, that the one gold control waits on
// what its step needs, that a hand-edited file is not overwritten by a belt
// pick, that a failed check is named where the person acted with nothing
// written, and that the pull request step refuses to send while the
// workspace binds no main repository. Each state gets an axe check.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCreate } from "@/shared/create";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";

const { readMainRepository, proposeAgent, readToolbelt } = vi.hoisted(() => ({
  readMainRepository: vi.fn(),
  proposeAgent: vi.fn(),
  readToolbelt: vi.fn(),
}));
vi.mock("./actions", () => ({
  readMainRepository,
  proposeAgent,
  readToolbelt,
  proposeSkill: vi.fn(),
}));

// Await real module transformation before asserting UI behavior.
const { WIZARDS } = await import("./kinds");
await Promise.all([WIZARDS.agent?.()]);

const { CreateHost } = await import("./create-host");

const t = translator("createAgent");
const shell = translator("create");

const DESC = "Watch the performance budget on every pull request";
const SLUG = "watch-performance";

const PR_TOOL = {
  slug: "github__create_pull_request",
  name: "Create pull request",
  version: 3,
  riskGrade: "medium",
  sideEffect: "write",
  financial: false,
  killed: false,
};
const REFUND = {
  slug: "stripe__refund",
  name: "Refund a charge",
  version: 1,
  riskGrade: "high",
  sideEffect: "irreversible",
  financial: true,
  killed: false,
};

function mount() {
  render(
    <IntlProvider>
      <CreateHost org="acme" ws="core-platform" wsName="Core platform" />
    </IntlProvider>,
  );
  act(() => {
    openCreate("agent");
  });
}

const primary = () => screen.getByTestId<HTMLButtonElement>("wizard-primary");

function currentStep(): string {
  return (
    screen.getByTestId("wizard-rail").querySelector('[aria-current="step"]')
      ?.textContent ?? ""
  );
}

async function toIdentity(desc = DESC) {
  mount();
  const field = await screen.findByTestId<HTMLTextAreaElement>("wizard-desc");
  fireEvent.input(field, { target: { value: desc } });
  fireEvent.click(primary());
  return screen.findByTestId<HTMLInputElement>("wizard-slug");
}

function chooseHarness(value: string) {
  fireEvent.change(screen.getByTestId("wizard-harness"), {
    target: { value },
  });
}

async function toDefinition(harness = "cursor") {
  await toIdentity();
  chooseHarness(harness);
  fireEvent.click(primary());
  return screen.findByTestId<HTMLTextAreaElement>("wizard-file");
}

async function toToolbelt(harness = "cursor") {
  await toDefinition(harness);
  fireEvent.click(primary());
  await waitFor(() => {
    expect(currentStep()).toContain(shell("steps.toolbelt"));
  });
}

async function toPullRequest(harness = "cursor") {
  await toToolbelt(harness);
  await screen.findByTestId("belt");
  fireEvent.click(primary());
  await screen.findByTestId("pr-branch");
  await waitFor(() => {
    expect(screen.queryByText(t("pr.repo.loading"))).toBeNull();
  });
}

function opened(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    value: {
      slug: SLUG,
      agentKey: "acme.core.watch-performance",
      path: `.oxagen/agents/${SLUG}.toml`,
      generatedPath: `.claude/agents/${SLUG}.md`,
      branch: `agents/${SLUG}`,
      repository: "acme/platform",
      baseRef: "main",
      digest: `sha256:${"a".repeat(64)}`,
      pullRequest: {
        number: 526,
        url: "https://github.com/acme/platform/pull/526",
      },
      ...over,
    },
  };
}

beforeEach(() => {
  readMainRepository.mockReset();
  proposeAgent.mockReset();
  readToolbelt.mockReset();
  readMainRepository.mockResolvedValue({
    ok: true,
    value: { fullName: "acme/platform", defaultRef: "main" },
  });
  readToolbelt.mockResolvedValue({
    ok: true,
    value: { tools: [PR_TOOL, REFUND], more: false },
  });
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the agent wizard: describe", () => {
  it("opens on Describe with five steps, and says it is not Register an agent", async () => {
    mount();
    await screen.findByTestId("create-agent");
    expect(currentStep()).toContain(shell("steps.describe"));
    const rail = screen.getByTestId("wizard-rail").textContent;
    for (const step of ["identity", "definition", "toolbelt", "pullRequest"])
      expect(rail).toContain(shell(`steps.${step}`));
    expect(screen.getByTestId("not-register").textContent).toBe(
      t("describe.notRegister"),
    );
    // The footer names the grant.
    expect(screen.getByText("agent.write")).toBeTruthy();
  });

  it("enables Draft it once there is a description, without rebuilding the field", async () => {
    mount();
    const field = await screen.findByTestId<HTMLTextAreaElement>("wizard-desc");
    expect(primary().disabled).toBe(true);
    expect(primary().textContent).toBe(t("draftIt"));
    fireEvent.input(field, { target: { value: "Watch" } });
    expect(primary().disabled).toBe(false);
    fireEvent.input(field, { target: { value: "Watch the budget" } });
    expect(screen.getByTestId("wizard-desc")).toBe(field);
    fireEvent.input(field, { target: { value: "  " } });
    expect(primary().disabled).toBe(true);
  });

  it("fills the description from a suggestion", async () => {
    mount();
    await screen.findByTestId("wizard-desc");
    fireEvent.click(screen.getByText(t("describe.suggestions.triage")));
    expect(screen.getByTestId<HTMLTextAreaElement>("wizard-desc").value).toBe(
      t("describe.suggestions.triage"),
    );
    expect(primary().disabled).toBe(false);
  });
});

describe("the agent wizard: identity", () => {
  it("derives the slug from the description and waits for a harness, preselecting none", async () => {
    const slug = await toIdentity();
    expect(slug.value).toBe(SLUG);
    expect(screen.getByTestId<HTMLSelectElement>("wizard-harness").value).toBe(
      "",
    );
    expect(primary().disabled).toBe(true);
    chooseHarness("codex");
    expect(primary().disabled).toBe(false);
  });

  it("refuses a slug register_agent would refuse, and says why (negative)", async () => {
    const slug = await toIdentity();
    chooseHarness("stella");
    fireEvent.change(slug, {
      target: { value: "a-very-long-agent-slug-here" },
    });
    expect(screen.getByText(t("identity.slugInvalid"))).toBeTruthy();
    expect(slug.getAttribute("aria-invalid")).toBe("true");
    expect(primary().disabled).toBe(true);
    fireEvent.change(slug, { target: { value: "Perf Watch" } });
    expect(slug.value).toBe("perf-watch");
    expect(primary().disabled).toBe(false);
  });
});

describe("the agent wizard: definition", () => {
  it("moves source edits with an identity rename and never revives them after revert", async () => {
    const file = await toDefinition();
    fireEvent.change(file, {
      target: { value: `${file.value}# custom instructions\n` },
    });
    const renameIdentity = async (slug: string) => {
      fireEvent.click(screen.getByRole("button", { name: shell("back") }));
      fireEvent.change(await screen.findByTestId("wizard-slug"), {
        target: { value: slug },
      });
      fireEvent.click(primary());
      return screen.findByTestId<HTMLTextAreaElement>("wizard-file");
    };
    const renamed = await renameIdentity("renamed-agent");
    expect(renamed.value).toContain('slug = "renamed-agent"');
    expect(renamed.value).toContain("# custom instructions");
    fireEvent.click(
      screen.getByRole("button", { name: t("definition.revert") }),
    );
    expect(renamed.value).not.toContain("# custom instructions");
    const original = await renameIdentity(SLUG);
    expect(original.value).toContain(`slug = "${SLUG}"`);
    expect(original.value).not.toContain("# custom instructions");
  });

  it("drafts the definition, says who drafted it, and reads the file back", async () => {
    const file = await toDefinition();
    expect(currentStep()).toContain(shell("steps.definition"));
    expect(screen.getByTestId("draft-note")).toBeTruthy();
    expect(file.value).toContain(`slug = "${SLUG}"`);
    expect(file.value).toContain('schema = "agent-definition/v0.1"');
    expect(file.value).toContain("[harness.cursor]");
    expect(file.value).toContain(DESC);
    expect(screen.getByTestId("derived").textContent).toContain(SLUG);
    expect(primary().disabled).toBe(false);
  });

  it("keeps an edit across Back and Next, and Revert returns the draft", async () => {
    const revert = () =>
      screen.getByRole<HTMLButtonElement>("button", {
        name: t("definition.revert"),
      });
    const file = await toDefinition();
    expect(revert().disabled).toBe(true);
    fireEvent.change(file, { target: { value: `${file.value}# mine\n` } });
    expect(revert().disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: shell("back") }));
    await screen.findByTestId("wizard-slug");
    fireEvent.click(primary());
    const again = await screen.findByTestId<HTMLTextAreaElement>("wizard-file");
    expect(again.value).toContain("# mine");

    fireEvent.click(revert());
    expect(
      screen.getByTestId<HTMLTextAreaElement>("wizard-file").value,
    ).not.toContain("# mine");
  });

  it("will not go on while the file does not parse, and names the line (negative)", async () => {
    const file = await toDefinition();
    fireEvent.change(file, { target: { value: "tools = [\n" } });
    expect(screen.getByTestId("derived").textContent).toContain("line");
    expect(primary().disabled).toBe(true);
  });

  it("derives the path, identity, and pull request from an edited source slug", async () => {
    const file = await toDefinition();
    fireEvent.change(file, {
      target: {
        value: file.value.replace(`slug = "${SLUG}"`, 'slug = "other"'),
      },
    });
    expect(screen.getByTestId("derived").textContent).toContain("other");
    expect(
      screen.getByRole("button", { name: "Rename .oxagen/agents/other.toml" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: shell("back") }));
    expect(
      (await screen.findByTestId<HTMLInputElement>("wizard-slug")).value,
    ).toBe("other");
    fireEvent.click(primary());
    expect(
      (await screen.findByTestId<HTMLTextAreaElement>("wizard-file")).value,
    ).toContain('slug = "other"');
    fireEvent.click(primary());
    await screen.findByTestId("belt");
    fireEvent.click(primary());
    await screen.findByTestId("pr-branch");
    expect(screen.getByTestId("pr-branch").textContent).toBe("agents/other");
    proposeAgent.mockResolvedValue(opened());
    fireEvent.click(primary());
    await screen.findByTestId("pr-opened");
    expect(proposeAgent).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      expect.objectContaining({
        slug: "other",
        source: file.value,
      }),
    );
  });

  it("renames from anywhere on the header filename and preserves the source body", async () => {
    const file = await toDefinition();
    fireEvent.change(file, {
      target: { value: `${file.value}# Keep this comment\n` },
    });
    const before = file.value;
    fireEvent.click(screen.getByText(`.oxagen/agents/${SLUG}.toml`));
    const name = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Source name",
    });
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: "budget-watch" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(file.value).toContain('slug = "budget-watch"');
    expect(
      file.value.replace('slug = "budget-watch"', `slug = "${SLUG}"`),
    ).toBe(before);
    expect(
      screen.getByRole("button", {
        name: "Rename .oxagen/agents/budget-watch.toml",
      }),
    ).toBe(document.activeElement);
  });

  it.each(['slug = "bad/name"', 'slug = ""', 'name = "No slug"'])(
    "blocks an invalid source identifier: %s",
    async (source) => {
      const file = await toDefinition();
      fireEvent.change(file, { target: { value: source } });
      expect(primary().disabled).toBe(true);
    },
  );
});

describe("the agent wizard: toolbelt", () => {
  it("offers the registry, writes a pick into the definition, and says what parks", async () => {
    await toToolbelt();
    const belt = await screen.findByTestId("belt");
    expect(readToolbelt).toHaveBeenCalledWith("acme", "core-platform");
    expect(belt.textContent).toContain("github__create_pull_request@3");
    expect(screen.getByTestId("belt-note").textContent).toContain(
      "search_graph",
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: /Create pull request/ }),
    );
    expect(screen.getByTestId("belt-note").textContent).toBe(
      t("toolbelt.noneParks"),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Refund a charge/ }));
    expect(screen.getByTestId("belt-note").textContent).not.toBe(
      t("toolbelt.noneParks"),
    );
    expect(screen.getByTestId("belt-note").textContent).toContain("park");

    // Back to the file: both picks are in it.
    fireEvent.click(screen.getByRole("button", { name: shell("back") }));
    const file = await screen.findByTestId<HTMLTextAreaElement>("wizard-file");
    expect(file.value).toContain(
      'tools = ["github__create_pull_request@3", "stripe__refund@1"]',
    );
  });

  it("leaves a hand-edited definition alone and says so", async () => {
    const file = await toDefinition();
    fireEvent.change(file, { target: { value: `${file.value}# mine\n` } });
    fireEvent.click(primary());
    await screen.findByTestId("belt");
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Create pull request/ }),
    );
    expect(screen.getByTestId("belt-hand-edited").textContent).toBe(
      t("toolbelt.handEdited"),
    );
    fireEvent.click(screen.getByRole("button", { name: shell("back") }));
    const again = await screen.findByTestId<HTMLTextAreaElement>("wizard-file");
    expect(again.value).toContain("# mine");
    expect(again.value).not.toContain("github__create_pull_request@3");
  });

  it("says the registry is empty and lets the person go on (empty)", async () => {
    readToolbelt.mockResolvedValue({
      ok: true,
      value: { tools: [], more: false },
    });
    await toToolbelt();
    expect((await screen.findByTestId("belt-empty")).textContent).toBe(
      t("toolbelt.empty"),
    );
    expect(primary().disabled).toBe(false);
  });

  it("names a refused registry read and lets the person go on (denied)", async () => {
    readToolbelt.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "tool.read",
    });
    await toToolbelt();
    expect((await screen.findByTestId("belt-state")).textContent).toBe(
      t("toolbelt.denied"),
    );
    expect(primary().disabled).toBe(false);
  });

  it("treats a registry read that throws as unavailable (negative)", async () => {
    readToolbelt.mockRejectedValue(new Error("network"));
    await toToolbelt();
    expect((await screen.findByTestId("belt-state")).textContent).toBe(
      t("toolbelt.unavailable", { code: "unanswered" }),
    );
  });

  it("shows the registry as loading until it answers (loading)", async () => {
    let answer: (value: unknown) => void = () => undefined;
    readToolbelt.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await toToolbelt();
    expect(screen.getByText(t("toolbelt.loading"))).toBeTruthy();
    await act(() => {
      answer({ ok: true, value: { tools: [PR_TOOL], more: true } });
      return Promise.resolve();
    });
    expect(await screen.findByTestId("belt")).toBeTruthy();
    expect(screen.getByText(t("toolbelt.more"))).toBeTruthy();
  });
});

describe("the agent wizard: pull request", () => {
  it("shows only the definition for Codex", async () => {
    await toPullRequest("codex");
    expect(screen.getByText(`.oxagen/agents/${SLUG}.toml`)).toBeTruthy();
    expect(screen.queryByText(`.claude/agents/${SLUG}.md`)).toBeNull();
  });

  it("plans the definition and the generated file, then opens the pull request with the file the person saw", async () => {
    proposeAgent.mockResolvedValue(opened());
    await toPullRequest();
    expect(screen.getByTestId("pr-branch").textContent).toBe(`agents/${SLUG}`);
    expect(screen.getByText(`.oxagen/agents/${SLUG}.toml`)).toBeTruthy();
    expect(screen.getByText(`.claude/agents/${SLUG}.md`)).toBeTruthy();
    expect(await screen.findByText("acme/platform:main")).toBeTruthy();

    fireEvent.click(primary());
    await screen.findByTestId("pr-opened");
    expect(proposeAgent).toHaveBeenCalledTimes(1);
    const call: unknown[] = proposeAgent.mock.calls[0] ?? [];
    expect(call.slice(0, 2)).toEqual(["acme", "core-platform"]);
    expect(call[2]).toMatchObject({
      slug: SLUG,
      harness: "cursor",
      rationale: DESC,
    });
    expect(call[2]).toHaveProperty(
      "source",
      expect.stringContaining(`slug = "${SLUG}"`),
    );

    const link = screen.getByRole("link", { name: "acme/platform#526" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/platform/pull/526",
    );
    expect(screen.getByTestId("pr-opened").textContent).toContain(
      "acme.core.watch-performance",
    );
    expect(screen.getByText(t("opened.register"))).toBeTruthy();
    // Once the pull request is open the only way on is Close.
    expect(screen.queryByTestId("wizard-primary")).toBeNull();
    expect(screen.getByRole("button", { name: shell("close") })).toBeTruthy();
  });

  it("names a failed check where the person acted, and stays on the step (negative)", async () => {
    proposeAgent.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "agent_check_key",
    });
    await toPullRequest();
    fireEvent.click(primary());
    expect((await screen.findByTestId("pr-failure")).textContent).toBe(
      t("failure.checkKey"),
    );
    expect(screen.queryByTestId("pr-opened")).toBeNull();
    expect(primary().disabled).toBe(false);
  });

  it("says a leftover proposal branch must be removed or its pull request reopened (negative)", async () => {
    proposeAgent.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "proposal_branch_exists",
    });
    await toPullRequest();
    fireEvent.click(primary());
    expect((await screen.findByTestId("pr-failure")).textContent).toBe(
      t("failure.branchExists"),
    );
    expect(screen.queryByTestId("pr-opened")).toBeNull();
  });

  it("names a refusal it has no sentence for by its code (negative)", async () => {
    proposeAgent.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "some_new_code",
    });
    await toPullRequest();
    fireEvent.click(primary());
    expect((await screen.findByTestId("pr-failure")).textContent).toBe(
      t("failure.refused", { code: "some_new_code" }),
    );
  });

  it("treats an action that throws as unanswered, with nothing written (negative)", async () => {
    proposeAgent.mockRejectedValue(new Error("network"));
    await toPullRequest();
    fireEvent.click(primary());
    expect((await screen.findByTestId("pr-failure")).textContent).toBe(
      t("failure.unanswered"),
    );
  });

  it("will not open a pull request while the workspace binds no main repository (negative)", async () => {
    readMainRepository.mockResolvedValue({ ok: true, value: null });
    await toPullRequest();
    expect((await screen.findByTestId("repo-state")).textContent).toBe(
      t("pr.repo.unbound"),
    );
    expect(primary().disabled).toBe(true);
    fireEvent.click(primary());
    expect(proposeAgent).not.toHaveBeenCalled();
  });

  it("says the repository read was refused (denied)", async () => {
    readMainRepository.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    await toPullRequest();
    expect((await screen.findByTestId("repo-state")).textContent).toBe(
      t("pr.repo.denied"),
    );
    expect(primary().disabled).toBe(true);
  });
});
