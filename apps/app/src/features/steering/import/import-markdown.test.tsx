// @vitest-environment jsdom
// The Import Markdown dialog (memory-collection spec, Bulk import; the
// mockup's md-import.js): Import Markdown opens it, chosen files get their
// default targets with Memories drawn closed, Review statements sends each
// file with its target and draws one row per statement with its kind, force,
// words, and source, a new kind narrows the force to the forces it allows, a
// conflict blocks the steering PR until a person chooses, and the commit
// sends the rows and links to the PR it opened. A refusal is named in the
// dialog, which keeps its rows. An axe check runs in every state.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  importFileResult,
  importPolicy,
  importRecord,
  parseOutput,
} from "./import.builders";

/** The rows a commit sent, as far as these tests read them. */
type SentRows = { records: { lineage: string; action: string | null }[] };

const { parseMarkdownImport, commitMarkdownImport } = vi.hoisted(() => ({
  parseMarkdownImport: vi.fn(),
  commitMarkdownImport:
    vi.fn<(org: string, ws: string, rows: SentRows) => Promise<unknown>>(),
}));
vi.mock("./actions", () => ({ parseMarkdownImport, commitMarkdownImport }));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { ImportMarkdown } = await import("./import-markdown");

const CLAUDE =
  "# Rules\n\nAlways tag a release from main after CI passes.\n\nThe API retries a failed call twice.\n";
const CEDAR =
  '# No force push\n\n```cedar\n@id("git.no-force-push")\nforbid (principal, action == Action::"github__push", resource);\n```\n';
const MEMORY =
  "---\nname: Release train\ndescription: Platform releases ship every other Tuesday.\nmetadata:\n  type: project\n---\n\nPlatform releases ship every other Tuesday.\n";

const tagFromMain = importRecord({
  file: "CLAUDE.md",
  line: 3,
  lineage: "acme.claude.tag-from-main",
  label: "Tag from main",
  statement: "Always tag a release from main after CI passes.",
  kind: "code-rule",
  kindReason: "It tells an agent how to work with code.",
  force: "must",
  forceWords: "Always",
  effect: null,
  tokens: 12,
});
const apiRetries = importRecord({
  file: "CLAUDE.md",
  line: 5,
  lineage: "acme.claude.api-retries",
  label: "API retries",
  statement: "The API retries a failed call twice.",
  kind: "fact",
  kindReason: "It states how something is.",
  force: "info",
  forceWords: "",
  effect: null,
  tokens: 9,
});
const mergeRelease = importRecord({
  file: "CLAUDE.md",
  line: 7,
  lineage: "acme.claude.merge-release",
  label: "Merge the release",
  statement: "Merge the release pull request once CI passes.",
  kind: "constraint",
  kindReason: "It requires an action.",
  force: "must",
  forceWords: "",
  effect: "require",
  tokens: 11,
  action: null,
  conflict: {
    lineage: "acme.core.person-merges-releases",
    path: "steering/constraints/acme.core.person-merges-releases.md",
    published: true,
  },
});

function parsed(records = [tagFromMain, apiRetries]) {
  return parseOutput({
    files: [
      importFileResult({ filename: "CLAUDE.md", records: records.length }),
      importFileResult({
        filename: "no-force-push.md",
        target: "policies",
        detected: "policies",
        reason: "The file holds a cedar block.",
        records: 0,
        policies: 1,
      }),
    ],
    records,
    policies: [importPolicy()],
  });
}

const OPENED = {
  number: 41,
  url: "https://github.com/acme/oxagen-core-platform/pull/41",
  branch: "steering/import-2026-10-01",
  records: 2,
  policies: 1,
  skipped: 0,
};

function renderImport() {
  render(
    <IntlProvider>
      <ImportMarkdown org="acme" ws="core-platform" />
    </IntlProvider>,
  );
}

function openDialog(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "Import Markdown" }));
  return screen.getByTestId("import-dialog");
}

function choose(dialog: HTMLElement, files: File[]) {
  fireEvent.change(within(dialog).getByTestId("import-files-input"), {
    target: { files },
  });
}

function memoryFile(): File {
  const file = new File([MEMORY], "project_release_train.md");
  Object.defineProperty(file, "webkitRelativePath", {
    value: "memory/project_release_train.md",
  });
  return file;
}

const FILES = () => [
  new File([CLAUDE], "CLAUDE.md"),
  new File([CEDAR], "no-force-push.md"),
  new File(["# Agent docs\n\nThese files tell agents how we release."], "README.md"),
];

