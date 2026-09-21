// @vitest-environment jsdom
// The skill wizard as a person drives it, through the host the workspace
// layout mounts: choose a way in, describe the skill or upload a bundle, read
// the file, and open the pull request. The cases pin what propose_skill is
// sent, that the one gold control waits on what its step needs, that a failed
// check is named where the person acted with nothing written, and that the
// pull request step refuses to send while the workspace binds no main
// repository. Each state gets an axe check.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCreate } from "@/shared/create";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";

const { readMainRepository, proposeSkill, readBundle } = vi.hoisted(() => ({
  readMainRepository: vi.fn(),
  proposeSkill: vi.fn(),
  readBundle: vi.fn(),
}));
vi.mock("./actions", () => ({ readMainRepository, proposeSkill }));
vi.mock("./bundle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bundle")>()),
  readBundle,
}));

const { CreateHost } = await import("./create-host");
const { BundleReadError } = await import("./bundle");

const t = translator("create");
const DIGEST = `sha256:${"a".repeat(64)}`;

const BODY = [
  "---",
  "name: release-notes",
  "version: 2.2.0",
  "scope: workspace:core-platform",
  "---",
  "",
  "# Release notes",
  "",
].join("\n");

function mount() {
  render(
    <IntlProvider>
      <CreateHost org="acme" ws="core-platform" wsName="Core platform" />
    </IntlProvider>,
  );
  act(() => {
    openCreate("skill");
  });
}

const primary = () => screen.getByTestId<HTMLButtonElement>("wizard-primary");

function currentStep(): string {
  return (
    screen.getByTestId("wizard-rail").querySelector('[aria-current="step"]')
      ?.textContent ?? ""
  );
}

function opened(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    value: {
      name: "cut-release-notes-group",
      path: ".oxagen/skills/cut-release-notes-group/SKILL.md",
      branch: "skills/cut-release-notes-group",
      repository: "acme/platform",
      baseRef: "main",
      version: "0.1.0",
      replaces: null,
      digest: DIGEST,
      tokens: 180,
      budget: 6000,
      pullRequest: {
        number: 525,
        url: "https://github.com/acme/platform/pull/525",
      },
      ...overrides,
    },
  };
}

async function toDescribe() {
  mount();
  await screen.findByTestId("create-skill");
  fireEvent.click(
    screen.getByRole("button", {
      name: (name) => name.startsWith(t("skill.source.describe.title")),
    }),
  );
  fireEvent.click(primary());
  return screen.findByTestId<HTMLTextAreaElement>("wizard-desc");
}

async function toPullRequest(desc: string) {
  const field = await toDescribe();
  fireEvent.input(field, { target: { value: desc } });
  fireEvent.click(primary());
  await screen.findByTestId("wizard-file");
  fireEvent.click(primary());
  await screen.findByTestId("pr-branch");
  // The host reads the main repository as it opens; wait for the answer.
  await waitFor(() => {
    expect(screen.queryByText(t("skill.pr.repo.loading"))).toBeNull();
  });
}

beforeEach(() => {
  readMainRepository.mockReset();
  proposeSkill.mockReset();
  readBundle.mockReset();
  readMainRepository.mockResolvedValue({
    ok: true,
    value: { fullName: "acme/platform", defaultRef: "main" },
  });
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the skill wizard: source", () => {
  it("offers three ways in, keeps the registry closed and says why, and waits for a choice", async () => {
    mount();
    await screen.findByTestId("create-skill");
    expect(primary().disabled).toBe(true);
    const registry = screen
      .getByText(t("skill.source.registry.title"))
      .closest("button");
    expect(registry?.disabled).toBe(true);
    expect(screen.getByText(t("skill.source.registry.closed"))).toBeTruthy();

    fireEvent.click(screen.getByText(t("skill.source.upload.title")));
    expect(primary().disabled).toBe(false);
    // The path chosen decides the second step's name on the rail.
    expect(screen.getByTestId("wizard-rail").textContent).toContain(
      t("steps.upload"),
    );
  });
});

