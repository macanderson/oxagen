// @vitest-environment jsdom
// The Configuration form over the file: each control patches one key of the
// draft in place and the rest of the file is untouched, the bar reports the
// draft against the commit with Discard and Save, Save opens the commit
// sheet with the patched draft, and Discard returns to the base. The budget
// field keeps its sibling keys and every stored micro, and the irreversible
// side effect is locked unless a mandate is active at the ledger's instant.
// Axe runs on the clean and the dirty form.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MandateList, MandateRow } from "@/data/contracts/mandates";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mandateRow } from "@/test/mandate-views";
import {
  agentDetail,
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
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ commitAgentDefinition }));

const { DefinitionForm } = await import("./definition-form");
const { routes } = await import("@/shared/safe-path");

/** The ledger's answer at noon on 2026-09-16, which the default row's window contains. */
const AS_OF = "2026-09-16T12:00:00.000Z";
const ledger = (mandates: MandateRow[]): MandateList => ({
  mandates,
  truncatedAt: null,
  asOf: AS_OF,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // The draft is shared with the source editor through sessionStorage
  // (draft-store.ts), so one test's edit would otherwise open the next.
  window.sessionStorage.clear();
});

function renderForm(
  source = DEFINITION_SOURCE,
  mandates: MandateList | null = ledger([mandateRow()]),
) {
  const detail = agentDetail({ definition: committedDefinition(source) });
  const definition = detail.definition;
  if (definition === null) throw new Error("built with a definition");
  const view = render(
    <IntlProvider>
      <DefinitionForm
        org="acme"
        ws="core-platform"
        identity={detail.identity}
        definition={definition}
        path={definition.path}
        base={definition.source}
        branch={definition.branch}
        mandates={mandates}
        editor={routes.agentSource("acme", "core-platform", "release-bot")}
        after={routes.agent("acme", "core-platform", "release-bot", {
          tab: "definition",
        })}
      />
    </IntlProvider>,
  );
  return view.container;
}

const dirtyBar = () => screen.queryByTestId("definition-dirty");
const budgetField = () =>
  screen.getByRole("spinbutton", { name: "Per-run budget (USD)" });

/** Saves the draft through the commit sheet and returns the source it sent. */
async function committedSource(): Promise<string> {
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByTestId("commit-definition");
  let source = "";
  commitAgentDefinition.mockImplementation(
    (_org: string, _ws: string, input: { source: string }) => {
      source = input.source;
      return Promise.resolve({
        ok: false,
        reason: "not_found",
        code: "agent_not_found",
      });
    },
  );
  await userEvent.type(screen.getByLabelText(/Summary/), "Budget");
  await userEvent.click(
    screen.getByRole("button", { name: "Commit and open a pull request" }),
  );
  await screen.findByTestId("commit-failure");
  return source;
}