async function pickFiles(files = FILES()): Promise<HTMLElement> {
  renderImport();
  const dialog = openDialog();
  choose(dialog, files);
  await within(dialog).findByTestId("import-file-count");
  return dialog;
}

async function reviewStatements(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByTestId("import-review"));
  await within(dialog).findAllByTestId("import-row");
}

const row = (dialog: HTMLElement, lineage: string): HTMLElement => {
  const found = within(dialog)
    .getAllByTestId("import-row")
    .find((r) => r.getAttribute("data-lineage") === lineage);
  if (found === undefined) throw new Error(`no row ${lineage}`);
  return found;
};

const optionsOf = (select: HTMLElement): string[] =>
  Array.from(select.querySelectorAll("option"))
    .filter((o) => !o.disabled)
    .map((o) => o.value);

/** Each row the last commit sent, as its lineage and its action. */
const sent = (): [string, string | null][] =>
  (commitMarkdownImport.mock.lastCall?.[2].records ?? []).map(
    (r): [string, string | null] => [r.lineage, r.action],
  );

beforeEach(() => {
  parseMarkdownImport.mockReset();
  commitMarkdownImport.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the Files step", () => {
  it("opens with the drop zone and its two buttons", () => {
    renderImport();
    const dialog = openDialog();
    expect(within(dialog).getByText("Import Markdown")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Drop Markdown files or a folder"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Choose files" }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole("button", { name: "Choose a folder" }),
    ).toBeEnabled();
    expect(within(dialog).getByTestId("import-review")).toBeDisabled();
  });

  it("gives each chosen file its default target, with Memories closed", async () => {
    const dialog = await pickFiles([...FILES(), memoryFile()]);
    const targets = Object.fromEntries(
      within(dialog)
        .getAllByTestId("import-target")
        .map((select): [string, string | null] => [
          select.closest("tr")?.getAttribute("data-file") ?? "",
          select instanceof HTMLSelectElement ? select.value : null,
        ]),
    );
    expect(targets).toEqual({
      "CLAUDE.md": "records",
      "README.md": "skip",
      "no-force-push.md": "policies",
      "memory/project_release_train.md": "skip",
    });
    const [memories] = within(dialog).getAllByRole("option", {
      name: "Memories",
      hidden: true,
    });
    expect(memories).toBeDisabled();
    expect(memories?.parentElement).toHaveAttribute(
      "label",
      "Arrives with memory collection",
    );
    const readme = within(dialog)
      .getAllByRole("row")
      .find((r) => r.getAttribute("data-file") === "README.md");
    expect(readme).toHaveTextContent("Skipped");
    expect(readme).toHaveTextContent("An index of the other files");
    expect(within(dialog).getByTestId("import-file-count")).toHaveTextContent(
      "4 files. 2 files stay out.",
    );
  });

  it("names the folder a folder pick came from", async () => {
    const file = new File([CLAUDE], "CLAUDE.md");
    Object.defineProperty(file, "webkitRelativePath", {
      value: "platform/CLAUDE.md",
    });
    const other = new File(["Use pnpm for every script."], "AGENTS.md");
    Object.defineProperty(other, "webkitRelativePath", {
      value: "platform/docs/AGENTS.md",
    });
    const dialog = await pickFiles([file, other]);
    expect(within(dialog).getByTestId("import-file-count")).toHaveTextContent(
      "2 files from platform.",
    );
  });

  it("says so when what was chosen holds no Markdown file (negative)", async () => {
    renderImport();
    const dialog = openDialog();
    choose(dialog, [new File(["binary"], "logo.png")]);
    expect(
      await within(dialog).findByTestId("import-pick-problem"),
    ).toHaveTextContent("What you chose holds no Markdown file.");
  });
});

