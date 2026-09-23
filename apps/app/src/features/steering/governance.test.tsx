// @vitest-environment jsdom
// The governance chip and its dialog (roadmap pages/steering.md, `govChip`
// and `govmode`): the chip prints the mode read off governance.toml and never
// a mode nobody read; the dialog shows the three modes with the one in force
// marked, the TOML the pick would write, and the note; confirming calls
// set_governance_mode with the pick and reports what happened; picking the
// mode in force calls nothing; a refusal is named in the dialog. Each state
// gets an axe check.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SteeringHub } from "@/data/contracts/steering";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const { router, setGovernanceMode } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  setGovernanceMode: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("./actions", () => ({ setGovernanceMode }));

const { GovernanceChip, governanceToml } = await import("./governance");

const TEAM: SteeringHub["governance"] = {
  state: "read",
  repository: "acme/platform",
  mode: "team",
};

function renderChip(governance: SteeringHub["governance"] | null = TEAM) {
  render(
    <IntlProvider>
      <GovernanceChip
        org="acme"
        ws="core-platform"
        workspace="Core platform"
        governance={governance}
      />
    </IntlProvider>,
  );
}

function openDialog() {
  fireEvent.click(screen.getByTestId("governance-chip"));
  return screen.getByTestId("governance-dialog");
}

beforeEach(() => {
  setGovernanceMode.mockReset();
  router.refresh.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the governance chip", () => {
  it("reads Governance and the mode in mono, and is never the gold button", () => {
    renderChip();
    const chip = screen.getByTestId("governance-chip");
    expect(chip).toHaveTextContent("Governance: team");
    expect(chip.querySelector(".font-mono")).toHaveTextContent("team");
    expect(chip.className).not.toContain("bg-button-primary-bg");
  });

  it("reads a missing file as team and says the file is missing", () => {
    renderChip({ state: "read", repository: "acme/platform", mode: "absent" });
    const chip = screen.getByTestId("governance-chip");
    expect(chip).toHaveTextContent("Governance: team");
    expect(chip).toHaveAttribute(
      "title",
      "acme/platform has no .oxagen/rules/governance.toml. A missing file means team.",
    );
  });

  it("prints not read when the hub read failed, and marks no mode as now (negative)", () => {
    renderChip(null);
    expect(screen.getByTestId("governance-chip")).toHaveTextContent(
      "Governance: not read",
    );
    const dialog = openDialog();
    expect(dialog).not.toHaveTextContent("· now");
    expect(dialog).toHaveTextContent(
      ".oxagen/rules/governance.toml on the main repository",
    );
  });
});

