// @vitest-environment jsdom
// The wizard host as a person meets it: nothing on the page until an entry
// point asks, the chooser offering only the kinds the host carries, a wizard
// opened by kind with its step rail, and a fresh draft each time it opens.
// The host reads the main repository on every opening and says which one the
// pull request will target, or that it could not tell. Each state gets an
// axe check.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREATE_EVENT, openCreate } from "@/shared/create";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";

const { readMainRepository, proposeSkill } = vi.hoisted(() => ({
  readMainRepository: vi.fn(),
  proposeSkill: vi.fn(),
}));
vi.mock("./actions", () => ({ readMainRepository, proposeSkill }));

const { CreateHost } = await import("./create-host");

const t = translator("create");

function mount() {
  return render(
    <IntlProvider>
      <CreateHost org="acme" ws="core-platform" wsName="Core platform" />
    </IntlProvider>,
  );
}

function open(kind: Parameters<typeof openCreate>[0] = null) {
  act(() => {
    openCreate(kind);
  });
}

beforeEach(() => {
  readMainRepository.mockReset();
  proposeSkill.mockReset();
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

describe("CreateHost", () => {
  it("renders nothing until an entry point opens it", () => {
    mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(readMainRepository).not.toHaveBeenCalled();
  });

  it("opens the chooser with the kinds it carries, and names the repository the pull request targets", async () => {
    mount();
    open();
    const dialog = await screen.findByTestId("create-chooser");
    expect(dialog.querySelector('[data-kind="skill"]')).not.toBeNull();
    // The agent, skill and record wizards are offered. The tool wizard is
    // not yet, and neither is a kind with no module.
    expect(dialog.querySelector('[data-kind="agent"]')).not.toBeNull();
    expect(dialog.querySelector('[data-kind="record"]')).not.toBeNull();
    expect(dialog.querySelector('[data-kind="tool"]')).toBeNull();
    expect(
      await screen.findByText(
        t("chooser.note", { repository: "acme/platform" }),
      ),
    ).toBeTruthy();
    expect(readMainRepository).toHaveBeenCalledWith("acme", "core-platform");
  });

  it("says it cannot name the repository while the read is refused (negative)", async () => {
    readMainRepository.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    mount();
    open();
    expect(await screen.findByText(t("chooser.noteUnknown"))).toBeTruthy();
  });

  it("treats a read that throws as unavailable rather than hanging (negative)", async () => {
    readMainRepository.mockRejectedValue(new Error("network"));
    mount();
    open();
    expect(await screen.findByText(t("chooser.noteUnknown"))).toBeTruthy();
  });

  it("opens the skill wizard from the chooser, on its first step", async () => {
    mount();
    open();
    const dialog = await screen.findByTestId("create-chooser");
    const card = dialog.querySelector<HTMLButtonElement>('[data-kind="skill"]');
    if (card === null) throw new Error("no skill card");
    fireEvent.click(card);
    await screen.findByTestId("create-skill");
    const rail = screen.getByTestId("wizard-rail");
    const current = rail.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain(t("steps.source"));
    expect(rail.querySelectorAll('[data-state="done"]')).toHaveLength(0);
    expect(screen.getByTestId("wizard-primary")).toHaveProperty(
      "disabled",
      true,
    );
    // The footer names the grant the pull request needs.
    expect(screen.getByText("skills.admin")).toBeTruthy();
  });

  it("opens a kind directly, and a second opening starts from a fresh draft", async () => {
    mount();
    open("skill");
    await screen.findByTestId("create-skill");
    fireEvent.click(
      screen.getByRole("button", {
        name: (name) => name.startsWith(t("skill.source.describe.title")),
      }),
    );
    fireEvent.click(screen.getByTestId("wizard-primary"));
    await screen.findByTestId("wizard-desc");

    fireEvent.click(screen.getByRole("button", { name: t("cancel") }));
    await waitFor(() => {
      expect(screen.queryByTestId("create-skill")).toBeNull();
    });

    open("skill");
    await screen.findByTestId("create-skill");
    expect(screen.queryByTestId("wizard-desc")).toBeNull();
    const rail = screen.getByTestId("wizard-rail");
    expect(rail.querySelector('[aria-current="step"]')?.textContent).toContain(
      t("steps.source"),
    );
  });

  it("ignores an event that names no kind it offers (negative)", () => {
    mount();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(CREATE_EVENT, { detail: { kind: "tool" } }),
      );
      window.dispatchEvent(new CustomEvent(CREATE_EVENT, { detail: "skill" }));
      window.dispatchEvent(new Event(CREATE_EVENT));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(readMainRepository).not.toHaveBeenCalled();
  });
});

it("prefills a finding in the context wizard and leaves it editable", async () => {
  mount();
  const description =
    "Finding fnd_1. Use pagination to reduce repeated result tokens.";
  act(() => {
    openCreate("record", { description });
  });
  expect(await screen.findByTestId("wizard-desc")).toHaveValue(description);
  fireEvent.change(screen.getByTestId("wizard-desc"), {
    target: { value: "Review and narrow this instruction." },
  });
  expect(screen.getByTestId("wizard-desc")).toHaveValue(
    "Review and narrow this instruction.",
  );
  expect(proposeSkill).not.toHaveBeenCalled();
});