describe("the skill wizard: describe it", () => {
  it("follows source name edits and submits a header rename without changing other content", async () => {
    const user = userEvent.setup();
    const field = await toDescribe();
    fireEvent.input(field, { target: { value: "Cut release notes" } });
    fireEvent.click(primary());
    const file = await screen.findByTestId<HTMLTextAreaElement>("wizard-file");
    const edited = `${file.value.replace(/^name: .*$/m, "name: source-name")}\nKeep this body exactly.\n`;
    fireEvent.change(file, { target: { value: edited } });
    const path = ".oxagen/skills/source-name/SKILL.md";
    await user.click(screen.getByText(path));
    const name = screen.getByRole("textbox", {
      name: translator("ui.sourceFilename")("name"),
    });
    await user.clear(name);
    await user.type(name, "header-name{Enter}");
    const renamed = edited.replace("name: source-name", "name: header-name");
    expect(file).toHaveValue(renamed);
    expect(
      screen.getByText(".oxagen/skills/header-name/SKILL.md"),
    ).toBeVisible();
    fireEvent.click(primary());
    expect(await screen.findByTestId("pr-branch")).toHaveTextContent(
      "skills/header-name",
    );
    await waitFor(() => expect(primary()).toBeEnabled());
    proposeSkill.mockResolvedValue(opened({ name: "header-name" }));
    fireEvent.click(primary());
    await screen.findByTestId("pr-opened");
    expect(proposeSkill).toHaveBeenCalledWith("acme", "core-platform", {
      origin: "describe",
      name: "header-name",
      body: renamed,
      files: [],
      rationale: "Cut release notes",
    });
  });

  it("blocks a missing or invalid source name and restores the filename on revert", async () => {
    const field = await toDescribe();
    fireEvent.input(field, { target: { value: "Cut release notes" } });
    fireEvent.click(primary());
    const file = await screen.findByTestId<HTMLTextAreaElement>("wizard-file");
    const seed = file.value;
    for (const replacement of ["# name removed", "name: ../outside"]) {
      fireEvent.change(file, {
        target: { value: seed.replace(/^name: .*$/m, replacement) },
      });
      expect(primary()).toBeDisabled();
    }
    fireEvent.click(
      screen.getByRole("button", { name: t("skill.review.revert") }),
    );
    expect(file).toHaveValue(seed);
    expect(
      screen.getByText(".oxagen/skills/cut-release-notes/SKILL.md"),
    ).toBeVisible();
    expect(primary()).toBeEnabled();
    expect(proposeSkill).not.toHaveBeenCalled();
  });

  it("enables Draft the file once there is a description, without rebuilding the field", async () => {
    const field = await toDescribe();
    expect(currentStep()).toContain(t("steps.describeIt"));
    expect(primary().disabled).toBe(true);

    fireEvent.input(field, { target: { value: "How we cut" } });
    expect(primary().disabled).toBe(false);
    fireEvent.input(field, { target: { value: "How we cut release notes" } });
    // The same element: typing re-rendered nothing that would take the caret.
    expect(screen.getByTestId("wizard-desc")).toBe(field);

    fireEvent.input(field, { target: { value: "   " } });
    expect(primary().disabled).toBe(true);
  });

  it("drafts a SKILL.md the operator can edit and revert, and says who drafted it", async () => {
    const field = await toDescribe();
    fireEvent.input(field, {
      target: { value: "Cut release notes. Group merged PRs by surface." },
    });
    fireEvent.click(primary());
    const file = await screen.findByTestId<HTMLTextAreaElement>("wizard-file");
    expect(currentStep()).toContain(t("steps.review"));
    expect(screen.getByTestId("draft-note")).toBeTruthy();
    expect(file.value).toContain("version: 0.1.0");
    expect(file.value).toContain("scope: workspace:core-platform");
    // The rail ticks the two steps behind.
    expect(
      screen.getByTestId("wizard-rail").querySelectorAll('[data-state="done"]'),
    ).toHaveLength(2);

    const revert = screen.getByRole("button", {
      name: t("skill.review.revert"),
    });
    expect(revert).toHaveProperty("disabled", true);
    fireEvent.change(file, { target: { value: `${file.value}\nMore.` } });
    expect(revert).toHaveProperty("disabled", false);
    fireEvent.click(revert);
    expect(
      screen.getByTestId<HTMLTextAreaElement>("wizard-file").value,
    ).not.toContain("More.");
  });

  it("flags a file with no version before anybody opens the pull request (negative)", async () => {
    const field = await toDescribe();
    fireEvent.input(field, { target: { value: "Roll a bad release back" } });
    fireEvent.click(primary());
    const file = await screen.findByTestId<HTMLTextAreaElement>("wizard-file");
    fireEvent.change(file, {
      target: { value: file.value.replace(/version: .*\n/, "") },
    });
    expect(screen.getByText(t("skill.review.noVersion"))).toBeTruthy();
  });

  it("opens the pull request with the file the operator saw, and ends on its link", async () => {
    proposeSkill.mockResolvedValue(opened());
    await toPullRequest("Cut release notes group merged PRs");
    expect(screen.getByTestId("pr-branch").textContent).toBe(
      "skills/cut-release-notes-group",
    );
    expect(await screen.findByText("acme/platform:main")).toBeTruthy();

    fireEvent.click(primary());
    await screen.findByTestId("pr-opened");
    expect(proposeSkill).toHaveBeenCalledTimes(1);
    const call: unknown[] = proposeSkill.mock.calls[0] ?? [];
    expect(call.slice(0, 2)).toEqual(["acme", "core-platform"]);
    expect(call[2]).toMatchObject({
      origin: "describe",
      name: "cut-release-notes-group",
      rationale: "Cut release notes group merged PRs",
    });
    expect(call[2]).toHaveProperty(
      "body",
      expect.stringContaining("name: cut-release-notes-group"),
    );

    const link = screen.getByRole("link", { name: "acme/platform#525" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/platform/pull/525",
    );
    // Once the pull request is open the only way on is Close.
    expect(screen.queryByTestId("wizard-primary")).toBeNull();
    expect(screen.getByRole("button", { name: t("close") })).toBeTruthy();
  });

  it("names a failed check where the person acted, and stays on the step (negative)", async () => {
    proposeSkill.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "skill_check_version",
    });
    await toPullRequest("Run a safe Postgres migration");
    fireEvent.click(primary());
    const failure = await screen.findByTestId("pr-failure");
    expect(failure.textContent).toBe(t("skill.failure.checkVersion"));
    expect(screen.queryByTestId("pr-opened")).toBeNull();
    expect(primary().disabled).toBe(false);
  });

  it("names a refusal it has no sentence for by its code (negative)", async () => {
    proposeSkill.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "some_new_code",
    });
    await toPullRequest("Triage a flaky test");
    fireEvent.click(primary());
    expect((await screen.findByTestId("pr-failure")).textContent).toBe(
      t("skill.failure.refused", { code: "some_new_code" }),
    );
  });

  it("treats an action that throws as unanswered, with nothing written (negative)", async () => {
    proposeSkill.mockRejectedValue(new Error("network"));
    await toPullRequest("Triage a flaky test");
    fireEvent.click(primary());
    expect((await screen.findByTestId("pr-failure")).textContent).toBe(
      t("skill.failure.unanswered"),
    );
  });

  it("will not open a pull request while the workspace binds no main repository (negative)", async () => {
    readMainRepository.mockResolvedValue({ ok: true, value: null });
    await toPullRequest("Cut release notes");
    expect((await screen.findByTestId("repo-state")).textContent).toBe(
      t("skill.pr.repo.unbound"),
    );
    expect(primary().disabled).toBe(true);
    fireEvent.click(primary());
    expect(proposeSkill).not.toHaveBeenCalled();
  });

  it("says the repository read was refused (denied)", async () => {
    readMainRepository.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    await toPullRequest("Cut release notes");
    expect((await screen.findByTestId("repo-state")).textContent).toBe(
      t("skill.pr.repo.denied"),
    );
    expect(primary().disabled).toBe(true);
  });
});

