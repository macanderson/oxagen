// @vitest-environment jsdom
// The Model fit panel (pages/run.md, Model fit; ADR-194) as a person reads
// it: each card draws the reading `get_run` stored, and a card that argues for
// a move opens the change as a Context pull request against the agent's
// definition file. The rules these hold: the page never computes a reading,
// the effort card prints the effort the rig prints, a move is offered only
// where the reading argues for one, and the dialog says what it will write
// before anything is written.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDetail } from "@/data/contracts/agents";
import type { RunRow } from "@/data/contracts/runs";
import { type Read, readError, readOk } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type { RunFit } from "./fit";
import { runRow } from "./run.builders";

const { openFitChange, refresh } = vi.hoisted(() => ({
  openFitChange: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("./fit-actions", () => ({ openFitChange }));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));

const { ModelFitPanel } = await import("./model-fit");
const { fitChangeSource } = await import("./fit-change");

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };
const COMMITTED = `schema = "agent-definition/v0.1"
slug = "release-manager"
name = "Release manager"
model_tier = "complex"
`;
const DEFINITION = {
  path: ".oxagen/agents/release-manager.toml",
  digest: "sha256:ab",
  commitSha: "4f1c2d9",
  branch: "main",
  pullRequestUrl: "https://github.com/acme/platform/pull/9",
  source: COMMITTED,
  committedAt: "2026-09-10T10:00:00.000Z",
};

function agentDetail(over: Partial<AgentDetail> = {}): AgentDetail {
  return {
    identity: {
      id: "agt_releasemgr",
      slug: "release-manager",
      name: "Release manager",
      description: null,
      agentKey: "acme.core.release-manager",
      harness: "claude-code",
      principalId: null,
      operatorId: null,
      status: "enrolled",
      registeredAt: "2026-09-01T10:00:00.000Z",
      firstFrameAt: null,
      costCenter: null,
    },
    credentials: [],
    roles: [],
    hosts: [],
    definition: DEFINITION,
    ...over,
  };
}

/** A stored reading of the builder's seal. */
function reading(over: Partial<RunFit> = {}): RunFit {
  return {
    method: "run-fit/v1",
    readAt: "2026-09-15T08:45:00.000Z",
    sealedAt: "2026-09-15T08:40:00.000Z",
    read: {
      prompts: 1,
      turns: 2,
      steps: 5,
      failed: 0,
      outputTokens: 1_000,
      reasoningTokens: 400,
    },
    model: { verdict: "over", tier: "sonnet", suggest: "haiku" },
    effort: {
      verdict: "over",
      effort: "high",
      source: "request",
      suggest: "medium",
    },
    ...over,
  };
}

/** A sealed gateway run on sonnet whose proxied request asked for high effort. */
function run(over: Partial<RunRow> = {}): RunRow {
  return runRow({
    model: { slug: "claude-sonnet-5", provider: "anthropic", tier: "sonnet" },
    enforcementTier: "gateway",
    effort: "high",
    effortSource: "request",
    fit: reading(),
    ...over,
  });
}

function renderPanel({
  row = run(),
  agent = readOk(agentDetail()),
  orgRole = "member",
}: {
  row?: RunRow;
  agent?: Read<AgentDetail> | null;
  orgRole?: OrgRole;
} = {}) {
  return render(
    <IntlProvider>
      <ModelFitPanel
        run={row}
        agent={agent}
        place={PLACE}
        orgRole={orgRole}
      />
    </IntlProvider>,
  );
}

beforeEach(() => {
  openFitChange.mockReset();
  refresh.mockReset();
});
afterEach(cleanup);

