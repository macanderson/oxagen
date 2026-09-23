// @vitest-environment jsdom
// The context-record wizard as a person drives it, through the host the
// workspace layout mounts: describe the concern, pick a kind, write the
// statement, read the six checks, and open the pull request. The cases pin
// what propose_record and open_context_pr are sent, that the kind gates the
// force and the constraint effect, that the one gold control waits on what
// its step needs, that a refusal is named where the person acted, that a
// retry reuses the proposal already made, and that the pull request step
// refuses to send while the workspace binds no main repository. Each state
// gets an axe check.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCreate } from "@/shared/create";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";

const { readMainRepository, proposeSkill, proposeRecord, openRecordPr, push } =
  vi.hoisted(() => ({
    readMainRepository: vi.fn(),
    proposeSkill: vi.fn(),
    proposeRecord: vi.fn(),
    openRecordPr: vi.fn(),
    push: vi.fn(),
  }));
vi.mock("./actions", () => ({
  readMainRepository,
  proposeSkill,
  proposeRecord,
  openRecordPr,
}));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("@/ui/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ui/navigation")>();
  const navigate = { push, replace: vi.fn(), refresh: vi.fn() };
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

// Await real module transformation before asserting UI behavior.
const { WIZARDS } = await import("./kinds");
await Promise.all([WIZARDS.record?.()]);

const { CreateHost } = await import("./create-host");

const t = translator("createRecord");
const tc = translator("create");

const DESC = "Do not re-read CHANGELOG.md more than once in a run";
const LINEAGE = "ctx.core.do-not-re-read";

function mount() {
  render(
    <IntlProvider>
      <CreateHost org="acme" ws="core-platform" wsName="Core platform" />
    </IntlProvider>,
  );
  act(() => {
    openCreate("record");
  });
}

const primary = () => screen.getByTestId<HTMLButtonElement>("wizard-primary");

function currentStep(): string {
  return (
    screen.getByTestId("wizard-rail").querySelector('[aria-current="step"]')
      ?.textContent ?? ""
  );
}

function kindCard(kind: string): HTMLButtonElement {
  const card = document.querySelector<HTMLButtonElement>(
    `[data-kind="${kind}"] button`,
  );
  if (card === null) throw new Error(`no ${kind} card`);
  return card;
}

async function toKind(desc = DESC) {
  mount();
  const field = await screen.findByTestId<HTMLTextAreaElement>("wizard-desc");
  fireEvent.input(field, { target: { value: desc } });
  fireEvent.click(primary());
  await waitFor(() => {
    expect(currentStep()).toContain(tc("steps.kind"));
  });
}

async function toStatement(kind = "rule", desc = DESC) {
  await toKind(desc);
  fireEvent.click(kindCard(kind));
  fireEvent.click(primary());
  return screen.findByTestId<HTMLTextAreaElement>("wizard-file");
}

async function toPullRequest(kind = "rule") {
  await toStatement(kind);
  fireEvent.click(primary());
  await screen.findByTestId("record-checks");
  fireEvent.click(primary());
  await screen.findByTestId("pr-branch");
  // The host reads the main repository as it opens; wait for the answer.
  await waitFor(() => {
    expect(screen.queryByText(t("pr.repo.loading"))).toBeNull();
  });
}

function opened(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    value: {
      proposalId: "prp_01K5ABC",
      lineageId: LINEAGE,
      status: "checks_passed",
      pr: {
        number: 527,
        url: "https://github.com/acme/platform/pull/527",
        repository: "acme/platform",
        branch: `context/${LINEAGE}`,
        path: `.oxagen/rules/${LINEAGE}.toml`,
      },
      checks: [
        { name: "schema", status: "passed", summary: "one record" },
        { name: "lineage_uniqueness", status: "passed", summary: "free" },
        { name: "record_hash", status: "passed", summary: "matches" },
        { name: "secret_pii_scan", status: "passed", summary: "clean" },
        { name: "conflict_against_active", status: "passed", summary: "none" },
        { name: "constraint_effect", status: "passed", summary: "absent" },
      ],
      ...overrides,
    },
  };
}

