// @vitest-environment jsdom
// The Agents header's actions (mockups/pages/agents.md, Header): New agent
// opens the agent wizard over the page; Register an agent opens its dialog,
// which opens a Context PR through `registerAgent` and writes no row; Wrap
// Claude Code leaves for the Register Agent gate and is the one gold action.
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
import { CREATE_EVENT, createRequestOf } from "@/shared/create";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";

const { registerAgent } = vi.hoisted(() => ({ registerAgent: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("./actions", () => ({ registerAgent }));
vi.mock("@/features/create", () => ({
  AGENT_HARNESSES: ["claude-code", "codex", "cursor", "stella"],
  MODEL_TIERS: ["complex", "light"],
}));

const { AgentsCreate } = await import("./create-actions");
const { AgentKeyPrefix, keyPrefixOf } = await import("./key-prefix");
const t = translator("agents.list.register");

beforeEach(() => {
  registerAgent.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function mount() {
  render(
    <IntlProvider>
      <AgentsCreate org="acme" ws="core-platform" />
    </IntlProvider>,
  );
}

function openRegister() {
  fireEvent.click(screen.getByRole("button", { name: "Register an agent" }));
  return screen.getByTestId("register-agent");
}

describe("AgentsCreate", () => {
  it("opens the agent wizard from New agent, a plain button", () => {
    const seen = vi.fn((event: Event) => createRequestOf(event));
    window.addEventListener(CREATE_EVENT, seen);
    mount();
    const button = screen.getByRole("button", { name: "New agent" });
    expect(button.className).toBe(buttonSecondary);
    fireEvent.click(button);
    expect(seen.mock.results[0]?.value).toEqual({ kind: "agent" });
    window.removeEventListener(CREATE_EVENT, seen);
  });

  it("sends Wrap Claude Code to the Register Agent gate, not to a dialog", () => {
    mount();
    const wrap = screen.getByTestId("agents-wrap");
    expect(wrap.textContent).toBe("Wrap Claude Code");
    expect(wrap.getAttribute("href")).toBe("/acme/core-platform/register/name");
    expect(wrap.className).toBe(buttonPrimary);
  });
});

describe("Register an agent", () => {
  it("asks for a slug, shows the avatar, a harness and a model tier, over the note that it opens a Context PR", () => {
    mount();
    const dialog = openRegister();
    expect(within(dialog).getByText("Register an agent")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Slug")).toBeInTheDocument();
    expect(within(dialog).getByText("Avatar")).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Harness",
      "Claude Code",
      "Codex",
      "Cursor",
      "Stella",
      "complex",
      "light",
    ]);
    fireEvent.change(within(dialog).getByLabelText("Slug"), {
      target: { value: "perf-watch" },
    });
    expect(dialog).toHaveTextContent(
      "This does not write Postgres. It opens a Context PR that adds .oxagen/agents/perf-watch.toml and the generated harness file beside it.",
    );
    // With no key on the page to take the namespaces from, the hint names
    // the ending alone.
    expect(dialog).toHaveTextContent(
      "The agent key ends in .perf-watch and is immutable.",
    );
    // Open the Context PR sits in the footer beside Cancel, as the design
    // draws it, and submits the form from there.
    const footer = dialog.querySelector("[data-sheet-footer]");
    if (!(footer instanceof HTMLElement)) throw new Error("no footer");
    expect(
      within(footer)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Open the Context PR"]);
    expect(
      within(footer).getByRole("button", { name: "Open the Context PR" }),
    ).toHaveAttribute("form", "register-agent-form");
  });

  it("names the whole key the slug becomes when the page holds a key", () => {
    render(
      <IntlProvider>
        <AgentKeyPrefix value="a-intel.core">
          <AgentsCreate org="acme" ws="core-platform" />
        </AgentKeyPrefix>
      </IntlProvider>,
    );
    const dialog = openRegister();
    expect(dialog).toHaveTextContent(
      "The agent key becomes a-intel.core.<slug> and is immutable.",
    );
    fireEvent.change(within(dialog).getByLabelText("Slug"), {
      target: { value: "perf-watch" },
    });
    expect(dialog).toHaveTextContent(
      "The agent key becomes a-intel.core.perf-watch and is immutable.",
    );
  });

  it("takes the prefix from the first recorded key and none when no key is recorded", () => {
    expect(keyPrefixOf([null, "acme.core.release-bot"])).toBe("acme.core");
    expect(keyPrefixOf([null])).toBeNull();
    expect(keyPrefixOf([])).toBeNull();
  });

  it("offers Design on the avatar and says what designing needs, since the definition stores no avatar", () => {
    mount();
    const dialog = openRegister();
    const design = within(dialog).getByRole("button", { name: "Design" });
    expect(design).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(design);
    expect(design).toHaveAttribute("aria-expanded", "true");
    const note = dialog.querySelector("[data-not-backed]");
    expect(note).toHaveAttribute("data-gap", "#3855");
    expect(note).toHaveTextContent(
      "Designing an avatar needs an avatar field on the definition",
    );
  });

  it("opens the Context PR with the slug, harness and tier chosen, and links the pull request", async () => {
    registerAgent.mockResolvedValue({
      ok: true,
      value: {
        path: ".oxagen/agents/perf-watch.toml",
        pullRequest: {
          number: 526,
          url: "https://github.com/acme/platform/pull/526",
        },
      },
    });
    mount();
    const dialog = openRegister();
    fireEvent.change(within(dialog).getByLabelText("Slug"), {
      target: { value: "perf-watch" },
    });
    fireEvent.change(within(dialog).getByLabelText("Harness"), {
      target: { value: "cursor" },
    });
    fireEvent.change(within(dialog).getByLabelText("Model tier"), {
      target: { value: "light" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: t("confirm") }));
    await waitFor(() => {
      expect(registerAgent).toHaveBeenCalledWith("acme", "core-platform", {
        slug: "perf-watch",
        harness: "cursor",
        tier: "light",
      });
    });
    expect(
      await within(dialog).findByText(
        "Pull request #526 opened. The agent exists when it merges.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: "Open the pull request" }),
    ).toHaveAttribute("href", "https://github.com/acme/platform/pull/526");
  });

  it("refuses a slug the contract would refuse, before anything is sent (negative)", async () => {
    mount();
    const dialog = openRegister();
    const slug = within(dialog).getByLabelText("Slug");
    fireEvent.change(slug, { target: { value: "perf--watch" } });
    fireEvent.change(within(dialog).getByLabelText("Harness"), {
      target: { value: "codex" },
    });
    expect(slug).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: t("confirm") }));
    expect(
      await within(dialog).findByTestId("register-agent-failure"),
    ).toHaveTextContent(t("invalidSlug"));
    expect(registerAgent).not.toHaveBeenCalled();
  });

  it("names a refusal and opens nothing (negative)", async () => {
    registerAgent.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "propose_agent",
    });
    mount();
    const dialog = openRegister();
    fireEvent.change(within(dialog).getByLabelText("Slug"), {
      target: { value: "perf-watch" },
    });
    fireEvent.change(within(dialog).getByLabelText("Harness"), {
      target: { value: "codex" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: t("confirm") }));
    expect(
      await within(dialog).findByTestId("register-agent-failure"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("link")).toBeNull();
  });
});

describe("Register an agent while the dialog is open", () => {
  const fill = (dialog: HTMLElement) => {
    fireEvent.change(within(dialog).getByLabelText("Slug"), {
      target: { value: "perf-watch" },
    });
    fireEvent.change(within(dialog).getByLabelText("Harness"), {
      target: { value: "codex" },
    });
  };

  it("sends one proposal however often the form is submitted while it is pending (negative)", () => {
    registerAgent.mockReturnValue(new Promise(() => undefined));
    mount();
    const dialog = openRegister();
    fill(dialog);
    const form = dialog.querySelector("form");
    if (form === null) throw new Error("register form not drawn");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(registerAgent).toHaveBeenCalledTimes(1);
  });

  it("links no pull request whose URL is not GitHub's, and starts over once closed", async () => {
    registerAgent.mockResolvedValue({
      ok: true,
      value: {
        path: ".oxagen/agents/perf-watch.toml",
        pullRequest: {
          number: 7,
          url: "https://git.example.com/acme/platform/merge_requests/7",
        },
      },
    });
    mount();
    const dialog = openRegister();
    fill(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: t("confirm") }));
    expect(
      await within(dialog).findByText(
        "Pull request #7 opened. The agent exists when it merges.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("link")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: t("close") }));
    const again = openRegister();
    expect(within(again).getByLabelText("Slug")).toHaveValue("");
    expect(
      within(again).queryByText(
        "Pull request #7 opened. The agent exists when it merges.",
      ),
    ).toBeNull();
  });
});