describe("the statement grid", () => {
  it("sends each file with its target and draws one row per statement", async () => {
    parseMarkdownImport.mockResolvedValue({ ok: true, value: parsed() });
    const dialog = await pickFiles();
    await reviewStatements(dialog);
    expect(parseMarkdownImport).toHaveBeenCalledTimes(1);
    expect(parseMarkdownImport).toHaveBeenCalledWith("acme", "core-platform", [
      { filename: "CLAUDE.md", content: CLAUDE, target: "records" },
      { filename: "no-force-push.md", content: CEDAR, target: "policies" },
    ]);
    const tag = row(dialog, tagFromMain.lineage);
    expect(
      within(tag).getByRole("combobox", { name: "Kind of line 3 of CLAUDE.md" }),
    ).toHaveValue("code-rule");
    expect(
      within(tag).getByRole("combobox", { name: "Force of line 3 of CLAUDE.md" }),
    ).toHaveValue("must");
    expect(tag).toHaveTextContent("“Always”");
    expect(tag).toHaveTextContent("Points to must");
    expect(tag).toHaveTextContent("CLAUDE.md:3");
    expect(tag).toHaveTextContent("12 tokens per request");
    const retries = row(dialog, apiRetries.lineage);
    expect(within(retries).getByTestId("import-force")).toHaveTextContent(
      "info",
    );
    expect(retries).toHaveTextContent("Takes info only");
    const groups = within(dialog).getAllByTestId("import-group");
    expect(groups.map((g) => g.getAttribute("data-file"))).toEqual([
      "CLAUDE.md",
      "no-force-push.md",
    ]);
    expect(groups[1]).toHaveTextContent("policy/no-force-push.cedar");
    expect(groups[1]).toHaveTextContent("1 rule");
    expect(within(dialog).getByTestId("import-tokens")).toHaveTextContent(
      "The must and should rows add 12 tokens to every request.",
    );
    expect(within(dialog).getByTestId("import-summary")).toHaveTextContent(
      "2 records and 1 policy.",
    );
  });

  it("narrows the force to the forces a new kind allows", async () => {
    parseMarkdownImport.mockResolvedValue({ ok: true, value: parsed() });
    const dialog = await pickFiles();
    await reviewStatements(dialog);
    const kind = within(row(dialog, tagFromMain.lineage)).getByRole(
      "combobox",
      { name: "Kind of line 3 of CLAUDE.md" },
    );
    fireEvent.change(kind, { target: { value: "preference" } });
    const force = within(row(dialog, tagFromMain.lineage)).getByRole(
      "combobox",
      { name: "Force of line 3 of CLAUDE.md" },
    );
    expect(optionsOf(force)).toEqual(["may", "info"]);
    expect(force).toHaveValue("may");
    expect(row(dialog, tagFromMain.lineage)).toHaveTextContent(
      "Goes up to may",
    );
    fireEvent.change(kind, { target: { value: "fact" } });
    const tag = row(dialog, tagFromMain.lineage);
    expect(
      within(tag).queryByRole("combobox", {
        name: "Force of line 3 of CLAUDE.md",
      }),
    ).toBeNull();
    expect(within(tag).getByTestId("import-force")).toHaveTextContent("info");
    fireEvent.change(kind, { target: { value: "constraint" } });
    expect(
      within(row(dialog, tagFromMain.lineage)).getByRole("combobox", {
        name: "Effect of line 3 of CLAUDE.md",
      }),
    ).toHaveValue("require");
  });

  it("blocks the steering PR until a conflict has a choice, then sends Replace the record over the published record", async () => {
    parseMarkdownImport.mockResolvedValue({
      ok: true,
      value: parsed([tagFromMain, apiRetries, mergeRelease]),
    });
    commitMarkdownImport.mockResolvedValue({ ok: true, value: OPENED });
    const dialog = await pickFiles();
    await reviewStatements(dialog);
    const commit = within(dialog).getByTestId("import-commit");
    expect(commit).toBeDisabled();
    expect(within(dialog).getByTestId("import-summary")).toHaveTextContent(
      "Choose for 1 conflict before the PR opens.",
    );
    const merge = row(dialog, mergeRelease.lineage);
    expect(merge).toHaveTextContent("Conflict");
    expect(merge).toHaveTextContent("With acme.core.person-merges-releases");
    fireEvent.change(
      within(merge).getByRole("combobox", {
        name: "Settle the conflict on line 7 of CLAUDE.md",
      }),
      { target: { value: "replace" } },
    );
    expect(commit).toBeEnabled();
    fireEvent.click(commit);
    const done = await within(dialog).findByTestId("import-done");
    expect(sent()).toEqual([
      [tagFromMain.lineage, "add"],
      [apiRetries.lineage, "add"],
      ["acme.core.person-merges-releases", "add"],
    ]);
    expect(done).toHaveTextContent(
      "Opened steering PR #41 on steering/import-2026-10-01. Nothing steers until it merges.",
    );
    expect(
      within(done).getByRole("link", { name: "Open pull request #41" }),
    ).toHaveAttribute("href", OPENED.url);
  });

  it("leaves a statement out on Keep the record, and a row a person unticks", async () => {
    parseMarkdownImport.mockResolvedValue({
      ok: true,
      value: parsed([tagFromMain, apiRetries, mergeRelease]),
    });
    commitMarkdownImport.mockResolvedValue({ ok: true, value: OPENED });
    const dialog = await pickFiles();
    await reviewStatements(dialog);
    fireEvent.change(
      within(row(dialog, mergeRelease.lineage)).getByRole("combobox", {
        name: "Settle the conflict on line 7 of CLAUDE.md",
      }),
      { target: { value: "keep" } },
    );
    fireEvent.click(
      within(row(dialog, apiRetries.lineage)).getByRole("checkbox", {
        name: "Import line 5 of CLAUDE.md",
      }),
    );
    expect(within(dialog).getByTestId("import-summary")).toHaveTextContent(
      "1 record and 1 policy. 2 statements stay out.",
    );
    fireEvent.click(within(dialog).getByTestId("import-commit"));
    await within(dialog).findByTestId("import-done");
    expect(sent()).toEqual([
      [tagFromMain.lineage, "add"],
      [apiRetries.lineage, "skip"],
      [mergeRelease.lineage, "skip"],
    ]);
  });

  it("goes back to the files with every choice kept, and reads them again only when a target changes", async () => {
    parseMarkdownImport.mockResolvedValue({ ok: true, value: parsed() });
    const dialog = await pickFiles();
    await reviewStatements(dialog);
    fireEvent.change(
      within(row(dialog, tagFromMain.lineage)).getByRole("combobox", {
        name: "Kind of line 3 of CLAUDE.md",
      }),
      { target: { value: "procedure" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(
      within(dialog)
        .getAllByRole("row")
        .find((r) => r.getAttribute("data-file") === "CLAUDE.md"),
    ).toHaveTextContent("2 statements");
    fireEvent.click(within(dialog).getByTestId("import-review"));
    await within(dialog).findAllByTestId("import-row");
    expect(parseMarkdownImport).toHaveBeenCalledTimes(1);
    expect(
      within(row(dialog, tagFromMain.lineage)).getByRole("combobox", {
        name: "Kind of line 3 of CLAUDE.md",
      }),
    ).toHaveValue("procedure");
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    const policy = within(dialog)
      .getAllByTestId("import-target")
      .find((s) => s.closest("tr")?.getAttribute("data-file") === "no-force-push.md");
    if (policy === undefined) throw new Error("no policy row");
    fireEvent.change(policy, { target: { value: "skip" } });
    await reviewStatements(dialog);
    expect(parseMarkdownImport).toHaveBeenCalledTimes(2);
    expect(parseMarkdownImport).toHaveBeenLastCalledWith(
      "acme",
      "core-platform",
      [{ filename: "CLAUDE.md", content: CLAUDE, target: "records" }],
    );
  });
});

describe("refusals", () => {
  it("names a refused review in the dialog and stays on the files (negative)", async () => {
    parseMarkdownImport.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    const dialog = await pickFiles();
    fireEvent.click(within(dialog).getByTestId("import-review"));
    expect(await within(dialog).findByTestId("import-failure")).toHaveTextContent(
      "Your roles in this workspace do not allow an import.",
    );
    expect(within(dialog).getByTestId("import-review")).toBeEnabled();
    expect(within(dialog).queryByTestId("import-row")).toBeNull();
  });

  it("links to Billing when the organization has no credit for the review (negative)", async () => {
    parseMarkdownImport.mockResolvedValue({
      ok: false,
      reason: "exhausted",
      code: "insufficient_credits",
    });
    const dialog = await pickFiles();
    fireEvent.click(within(dialog).getByTestId("import-review"));
    const failure = await within(dialog).findByTestId("import-failure");
    expect(failure).toHaveTextContent("no credit left");
    expect(
      within(failure).getByRole("link", { name: "Open Billing" }),
    ).toHaveAttribute("href", "/acme/billing");
  });

  it("keeps the rows and names the reason when the steering PR does not open (negative)", async () => {
    parseMarkdownImport.mockResolvedValue({ ok: true, value: parsed() });
    commitMarkdownImport.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "duplicate_lineage",
    });
    const dialog = await pickFiles();
    await reviewStatements(dialog);
    fireEvent.click(within(dialog).getByTestId("import-commit"));
    expect(await within(dialog).findByTestId("import-failure")).toHaveTextContent(
      "Two statements would write the same record.",
    );
    await waitFor(() => {
      expect(within(dialog).getByTestId("import-commit")).toBeEnabled();
    });
    expect(within(dialog).getAllByTestId("import-row")).toHaveLength(2);
    expect(commitMarkdownImport).toHaveBeenCalledTimes(1);
  });
});
