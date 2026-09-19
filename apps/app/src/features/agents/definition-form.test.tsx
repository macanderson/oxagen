// @vitest-environment jsdom
// The Configuration form over the file: each control patches one key of the
// draft in place and the rest of the file is untouched, the bar reports the
// draft against the commit with Discard and Save, Save opens the commit
// sheet with the patched draft, and Discard returns to the base. Axe runs on
// the clean and the dirty form.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderForm(source = DEFINITION_SOURCE, mandates: number | null = 1) {
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

describe("DefinitionForm", () => {
  it("patches a text field on blur, keeps the rest of the file, and offers Discard and Save", async () => {
    const container = renderForm();
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
    expect(sheet).toHaveTextContent(
      "1 lines added and 1 removed against the file you started from.",
    );
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
        message: "",
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
    renderForm(DEFINITION_SOURCE, 0);
    const locked = screen.getByRole("checkbox", { name: /^irreversible/ });
    expect(locked).toBeDisabled();
    expect(locked.closest("label")).toHaveTextContent("This agent holds none.");
    cleanup();
    renderForm(DEFINITION_SOURCE, null);
    const unknown = screen.getByRole("checkbox", { name: /^irreversible/ });
    expect(unknown).toBeEnabled();
    expect(unknown.closest("label")).toHaveTextContent(
      "The mandate ledger did not answer",
    );
  });
});