describe("ModelFitPanel", () => {
  it("argues one class down and one effort level down, and offers each as a change (model over, effort over)", async () => {
    const { container } = renderPanel();
    const model = screen.getByTestId("fit-model-card");
    expect(model.dataset.verdict).toBe("over");
    expect(model).toHaveTextContent("Heavier than needed");
    expect(model).toHaveTextContent(
      "This run landed in 2 turns and 5 steps, first try, with no tool call failing. The reading argues for the haiku class, one rung down the same family.",
    );
    const effort = screen.getByTestId("fit-effort-card");
    expect(effort.dataset.verdict).toBe("over");
    expect(effort).toHaveTextContent("More effort than needed");
    expect(effort).toHaveTextContent(
      "at effort high, read from the model request, and still spent more than a fifth of its output reasoning. The reading argues for effort medium, one level down.",
    );
    expect(
      screen.getByRole("button", { name: "Move this agent to haiku" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Set effort to medium" }),
    ).toBeEnabled();
    expect(screen.getByTestId("fit-read")).toHaveTextContent(
      "1 prompt · 2 turns · 5 steps · no tool call failed",
    );
    expect(screen.getByTestId("model-fit")).toHaveTextContent(
      "generated · not the record",
    );
    await expectNoAxe(container);
  });

  it("argues one class up and one effort level up for a redone run (model under, effort under)", async () => {
    const { container } = renderPanel({
      row: run({
        effort: "low",
        effortSource: "harness",
        enforcementTier: "harness",
        fit: reading({
          read: {
            prompts: 3,
            turns: 9,
            steps: 44,
            failed: 2,
            outputTokens: null,
            reasoningTokens: null,
          },
          model: { verdict: "under", tier: "sonnet", suggest: "opus" },
          effort: {
            verdict: "under",
            effort: "low",
            source: "harness",
            suggest: "medium",
          },
        }),
      }),
    });
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "This run took 3 prompts to land on the sonnet class, and 2 tool calls failed. The reading argues for the opus class, one rung up the same family.",
    );
    const effort = screen.getByTestId("fit-effort-card");
    expect(effort).toHaveTextContent("Less effort than needed");
    expect(effort).toHaveTextContent("at effort low, reported by the harness");
    expect(
      screen.getByRole("button", { name: "Move this agent to opus" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Set effort to medium" }),
    ).toBeEnabled();
    await expectNoAxe(container);
  });

  it("says both fit and offers no change when the reading argues for none (fit on both)", async () => {
    const { container } = renderPanel({
      row: run({
        effort: "medium",
        fit: reading({
          model: { verdict: "fit", tier: "sonnet" },
          effort: { verdict: "fit", effort: "medium", source: "request" },
        }),
      }),
    });
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "The sonnet class matches this shape of work.",
    );
    expect(screen.getByTestId("fit-effort-card")).toHaveTextContent(
      "Effort medium, read from the model request, fits this run.",
    );
    expect(screen.queryByTestId("fit-change-model")).toBeNull();
    expect(screen.queryByTestId("fit-change-effort")).toBeNull();
    await expectNoAxe(container);
  });

  it.each<
    ["not_proxied" | "not_sent", RunRow["enforcementTier"], string, string]
  >([
    [
      "not_proxied",
      "observe",
      "Effort not captured",
      "The model call did not go through Oxagen, so the request body was never read.",
    ],
    [
      "not_sent",
      "gateway",
      "No effort setting",
      "This agent sent no effort setting, so the model used its own default.",
    ],
  ])(
    "says why no effort was captured: %s, and offers no effort change (negative)",
    async (why, enforcementTier, title, reason) => {
      const { container } = renderPanel({
        row: run({
          enforcementTier,
          effort: null,
          effortSource: null,
          fit: reading({ effort: { verdict: "unseen", why } }),
        }),
      });
      const card = screen.getByTestId("fit-effort-card");
      expect(card.dataset.verdict).toBe("unseen");
      expect(card).toHaveTextContent(title);
      expect(card).toHaveTextContent(reason);
      expect(screen.queryByTestId("fit-change-effort")).toBeNull();
      await expectNoAxe(container);
    },
  );

  it("draws no reading on a live run, and says a sealed run's reading is not written yet (negative)", async () => {
    renderPanel({ row: run({ status: "live", sealedAt: null }) });
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "The run is still open. Oxagen reads it once it seals.",
    );
    // The effort card still prints the effort the record holds, with no verdict.
    expect(screen.getByTestId("fit-effort-card")).toHaveTextContent(
      "Effort high, read from the model request.",
    );
    expect(screen.getByTestId("fit-effort-card").dataset.verdict).toBe("none");
    expect(screen.queryByTestId("fit-change-model")).toBeNull();
    cleanup();
    const { container } = renderPanel({ row: run({ fit: null }) });
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "Oxagen has not read this seal yet.",
    );
    expect(screen.getByTestId("fit-read")).toHaveTextContent(
      "There is no reading for this run.",
    );
    await expectNoAxe(container);
  });

  it("claims no rung for a class on no ladder, and says the record lacked a figure (negative)", () => {
    renderPanel({
      row: run({
        model: { slug: "x-1", provider: "x", tier: "ultra" },
        fit: reading({ model: null }),
      }),
    });
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "Oxagen places the ultra class on no capability ladder",
    );
    cleanup();
    renderPanel({ row: run({ fit: reading({ read: null, model: null }) }) });
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "the record does not carry all four yet",
    );
  });
});