describe("DefinitionForm", () => {
  it("patches a text field on blur, keeps the rest of the file, and offers Discard and Save", async () => {
    const container = renderForm();
    expect(
      screen.getByText(/Stored as budget = \{ per_run_micros = 2500000 \}/),
    ).toBeInTheDocument();
    await expectNoAxe(container);
    expect(dirtyBar()).toBeNull();

    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Releases" } });
    fireEvent.blur(name);
    const bar = dirtyBar();
    expect(bar).not.toBeNull();
    expect(bar).toHaveTextContent("Unsaved changes");
    expect(bar).toHaveTextContent("+1 −1");
    expect(bar).toHaveTextContent("against agents/release-bot at 9c1e2f0");
    expect(screen.getByRole("region", { name: "Source" })).toHaveTextContent(
      "At commit9c1e2f0 · draft",
    );
    await expectNoAxe(container);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const sheet = await screen.findByTestId("commit-definition");
    // The sheet shows the draft against the file it started from, as a diff.
    expect(sheet).toHaveTextContent(
      "The draft against the file it started from: .oxagen/agents/release-bot.toml, +1 −1",
    );
    expect(sheet).toHaveTextContent('+name = "Releases"');
    commitAgentDefinition.mockResolvedValue({
      ok: true,
      value: {
        branch: "agents/release-bot",
        commitSha: "ab12cd3",
        pullRequest: {
          number: 12,
          url: "https://github.com/acme/core/pull/12",
        },
      },
    });
    await userEvent.type(screen.getByLabelText(/Summary/), "Rename");
    await userEvent.click(
      screen.getByRole("button", { name: "Commit and open a pull request" }),
    );
    await screen.findByTestId("commit-done");
    expect(commitAgentDefinition).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        agentId: "agt_releasebot",
        branch: "agents/release-bot",
        message: "Rename",
        source: DEFINITION_SOURCE.replace(
          'name = "Release bot"',
          'name = "Releases"',
        ),
      },
    );
  });

  it("adds and removes tool patterns, toggles a side effect, and writes the budget in micros", async () => {
    renderForm();
    const add = screen.getByRole("textbox", { name: "Add to deny_tools" });
    await userEvent.type(add, "github__merge_pull_request@*{Enter}");
    expect(add).toHaveValue("");
    expect(
      screen.getByRole("button", {
        name: "Remove github__merge_pull_request@*",
      }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove github__*" }));
    expect(
      screen.queryByRole("button", { name: "Remove github__*" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: /^irreversible/ }));
    const budget = screen.getByRole("spinbutton", {
      name: "Per-run budget (USD)",
    });
    fireEvent.change(budget, { target: { value: "5" } });
    fireEvent.blur(budget);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByTestId("commit-definition");
    let source = "";
    commitAgentDefinition.mockImplementation(
      (_org: string, _ws: string, input: { source: string }) => {
        source = input.source;
        return Promise.resolve({
          ok: false,
          reason: "not_found",
          code: "agent_not_found",
        });
      },
    );
    await userEvent.type(screen.getByLabelText(/Summary/), "Tools");
    await userEvent.click(
      screen.getByRole("button", { name: "Commit and open a pull request" }),
    );
    expect(await screen.findByTestId("commit-failure")).toHaveTextContent(
      "This agent no longer exists.",
    );
    expect(source).toContain('tools = ["linear__get_issue"]\n');
    expect(source).toContain('deny_tools = ["github__merge_pull_request@*"]\n');
    expect(source).toContain(
      'side_effects = ["read", "write", "irreversible"]\n',
    );
    expect(source).toContain("budget = { per_run_micros = 5000000 }\n");
    expect(source).toContain(
      '[instructions]\nbody = """\nYou prepare releases.\n"""',
    );
  });

  it("writes the instructions as a multi-line string and the colour into the harness table, and Discard restores the base", () => {
    renderForm();
    const body = screen.getByRole("textbox", { name: "Instructions" });
    fireEvent.change(body, {
      target: { value: "Cut the release.\nOpen a PR." },
    });
    fireEvent.blur(body);
    fireEvent.change(screen.getByRole("combobox", { name: "Color" }), {
      target: { value: "gold" },
    });
    // The textarea is remounted on the new value, so it is read again.
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
      "Cut the release.\nOpen a PR.",
    );
    // One body line became two (the second carries the fence's continuation) and the colour line changed.
    expect(dirtyBar()).toHaveTextContent("+3 −2");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(dirtyBar()).toBeNull();
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(
      "You prepare releases.\n",
    );
    expect(screen.getByRole("combobox", { name: "Color" })).toHaveValue("blue");
  });

  it("locks the irreversible side effect for an agent with no mandate and says so when the ledger did not answer (negative)", () => {
    renderForm(DEFINITION_SOURCE, ledger([]));
    const locked = screen.getByRole("checkbox", { name: /^irreversible/ });
    expect(locked).toBeDisabled();
    expect(locked.closest("label")).toHaveTextContent(
      "Needs an active mandate. This agent holds none.",
    );
    cleanup();
    // A ledger that did not answer proves nothing, so the control fails
    // closed rather than open: nothing here checks the effect at commit.
    renderForm(DEFINITION_SOURCE, null);
    const unknown = screen.getByRole("checkbox", { name: /^irreversible/ });
    expect(unknown).toBeDisabled();
    expect(unknown.closest("label")).toHaveTextContent(
      "Needs an active mandate. The mandate ledger did not answer",
    );
  });

  it("lets an operator remove an irreversible effect the file already carries when no mandate is active", async () => {
    const carrying = DEFINITION_SOURCE.replace(
      'side_effects = ["read", "write"]',
      'side_effects = ["read", "write", "irreversible"]',
    );
    renderForm(carrying, ledger([]));
    const box = screen.getByRole("checkbox", { name: /^irreversible/ });
    expect(box).toBeChecked();
    expect(box).toBeEnabled();
    fireEvent.click(box);
    // Once removed, adding it back needs the mandate again.
    expect(box).not.toBeChecked();
    expect(box).toBeDisabled();
    expect(await committedSource()).toContain(
      'side_effects = ["read", "write"]\n',
    );
  });

  it("does not take a [budget] line inside the instructions for a budget table", async () => {
    const decoy = DEFINITION_SOURCE.replace(
      'body = """\n',
      'body = """\n[budget]\nis a heading in the prose, not a table\n',
    );
    renderForm(decoy);
    fireEvent.change(budgetField(), { target: { value: "5" } });
    fireEvent.blur(budgetField());
    const out = await committedSource();
    expect(out).toContain("budget = { per_run_micros = 5000000 }\n");
    // The decoy stays where it was and no second table was appended after it.
    expect(out.match(/^\[budget\]/gm)).toHaveLength(1);
    expect(out).toContain("[budget]\nis a heading in the prose");
  });

  it("counts only mandates that are active inside their window at the ledger's instant, so a draft, a revoked, an expired and a scheduled row do not unlock irreversible (negative)", () => {
    renderForm(
      DEFINITION_SOURCE,
      ledger([
        mandateRow({ id: "mnd_draft", status: "draft" }),
        mandateRow({ id: "mnd_revoked", status: "revoked" }),
        mandateRow({
          id: "mnd_expired",
          status: "expired",
          validTo: "2026-09-01T00:00:00.000Z",
        }),
        // Granted, and its window closes at the ledger's own instant: the gate stops honouring it exactly then.
        mandateRow({ id: "mnd_closing", validTo: AS_OF }),
        mandateRow({ id: "mnd_later", validFrom: "2026-10-01T00:00:00.000Z" }),
      ]),
    );
    const locked = screen.getByRole("checkbox", { name: /^irreversible/ });
    expect(locked).toBeDisabled();
    expect(locked.closest("label")).toHaveTextContent("This agent holds none.");
    cleanup();

    renderForm(
      DEFINITION_SOURCE,
      ledger([
        mandateRow({ id: "mnd_draft", status: "draft" }),
        mandateRow({ id: "mnd_now", validFrom: AS_OF }),
        mandateRow({ id: "mnd_open" }),
      ]),
    );
    const open = screen.getByRole("checkbox", { name: /^irreversible/ });
    expect(open).toBeEnabled();
    expect(open.closest("label")).toHaveTextContent("This agent holds 2.");
  });

  it("keeps the other budget keys when the per-run amount changes, in each spelling of the table", async () => {
    const inline = DEFINITION_SOURCE.replace(
      "budget = { per_run_micros = 2500000 }",
      'budget = { mode = "hard", per_run_micros = 2500000, per_day_micros = 20000000 }',
    );
    renderForm(inline);
    fireEvent.change(budgetField(), { target: { value: "5" } });
    fireEvent.blur(budgetField());
    expect(await committedSource()).toContain(
      'budget = { mode = "hard", per_run_micros = 5000000, per_day_micros = 20000000 }\n',
    );
    cleanup();
    vi.clearAllMocks();

    const dotted = DEFINITION_SOURCE.replace(
      "budget = { per_run_micros = 2500000 }",
      "budget.per_day_micros = 20000000\nbudget.per_run_micros = 2500000 # a comment",
    );
    renderForm(dotted);
    fireEvent.change(budgetField(), { target: { value: "5" } });
    fireEvent.blur(budgetField());
    expect(await committedSource()).toContain(
      "budget.per_day_micros = 20000000\nbudget.per_run_micros = 5000000 # a comment\n",
    );
    cleanup();
    vi.clearAllMocks();

    const sectioned = `${DEFINITION_SOURCE.replace(
      "budget = { per_run_micros = 2500000 }\n",
      "",
    )}\n[budget]\nper_run_micros = 2500000\nper_day_micros = 20000000\n`;
    renderForm(sectioned);
    fireEvent.change(budgetField(), { target: { value: "5" } });
    fireEvent.blur(budgetField());
    const source = await committedSource();
    expect(source).toContain(
      "[budget]\nper_run_micros = 5000000\nper_day_micros = 20000000\n",
    );
    expect(source).not.toContain("budget = {");
  });

  it("shows every stored micro, leaves the file alone when the field is left as drawn, and keeps a sub-cent amount", async () => {
    renderForm(
      DEFINITION_SOURCE.replace(
        "per_run_micros = 2500000",
        "per_run_micros = 2500001",
      ),
    );
    expect(budgetField()).toHaveValue(2.500001);
    expect(budgetField()).toHaveAttribute("step", "any");
    // Focus and leave: the text is the one drawn, so nothing is written.
    fireEvent.focus(budgetField());
    fireEvent.blur(budgetField());
    expect(dirtyBar()).toBeNull();
    // A whole number of cents still reads as money, and a blank or negative entry is not written.
    cleanup();
    renderForm();
    expect(budgetField()).toHaveValue(2.5);
    expect(budgetField()).toHaveAttribute("value", "2.50");
    fireEvent.change(budgetField(), { target: { value: "" } });
    fireEvent.blur(budgetField());
    expect(dirtyBar()).toBeNull();
    fireEvent.change(budgetField(), { target: { value: "-1" } });
    fireEvent.blur(budgetField());
    expect(dirtyBar()).toBeNull();
    fireEvent.change(budgetField(), { target: { value: "0.004" } });
    fireEvent.blur(budgetField());
    expect(dirtyBar()).not.toBeNull();
    expect(await committedSource()).toContain(
      "budget = { per_run_micros = 4000 }\n",
    );
  });
});