describe("the skill wizard: upload a bundle", () => {
  async function toUpload() {
    mount();
    await screen.findByTestId("create-skill");
    fireEvent.click(screen.getByText(t("skill.source.upload.title")));
    fireEvent.click(primary());
    return screen.findByTestId<HTMLInputElement>("wizard-bundle");
  }

  it("previews and submits YAML-quoted names and versions from a differently named upload", async () => {
    const body = BODY.replace(
      "name: release-notes",
      'name: "release-notes"',
    ).replace("version: 2.2.0", 'version: "2.2.0"');
    readBundle.mockResolvedValue({
      fileName: "unrelated.skill",
      size: body.length,
      body,
      files: [],
      digest: DIGEST,
    });
    proposeSkill.mockResolvedValue(
      opened({ name: "release-notes", version: "2.2.0" }),
    );
    const input = await toUpload();
    fireEvent.change(input, {
      target: { files: [new File([body], "unrelated.skill")] },
    });
    await screen.findByTestId("bundle-summary");
    fireEvent.click(primary());
    await screen.findByTestId("wizard-file");
    expect(screen.getByTestId("derived")).toHaveTextContent("release-notes");
    expect(screen.getByTestId("derived")).toHaveTextContent("2.2.0");
    expect(primary()).toBeEnabled();
    fireEvent.click(primary());
    await screen.findByTestId("pr-branch");
    await waitFor(() => expect(primary()).toBeEnabled());
    fireEvent.click(primary());
    await screen.findByTestId("pr-opened");
    expect(proposeSkill).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      expect.objectContaining({ name: "release-notes", body }),
    );
  });

  it.each([
    "name: duplicate",
    "other: &name value\nalias: *name",
    "<<: {tools: shell}",
    '"allowed-tools": [shell]',
    '"permi\\u0073sions": {all: true}',
  ])("blocks invalid YAML or grants at review: %s", async (extra) => {
    const body = BODY.replace(
      "scope: workspace:core-platform",
      `scope: workspace:core-platform\n${extra}`,
    );
    readBundle.mockResolvedValue({
      fileName: "release-notes.skill",
      size: body.length,
      body,
      files: [],
      digest: DIGEST,
    });
    const input = await toUpload();
    fireEvent.change(input, {
      target: { files: [new File([body], "release-notes.skill")] },
    });
    await screen.findByTestId("bundle-summary");
    fireEvent.click(primary());
    await screen.findByTestId("wizard-file");
    expect(primary()).toBeDisabled();
    expect(
      screen.getByText(t("skill.review.invalidFrontmatter")),
    ).toBeVisible();
    expect(proposeSkill).not.toHaveBeenCalled();
  });

  it("reads the bundle in the tab, shows its version and digest, and commits every file", async () => {
    readBundle.mockResolvedValue({
      fileName: "release-notes-2.2.0.skill",
      size: 18422,
      body: BODY,
      files: [{ path: "examples/before.md", content: "before" }],
      digest: DIGEST,
    });
    proposeSkill.mockResolvedValue(
      opened({
        name: "uploaded-notes",
        version: "2.2.0",
        replaces: "2.1.0",
      }),
    );
    const input = await toUpload();
    expect(primary().disabled).toBe(true);
    const file = new File([BODY], "release-notes-2.2.0.skill");
    fireEvent.change(input, { target: { files: [file] } });

    const summary = await screen.findByTestId("bundle-summary");
    expect(readBundle).toHaveBeenCalledWith(file);
    expect(summary.textContent).toContain("2.2.0");
    expect(summary.textContent).toContain(DIGEST);
    expect(summary.textContent).toContain("examples/before.md");
    expect(primary().disabled).toBe(false);

    fireEvent.click(primary());
    const source =
      await screen.findByTestId<HTMLTextAreaElement>("wizard-file");
    fireEvent.click(screen.getByText(".oxagen/skills/release-notes/SKILL.md"));
    const filename = screen.getByRole("textbox", {
      name: translator("ui.sourceFilename")("name"),
    });
    fireEvent.change(filename, { target: { value: "uploaded-notes" } });
    fireEvent.keyDown(filename, { key: "Enter" });
    expect(source).toHaveValue(
      BODY.replace("name: release-notes", "name: uploaded-notes"),
    );
    // An uploaded file was not drafted, so it carries no drafting note.
    expect(screen.queryByTestId("draft-note")).toBeNull();
    fireEvent.click(primary());
    await screen.findByTestId("pr-branch");
    expect(
      screen.getByText(".oxagen/skills/uploaded-notes/examples/before.md"),
    ).toBeTruthy();

    fireEvent.click(primary());
    await screen.findByTestId("pr-opened");
    expect(proposeSkill).toHaveBeenCalledWith("acme", "core-platform", {
      origin: "upload",
      name: "uploaded-notes",
      body: BODY.replace("name: release-notes", "name: uploaded-notes"),
      files: [{ path: "examples/before.md", content: "before" }],
      rationale: "",
    });
  });

  it("names a bundle it cannot read and keeps Read the file closed (negative)", async () => {
    readBundle.mockRejectedValue(new BundleReadError("no_skill_md"));
    const input = await toUpload();
    fireEvent.change(input, {
      target: { files: [new File(["x"], "empty.zip")] },
    });
    expect((await screen.findByTestId("bundle-error")).textContent).toBe(
      t("skill.upload.error.no_skill_md"),
    );
    await waitFor(() => {
      expect(primary().disabled).toBe(true);
    });
  });
});