beforeEach(() => {
  readMainRepository.mockReset();
  proposeRecord.mockReset();
  openRecordPr.mockReset();
  push.mockReset();
  readMainRepository.mockResolvedValue({
    ok: true,
    value: { fullName: "acme/platform", defaultRef: "main" },
  });
  proposeRecord.mockResolvedValue({
    ok: true,
    value: { proposalId: "prp_01K5ABC", lineageId: LINEAGE },
  });
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the context-record wizard: describe", () => {
  it("opens on Describe with five steps, and names the grant it needs", async () => {
    mount();
    await screen.findByTestId("create-record");
    const rail = screen.getByTestId("wizard-rail");
    expect(rail.querySelectorAll("li")).toHaveLength(5);
    expect(currentStep()).toContain(tc("steps.describe"));
    expect(screen.getByText("steering.write")).toBeTruthy();
    expect(screen.getByText(t("describe.noGrant"))).toBeTruthy();
    expect(primary().textContent).toBe(t("describe.next"));
  });

  it("enables Pick a kind once there is a description, without rebuilding the field", async () => {
    mount();
    const field = await screen.findByTestId<HTMLTextAreaElement>("wizard-desc");
    expect(primary().disabled).toBe(true);
    fireEvent.input(field, { target: { value: "Cache" } });
    expect(primary().disabled).toBe(false);
    fireEvent.input(field, { target: { value: "Cache the first read" } });
    expect(screen.getByTestId("wizard-desc")).toBe(field);
    fireEvent.input(field, { target: { value: "  " } });
    expect(primary().disabled).toBe(true);
  });

  it("fills the description from a suggestion", async () => {
    mount();
    await screen.findByTestId("wizard-desc");
    fireEvent.click(
      screen.getByRole("button", { name: t("describe.suggestions.flake") }),
    );
    expect(screen.getByTestId<HTMLTextAreaElement>("wizard-desc").value).toBe(
      t("describe.suggestions.flake"),
    );
    expect(primary().disabled).toBe(false);
  });
});

describe("the context-record wizard: kind", () => {
  it("shows six kinds, each saying what it can never do, and waits for one", async () => {
    await toKind();
    for (const kind of [
      "rule",
      "constraint",
      "procedure",
      "fact",
      "memory",
      "preference",
    ]) {
      expect(kindCard(kind).textContent).toContain(t(`kind.kinds.${kind}.use`));
      expect(kindCard(kind).textContent).toContain(
        t(`kind.kinds.${kind}.never`),
      );
    }
    expect(primary().disabled).toBe(true);
    expect(screen.queryByTestId("kind-deliver")).toBeNull();

    fireEvent.click(kindCard("memory"));
    expect(kindCard("memory").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("kind-deliver").textContent).toContain(
      t("kind.reaches", { kind: "memory" }),
    );
    expect(primary().disabled).toBe(false);
  });
});