describe("the fit change", () => {
  it("shows what it will write, opens the pull request with the one key changed, and names it", async () => {
    openFitChange.mockResolvedValue({
      ok: true,
      value: {
        branch: "agents/release-manager-fit-model",
        pullRequest: {
          number: 12,
          url: "https://github.com/acme/platform/pull/12",
        },
      },
    });
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(
      screen.getByRole("button", { name: "Move this agent to haiku" }),
    );
    const dialog = within(screen.getByTestId("fit-change-dialog"));
    // Each field beside its value, as the dialog's list pairs them.
    const field = (term: string) => dialog.getByText(term).nextElementSibling;
    expect(field("Agent")).toHaveTextContent("Release manager");
    expect(field("File")).toHaveTextContent(
      ".oxagen/agents/release-manager.toml",
    );
    expect(field("Today")).toHaveTextContent("claude-sonnet-5");
    expect(field("Proposed")).toHaveTextContent("haiku");
    expect(field("Effect per run")).toHaveTextContent("not recorded");
    await user.click(
      screen.getByRole("button", { name: "Open the pull request" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("fit-change-opened")).toHaveTextContent(
        "Opened #12. It changes nothing until somebody merges it.",
      );
    });
    expect(openFitChange).toHaveBeenCalledWith("acme", "core-platform", {
      agentId: "agt_releasemgr",
      branch: "agents/release-manager-fit-model",
      message: "Release manager: model haiku",
      source: `${COMMITTED}model = "haiku"\n`,
    });
    expect(
      screen.getByRole("link", { name: "#12" }).getAttribute("href"),
    ).toBe("https://github.com/acme/platform/pull/12");
    await expectNoAxe(container);
  });

  it("says why the pull request was not opened, and names no pull request (negative)", async () => {
    openFitChange.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "forbidden",
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      screen.getByRole("button", { name: "Set effort to medium" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Open the pull request" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("fit-change-failure")).toBeTruthy();
    });
    expect(screen.queryByTestId("fit-change-opened")).toBeNull();
  });

  it("draws the change disabled, with the reason, for a viewer the write refuses and for an agent not read (negative)", async () => {
    const { container } = renderPanel({ orgRole: "viewer" });
    const move = screen.getByRole("button", {
      name: "Move this agent to haiku",
    });
    expect(move).toBeDisabled();
    expect(move).toHaveAccessibleDescription(
      "Opening a pull request against an agent's definition needs an organization Owner, Admin or Member role.",
    );
    await expectNoAxe(container);
    cleanup();
    renderPanel({ agent: readError("not_found", 404) });
    expect(
      screen.getByRole("button", { name: "Set effort to medium" }),
    ).toHaveAccessibleDescription(
      "The agent was not read, so its definition file is not known.",
    );
    cleanup();
    renderPanel({ agent: null });
    expect(
      screen.getByRole("button", { name: "Move this agent to haiku" }),
    ).toBeDisabled();
  });

  it("edits the committed file, or the seed when none is committed, at the top level", () => {
    expect(fitChangeSource(agentDetail(), "effort", "medium")).toBe(
      `${COMMITTED}effort = "medium"\n`,
    );
    // A key already set is changed in place, not written twice.
    const set = agentDetail({
      definition: { ...DEFINITION, source: `${COMMITTED}model = "opus"\n` },
    });
    expect(fitChangeSource(set, "model", "sonnet")).toBe(
      `${COMMITTED}model = "sonnet"\n`,
    );
    const seeded = fitChangeSource(
      agentDetail({ definition: null }),
      "model",
      "haiku",
    );
    expect(seeded).toBe(
      `schema = "agent-definition/v0.1"\nslug = "release-manager"\nname = "Release manager"\nmodel = "haiku"\n`,
    );
  });
});
