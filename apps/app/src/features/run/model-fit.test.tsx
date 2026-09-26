// @vitest-environment jsdom
// The Model fit panel (pages/run.md, Model fit; ADR-201) as a person reads
// it: each card draws the reading `get_run` stored. The rules these hold: the
// page never computes a reading, the effort card prints the effort the rig
// prints, and a move is drawn only where the reading argues for one, as a
// disabled stub that says no contract makes it from this page, because an
// agent carries no definition file to change (ADR-198).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRow } from "@/data/contracts/runs";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import type { RunFit } from "./fit";
import { runRow } from "./run.builders";

const { ModelFitPanel } = await import("./model-fit");

const MODEL_STUB =
  "No contract changes an agent's model class from this page yet.";
const EFFORT_STUB =
  "No contract changes an agent's effort setting from this page yet.";

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

function renderPanel({ row = run() }: { row?: RunRow } = {}) {
  return render(
    <IntlProvider>
      <ModelFitPanel run={row} />
    </IntlProvider>,
  );
}

/** The move a card argues for: a disabled button whose description says why. */
function expectStub(name: string, why: string) {
  const move = screen.getByRole("button", { name });
  expect(move).toBeDisabled();
  expect(move).toHaveAccessibleDescription(why);
}

afterEach(cleanup);

describe("ModelFitPanel", () => {
  it("argues one class down and one effort level down, and draws each move as a stub (model over, effort over)", async () => {
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
    expectStub("Move this agent to haiku", MODEL_STUB);
    expectStub("Set effort to medium", EFFORT_STUB);
    expect(screen.getByTestId("fit-read")).toHaveTextContent(
      "1 prompt · 2 turns · 5 steps · no tool call failed",
    );
    expect(screen.getByTestId("model-fit")).toHaveTextContent(
      "generated · not the record",
    );
    // An agent carries no definition file (ADR-198), so the note names none.
    expect(screen.getByTestId("fit-read")).not.toHaveTextContent(
      ".oxagen/agents/",
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
    expectStub("Move this agent to opus", MODEL_STUB);
    expectStub("Set effort to medium", EFFORT_STUB);
    await expectNoAxe(container);
  });

  it("says both fit and draws no move when the reading argues for none (fit on both)", async () => {
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
    expect(screen.queryByTestId("fit-move-model")).toBeNull();
    expect(screen.queryByTestId("fit-move-effort")).toBeNull();
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
    "says why no effort was captured: %s, and draws no effort move (negative)",
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
      expect(screen.queryByTestId("fit-move-effort")).toBeNull();
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
    expect(screen.queryByTestId("fit-move-model")).toBeNull();
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

  it("claims no rung for a class on no ladder, and says the record lacked a figure (negative)", async () => {
    const offLadder = renderPanel({
      row: run({
        model: { slug: "x-1", provider: "x", tier: "ultra" },
        fit: reading({ model: null }),
      }),
    });
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "Oxagen places the ultra class on no capability ladder",
    );
    await expectNoAxe(offLadder.container);
    cleanup();
    const unread = renderPanel({
      row: run({ fit: reading({ read: null, model: null }) }),
    });
    expect(screen.getByTestId("fit-model-card")).toHaveTextContent(
      "the record does not carry all four yet",
    );
    await expectNoAxe(unread.container);
  });
});