describe("the context-record wizard: statement", () => {
  it("drafts the statement, says who drafted it, and lets the operator edit and revert", async () => {
    const file = await toStatement();
    expect(screen.getByTestId("draft-note").textContent).toContain(
      t("statement.drafted.body"),
    );
    expect(file.value).toBe(`${DESC}.`);
    expect(
      screen.getByRole("region", {
        name: t("statement.path", { path: `.oxagen/rules/${LINEAGE}.toml` }),
      }),
    ).toBeTruthy();
    const preview = screen.getByTestId("record-preview");
    expect(preview.textContent).toContain(LINEAGE);
    expect(preview.textContent).toContain(t("statement.preview.badge"));

    const revert = screen.getByRole<HTMLButtonElement>("button", {
      name: t("statement.revert"),
    });
    expect(revert.disabled).toBe(true);
    fireEvent.change(file, { target: { value: "Read CHANGELOG.md once." } });
    expect(preview.textContent).toContain("Read CHANGELOG.md once.");
    expect(revert.disabled).toBe(false);
    fireEvent.click(revert);
    expect(screen.getByTestId<HTMLTextAreaElement>("wizard-file").value).toBe(
      `${DESC}.`,
    );
  });

  it("sends the statement on one line however the editor wraps it", async () => {
    openRecordPr.mockResolvedValue(opened());
    const file = await toStatement();
    fireEvent.change(file, {
      target: { value: "Read CHANGELOG.md once \nper run, then \n  stop. " },
    });
    expect(file.value).toBe(
      "Read CHANGELOG.md once \nper run, then \n  stop. ",
    );
    expect(screen.getByTestId("record-preview").textContent).toContain(
      "Read CHANGELOG.md once per run, then stop.",
    );

    fireEvent.click(primary());
    await screen.findByTestId("record-checks");
    fireEvent.click(primary());
    await screen.findByTestId("pr-branch");
    await waitFor(() => {
      expect(screen.queryByText(t("pr.repo.loading"))).toBeNull();
    });
    fireEvent.click(primary());
    await screen.findByTestId("pr-opened");
    expect(proposeRecord).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      expect.objectContaining({
        record: expect.objectContaining({
          statement: "Read CHANGELOG.md once per run, then stop.",
        }),
      }),
    );
  });

  it("filters force by kind: a preference is never must, a fact is info (negative)", async () => {
    await toStatement("preference");
    const force = screen.getByTestId<HTMLSelectElement>("record-force");
    expect([...force.options].map((o) => o.value)).toEqual(["may", "info"]);
    expect(force.value).toBe("may");
    cleanup();

    await toStatement("fact");
    const factForce = screen.getByTestId<HTMLSelectElement>("record-force");
    expect([...factForce.options].map((o) => o.value)).toEqual(["info"]);
  });

  it("offers a constraint effect on a constraint only, with no allow", async () => {
    await toStatement("rule");
    expect(screen.queryByTestId("record-effect")).toBeNull();
    cleanup();

    await toStatement("constraint");
    const effect = screen.getByTestId<HTMLSelectElement>("record-effect");
    expect([...effect.options].map((o) => o.value)).toEqual([
      "require",
      "forbid",
    ]);
  });

  it("keeps the repository scope closed and says why (negative)", async () => {
    await toStatement();
    const scope = screen.getByTestId<HTMLSelectElement>("record-scope");
    expect(scope.value).toBe("workspace");
    const repository = [...scope.options].find((o) => o.value === "repository");
    expect(repository?.disabled).toBe(true);
    expect(screen.getByText(/This wizard opens pull requests/)).toBeTruthy();
  });

  it("will not run the checks on an empty or oversized statement (negative)", async () => {
    const file = await toStatement();
    fireEvent.change(file, { target: { value: "   " } });
    expect(screen.getByTestId("statement-problem").textContent).toBe(
      t("statement.empty"),
    );
    expect(primary().disabled).toBe(true);

    fireEvent.change(file, { target: { value: "x".repeat(2001) } });
    expect(screen.getByTestId("statement-problem")).toBeTruthy();
    expect(primary().disabled).toBe(true);
  });
});

describe("the context-record wizard: checks", () => {
  it("spells the six checks out for this record", async () => {
    await toStatement("constraint");
    fireEvent.click(primary());
    const checks = await screen.findByTestId("record-checks");
    expect(checks.querySelectorAll("li")).toHaveLength(6);
    expect(checks.textContent).toContain(LINEAGE);
    expect(checks.textContent).toContain("forbid");
    expect(screen.getByText(t("checks.fifth"))).toBeTruthy();
    expect(currentStep()).toContain(tc("steps.checks"));
  });

  it("says a non-constraining kind carries no effect, which passes", async () => {
    await toStatement("fact");
    fireEvent.click(primary());
    const checks = await screen.findByTestId("record-checks");
    expect(checks.textContent).toContain(t("checks.items.effect.none"));
  });
});