describe("the governance dialog", () => {
  it("shows the three modes with the one in force marked now, the TOML, and the note", () => {
    renderChip();
    const dialog = openDialog();
    expect(dialog).toHaveTextContent("Governance mode · Core platform");
    expect(dialog).toHaveTextContent(
      ".oxagen/rules/governance.toml on acme/platform",
    );
    const radios = within(dialog).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("data-mode"))).toEqual([
      "solo",
      "team",
      "regulated",
    ]);
    expect(radios[0]).toHaveTextContent(
      "soloThe author may merge their own. One person, or a repository nobody else reviews.",
    );
    expect(radios[1]).toHaveTextContent("team · now");
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
    expect(radios[2]).toHaveTextContent(
      "A named approver from a role must approve, and the promotion ledger is hash-chained.",
    );
    expect(within(dialog).getByTestId("governance-toml")).toHaveTextContent(
      'mode = "team" separation_of_duties = false',
    );
    expect(dialog).toHaveTextContent(
      "The mode is read off the file when a pull request is opened and again when it is merged, so raising it takes effect on everything already in flight. Lowering it is an org-owner action with approval, recorded as a security event.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Open the Context PR" }),
    ).toBeVisible();
  });

  it("follows the pick in the TOML, with separation of duties only under regulated", () => {
    renderChip();
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole("radio", { name: /^regulated/ }));
    expect(
      within(dialog).getByRole("radio", { name: /^regulated/ }),
    ).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByTestId("governance-toml")).toHaveTextContent(
      'mode = "regulated" separation_of_duties = true',
    );
  });

  it("opens the Context PR for the pick and reports it", async () => {
    setGovernanceMode.mockResolvedValue({
      ok: true,
      value: {
        outcome: "proposed",
        mode: "regulated",
        repository: "acme/platform",
        branch: "main",
        pullRequest: {
          number: 42,
          htmlUrl: "https://github.com/acme/platform/pull/42",
        },
      },
    });
    renderChip();
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole("radio", { name: /^regulated/ }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open the Context PR" }),
    );
    await waitFor(() => {
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "Context PR opened on acme/platform: .oxagen/rules/governance.toml sets mode = regulated. It takes effect on merge for everything already in flight; nothing else in Oxagen writes that file.",
      );
    });
    expect(setGovernanceMode).toHaveBeenCalledExactlyOnceWith(
      "acme",
      "core-platform",
      "regulated",
    );
    expect(
      within(dialog).getByRole("link", { name: "Open pull request #42" }),
    ).toHaveAttribute("href", "https://github.com/acme/platform/pull/42");
    expect(router.refresh).not.toHaveBeenCalled();
    expect(
      within(dialog).queryByRole("button", { name: "Open the Context PR" }),
    ).toBeNull();
  });

  it("reports a solo commit as in force now and re-reads the page", async () => {
    setGovernanceMode.mockResolvedValue({
      ok: true,
      value: {
        outcome: "applied",
        mode: "team",
        repository: "acme/platform",
        branch: "main",
        pullRequest: null,
      },
    });
    renderChip({ state: "read", repository: "acme/platform", mode: "solo" });
    const dialog = openDialog();
    fireEvent.click(within(dialog).getByRole("radio", { name: /^team/ }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open the Context PR" }),
    );
    await waitFor(() => {
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        "Committed to main on acme/platform: .oxagen/rules/governance.toml sets mode = team. It is in force now.",
      );
    });
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("says nothing changed when the pick is the mode in force, and calls nothing", () => {
    renderChip();
    const dialog = openDialog();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Open the Context PR" }),
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Governance mode is already team; nothing to change.",
    );
    expect(setGovernanceMode).not.toHaveBeenCalled();
  });

  it.each([
    [
      { ok: false, reason: "denied", code: "org_role_required" },
      "Your roles here do not include set_governance_mode.",
    ],
    [
      { ok: false, reason: "not_found", code: "repository_not_installed" },
      "This workspace has no main repository with the GitHub App installed",
    ],
    [
      { ok: false, reason: "conflict", code: "github_refused" },
      "The change was refused: github_refused. Nothing was changed.",
    ],
    [
      { ok: false, reason: "pending_approval", accessRequestId: "apr_7" },
      "The change is waiting for approval: apr_7.",
    ],
    [
      { ok: false, reason: "unavailable", code: "action_failed" },
      "The change could not be made: action_failed. Nothing was changed.",
    ],
  ])(
    "names a refusal %o in the dialog and keeps the pick (negative)",
    async (failure, text) => {
      setGovernanceMode.mockResolvedValue(failure);
      renderChip();
      const dialog = openDialog();
      fireEvent.click(within(dialog).getByRole("radio", { name: /^solo/ }));
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Open the Context PR" }),
      );
      await waitFor(() => {
        expect(within(dialog).getByRole("alert")).toHaveTextContent(text);
      });
      expect(
        within(dialog).getByRole("radio", { name: /^solo/ }),
      ).toHaveAttribute("aria-checked", "true");
    },
  );
});

describe("governanceToml", () => {
  it("writes the mode and separation of duties under the header", () => {
    expect(governanceToml("# h", "solo")).toBe(
      '# h\nmode = "solo"\nseparation_of_duties = false\n',
    );
  });
});