describe("the context-record wizard: pull request", () => {
  it("proposes the record, opens its Context PR, and lands on Context PRs", async () => {
    openRecordPr.mockResolvedValue(opened());
    await toPullRequest();
    expect(screen.getByTestId("pr-branch").textContent).toBe(
      `context/${LINEAGE}`,
    );
    expect(await screen.findByText("acme/platform:main")).toBeTruthy();
    expect(screen.getByTestId("record-rationale").textContent).toBe(DESC);

    fireEvent.click(primary());
    await screen.findByTestId("pr-opened");
    expect(proposeRecord).toHaveBeenCalledWith("acme", "core-platform", {
      record: {
        lineageId: LINEAGE,
        kind: "rule",
        force: "must",
        sharingScope: "workspace",
        statement: `${DESC}.`,
      },
      rationale: DESC,
    });
    expect(openRecordPr).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "prp_01K5ABC",
    );

    const link = screen.getByRole("link", { name: "acme/platform#527" });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/platform/pull/527",
    );
    expect(
      screen.getByTestId("opened-checks").querySelectorAll("li"),
    ).toHaveLength(6);
    expect(screen.getByText(t("opened.passed"))).toBeTruthy();
    // The page behind moves to Context PRs with this pull request selected.
    const target = "/acme/core-platform/steering?tab=prs&proposal=prp_01K5ABC";
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(target);
    });
    expect(
      screen
        .getByRole("link", { name: t("opened.onContextPrs") })
        .getAttribute("href"),
    ).toBe(target);
    // Once the pull request is open the only way on is Close.
    expect(screen.queryByTestId("wizard-primary")).toBeNull();
    expect(screen.getByRole("button", { name: tc("close") })).toBeTruthy();
  });

  it("sends a constraint's effect with it", async () => {
    openRecordPr.mockResolvedValue(opened());
    await toStatement("constraint");
    fireEvent.change(screen.getByTestId("record-effect"), {
      target: { value: "require" },
    });
    fireEvent.click(primary());
    await screen.findByTestId("record-checks");
    fireEvent.click(primary());
    await screen.findByTestId("pr-branch");
    await waitFor(() => {
      expect(primary().disabled).toBe(false);
    });
    fireEvent.click(primary());
    await screen.findByTestId("pr-opened");
    const call: unknown[] = proposeRecord.mock.calls[0] ?? [];
    expect(call[2]).toMatchObject({
      record: { kind: "constraint", constraintEffect: "require" },
    });
  });

  it("says a failed check stops the merge and nothing is in force", async () => {
    openRecordPr.mockResolvedValue(
      opened({
        status: "checks_failed",
        checks: [
          { name: "schema", status: "passed", summary: "ok" },
          {
            name: "conflict_against_active",
            status: "failed",
            summary: "forbids what ctx.core.x requires",
          },
        ],
      }),
    );
    await toPullRequest();
    fireEvent.click(primary());
    await screen.findByTestId("pr-opened");
    expect(screen.getByText(t("opened.failed"))).toBeTruthy();
    const failed = screen
      .getByTestId("opened-checks")
      .querySelector('[data-status="failed"]');
    expect(failed?.textContent).toContain("forbids what ctx.core.x requires");
  });

  it("names a refusal to propose where the person acted, and opens nothing (negative)", async () => {
    proposeRecord.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    await toPullRequest();
    fireEvent.click(primary());
    expect((await screen.findByTestId("pr-failure")).textContent).toBe(
      t("failure.orgRoleRequired"),
    );
    expect(openRecordPr).not.toHaveBeenCalled();
    expect(screen.queryByTestId("proposal-kept")).toBeNull();
    expect(primary().disabled).toBe(false);
  });

  it("keeps the proposal when the open fails, and a retry opens it without proposing again (negative)", async () => {
    openRecordPr.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      code: "governance_unreadable",
    });
    await toPullRequest();
    fireEvent.click(primary());
    expect((await screen.findByTestId("pr-failure")).textContent).toBe(
      t("failure.governanceUnreadable"),
    );
    expect(screen.getByTestId("proposal-kept").textContent).toBe(
      t("pr.proposalKept", { proposal: "prp_01K5ABC" }),
    );

    openRecordPr.mockResolvedValueOnce(opened());
    fireEvent.click(primary());
    await screen.findByTestId("pr-opened");
    expect(proposeRecord).toHaveBeenCalledTimes(1);
    expect(openRecordPr).toHaveBeenCalledTimes(2);
  });

  it("names a lineage that already has an open pull request (negative)", async () => {
    openRecordPr.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "lineage_pr_open",
    });
    await toPullRequest();
    fireEvent.click(primary());
    expect((await screen.findByTestId("pr-failure")).textContent).toBe(
      t("failure.lineagePrOpen"),
    );
  });

  it("names a refusal it has no sentence for by its code (negative)", async () => {
    proposeRecord.mockResolvedValue({
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

  it("treats an action that throws as unanswered (negative)", async () => {
    proposeRecord.mockRejectedValue(new Error("network"));
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
    expect(proposeRecord).not.toHaveBeenCalled();
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

  it("says the repository could not be read (unavailable)", async () => {
    readMainRepository.mockResolvedValue({
      ok: false,
      reason: "unavailable",
      code: "github_unreachable",
    });
    await toPullRequest();
    expect((await screen.findByTestId("repo-state")).textContent).toBe(
      t("pr.repo.unavailable", { code: "github_unreachable" }),
    );
    expect(primary().disabled).toBe(true);
  });
});
