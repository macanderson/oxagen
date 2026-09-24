// @vitest-environment jsdom
// Fork replay and Bisect (spec §8.4): the two writes that read one recording
// to start another piece of work.
//
// Fork is offered only on a sealed LEDGER run graded fork or retry, and it is
// drawn disabled with the reason everywhere else, so a person is not sent to
// a refusal the row already answers. Bisect reads receipts alone, so it is
// offered on every run, and its other run is picked by name or typed as an id.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRow } from "@/data/contracts/runs";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runRow } from "./run.builders";

const { forkRun, bisectRuns, choices } = vi.hoisted(() => ({
  forkRun: vi.fn(),
  bisectRuns: vi.fn(),
  choices: { chooseRuns: vi.fn() },
}));
vi.mock("./actions", () => ({ forkRun, bisectRuns }));
vi.mock("@/features/shell/client", () => choices);

const { ReplayActions } = await import("./replay-actions");

function renderReplay(run: RunRow) {
  return render(
    <IntlProvider>
      <ReplayActions org="acme" ws="core-platform" run={run} />
    </IntlProvider>,
  );
}

beforeEach(() => {
  forkRun.mockReset();
  bisectRuns.mockReset();
  choices.chooseRuns.mockReset();
  choices.chooseRuns.mockResolvedValue({
    ok: true,
    value: {
      options: [
        {
          value: "tse_nightly1",
          label: "Nightly invoices",
          detail: "tse_nightly1",
        },
        {
          value: "arun_release2",
          label: "Release notes",
          detail: "arun_release2",
        },
      ],
      partial: false,
    },
  });
});

afterEach(cleanup);

describe("Fork", () => {
  it("offers Fork on a sealed ledger run graded fork, and mints the attempt from the typed sequence", async () => {
    forkRun.mockResolvedValue({
      ok: true,
      value: { attemptId: "arun_9x2k", attemptNumber: 2 },
    });
    const user = userEvent.setup();
    const run = runRow({
      id: "tse_7k2m9q",
      source: "ledger",
      replayGrade: "fork",
    });
    renderReplay(run);
    await user.click(screen.getByTestId("run-fork"));
    await user.type(screen.getByLabelText("Replay up to frame"), "120");
    await user.click(screen.getByRole("button", { name: "Mint the attempt" }));
    await waitFor(() => {
      expect(screen.getByTestId("fork-attempt")).toHaveTextContent("arun_9x2k");
    });
    expect(forkRun).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "tse_7k2m9q",
      "120",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "The attempt is minted.",
    );
  });

  it("offers Fork on a sealed ledger run graded retry as well", () => {
    const run = runRow({ source: "ledger", replayGrade: "retry" });
    renderReplay(run);
    expect(screen.getByTestId("run-fork")).not.toBeDisabled();
    expect(screen.getByTestId("run-fork")).not.toHaveAttribute("title");
  });

  it("draws Fork disabled with the needs-a-ledger-run reason on a tacho run, and opens no dialog and calls nothing (negative)", async () => {
    const user = userEvent.setup();
    const run = runRow({ source: "tacho", replayGrade: "fork" });
    renderReplay(run);
    const button = screen.getByTestId("run-fork");
    expect(button).toBeDisabled();
    expect(screen.getByTestId("run-fork")).toHaveAttribute(
      "title",
      "Forking replays an attempt from the evidence ledger. This run was recorded by a wrapped agent, which has no attempt to branch from.",
    );
    await user.click(button);
    expect(screen.queryByTestId("run-fork-dialog")).toBeNull();
    expect(forkRun).not.toHaveBeenCalled();
  });

  it.each([
    [
      "inspect",
      "This recording is graded inspect. Forking needs a recording graded fork, because every body before the branch point has to be there.",
    ],
    [
      "view",
      "This recording is graded view. Forking needs a recording graded fork, because every body before the branch point has to be there.",
    ],
  ] as const)(
    "draws Fork disabled with the graded-%s reason on a ledger run (negative)",
    (grade, sentence) => {
      const run = runRow({ source: "ledger", replayGrade: grade });
      renderReplay(run);
      expect(screen.getByTestId("run-fork")).toBeDisabled();
      expect(screen.getByTestId("run-fork")).toHaveAttribute("title", sentence);
    },
  );

  it("draws Fork disabled with the no-grade reason on a ledger run whose replayGrade is null (negative)", () => {
    const run = runRow({ source: "ledger", replayGrade: null });
    renderReplay(run);
    expect(screen.getByTestId("run-fork")).toBeDisabled();
    expect(screen.getByTestId("run-fork")).toHaveAttribute(
      "title",
      "This run's seal recorded no replay grade, so Oxagen cannot say the recording is complete enough to fork.",
    );
  });

  it("renders the mapped sentence when the control plane refuses a fork graded below fork", async () => {
    forkRun.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "replay_grade_below_fork",
    });
    const user = userEvent.setup();
    const run = runRow({ source: "ledger", replayGrade: "fork" });
    renderReplay(run);
    await user.click(screen.getByTestId("run-fork"));
    await user.type(screen.getByLabelText("Replay up to frame"), "10");
    await user.click(screen.getByRole("button", { name: "Mint the attempt" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-fork-failure")).toHaveTextContent(
        "This recording is graded below fork, so the cassette would have a hole in it. Nothing was minted.",
      );
    });
  });

  it("renders the mapped sentence when the control plane refuses a fork for a gap before the branch point", async () => {
    forkRun.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "gap_before_from_seq",
    });
    const user = userEvent.setup();
    const run = runRow({ source: "ledger", replayGrade: "fork" });
    renderReplay(run);
    await user.click(screen.getByTestId("run-fork"));
    await user.type(screen.getByLabelText("Replay up to frame"), "10");
    await user.click(screen.getByRole("button", { name: "Mint the attempt" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-fork-failure")).toHaveTextContent(
        "A frame before that point kept no body, so the replay would have a hole before the branch. Nothing was minted.",
      );
    });
  });

  it("surfaces the branch-point sentence when the action's own guard refuses the typed value", async () => {
    forkRun.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "from_seq",
      field: "fromSeq",
    });
    const user = userEvent.setup();
    const run = runRow({ source: "ledger", replayGrade: "fork" });
    renderReplay(run);
    await user.click(screen.getByTestId("run-fork"));
    await user.type(screen.getByLabelText("Replay up to frame"), "0");
    await user.click(screen.getByRole("button", { name: "Mint the attempt" }));
    await waitFor(() => {
      expect(screen.getByTestId("run-fork-failure")).toHaveTextContent(
        "The branch point is a frame sequence number of at least 1.",
      );
    });
  });

  it("passes an axe check with the fork dialog open", async () => {
    const user = userEvent.setup();
    const run = runRow({ source: "ledger", replayGrade: "fork" });
    const { container } = renderReplay(run);
    await user.click(screen.getByTestId("run-fork"));
    await expectNoAxe(container);
  });
});

describe("Bisect", () => {
  it.each([
    ["ledger", "fork"],
    ["tacho", null],
    ["ledger", "inspect"],
  ] as const)(
    "offers Bisect on a %s run graded %s, whatever fork's eligibility is",
    (source, grade) => {
      const run = runRow({ source, replayGrade: grade });
      renderReplay(run);
      expect(screen.getByTestId("run-bisect")).not.toBeDisabled();
    },
  );

  it("picks the other run by name and sends its id", async () => {
    bisectRuns.mockResolvedValue({
      ok: true,
      value: { divergentSeq: null, keyA: null, keyB: null, aligned: 12 },
    });
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await user.type(screen.getByLabelText("The other run"), "nightly");
    await user.keyboard("{Enter}");
    const form = screen.getByTestId("run-bisect-dialog");
    expect(
      form.querySelector<HTMLInputElement>('input[type="hidden"][name="runB"]')
        ?.value,
    ).toBe("tse_nightly1");
    expect(choices.chooseRuns).toHaveBeenCalledWith("acme", "core-platform");
    await user.click(
      screen.getByRole("button", { name: "Find the divergence" }),
    );
    await waitFor(() => {
      expect(bisectRuns).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        expect.any(String),
        "tse_nightly1",
      );
    });
  });

  it("sends a pasted run id that no loaded run matches, as typed", async () => {
    bisectRuns.mockResolvedValue({
      ok: true,
      value: { divergentSeq: null, keyA: null, keyB: null, aligned: 3 },
    });
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await user.type(screen.getByLabelText("The other run"), "tse_elsewhere9");
    await user.click(
      screen.getByRole("button", { name: "Find the divergence" }),
    );
    await waitFor(() => {
      expect(bisectRuns).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        expect.any(String),
        "tse_elsewhere9",
      );
    });
  });

  it("passes an axe check with the bisect picker open", async () => {
    const user = userEvent.setup();
    const { container } = renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await user.click(screen.getByLabelText("The other run"));
    await screen.findByRole("option", { name: /Nightly invoices/ });
    await expectNoAxe(container);
  });

  it("renders the divergence frame and both keys when the two runs disagree", async () => {
    bisectRuns.mockResolvedValue({
      ok: true,
      value: {
        divergentSeq: "42",
        keyA: "model.call:abc123",
        keyB: "model.call:def456",
        aligned: 41,
      },
    });
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await user.type(screen.getByLabelText("The other run"), "tse_other1");
    await user.click(
      screen.getByRole("button", { name: "Find the divergence" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("bisect-diverged")).toHaveTextContent(
        "The runs diverge at frame 42, after 41 frames that agreed.",
      );
    });
    expect(screen.getByText("model.call:abc123")).toBeInTheDocument();
    expect(screen.getByText("model.call:def456")).toBeInTheDocument();
  });

  it("renders the agree-at-every-frame sentence with the aligned count when divergentSeq is null (negative)", async () => {
    bisectRuns.mockResolvedValue({
      ok: true,
      value: { divergentSeq: null, keyA: null, keyB: null, aligned: 431 },
    });
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await user.type(screen.getByLabelText("The other run"), "tse_other1");
    await user.click(
      screen.getByRole("button", { name: "Find the divergence" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("bisect-same")).toHaveTextContent(
        "The two runs agree at every frame. 431 frames were compared.",
      );
    });
  });

  it("renders the no-frame-at-this-position line for a null key rather than a blank (negative)", async () => {
    bisectRuns.mockResolvedValue({
      ok: true,
      value: {
        divergentSeq: "5",
        keyA: null,
        keyB: "tool_call:xyz",
        aligned: 4,
      },
    });
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await user.type(screen.getByLabelText("The other run"), "tse_other1");
    await user.click(
      screen.getByRole("button", { name: "Find the divergence" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("bisect-diverged")).toBeInTheDocument();
    });
    const keyALabel = screen.getByText("This run");
    expect(keyALabel.nextElementSibling).toHaveTextContent(
      "no frame at this position",
    );
    const keyBLabel = screen.getByText("The other run");
    expect(keyBLabel.nextElementSibling).toHaveTextContent("tool_call:xyz");
  });

  it("says the other run has no frame at the divergence when its key is missing (negative)", async () => {
    bisectRuns.mockResolvedValue({
      ok: true,
      value: {
        divergentSeq: "432",
        keyA: "tool_call:xyz",
        keyB: null,
        aligned: 431,
      },
    });
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await user.type(screen.getByLabelText("The other run"), "tse_other1");
    await user.click(
      screen.getByRole("button", { name: "Find the divergence" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("bisect-diverged")).toBeInTheDocument();
    });
    expect(
      screen.getByText("The other run").nextElementSibling,
    ).toHaveTextContent("no frame at this position");
  });

  it("keeps the form and names the refusal when the comparison is refused, and when the action throws (negative)", async () => {
    bisectRuns.mockResolvedValueOnce({
      ok: false,
      reason: "conflict",
      code: "run_not_found",
    });
    bisectRuns.mockRejectedValueOnce(new Error("network"));
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await user.type(screen.getByLabelText("The other run"), "tse_gone");
    await user.click(
      screen.getByRole("button", { name: "Find the divergence" }),
    );
    const refused = await screen.findByTestId("run-bisect-failure");
    expect(refused.textContent).not.toBe("");
    expect(screen.queryByTestId("bisect-diverged")).toBeNull();
    expect(screen.getByLabelText("The other run")).toHaveValue("tse_gone");
    const first = refused.textContent;
    await user.click(
      screen.getByRole("button", { name: "Find the divergence" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("run-bisect-failure").textContent).not.toBe(
        first,
      );
    });
    expect(bisectRuns).toHaveBeenCalledTimes(2);
  });

  it("opens on an empty form after it was closed on an answer", async () => {
    bisectRuns.mockResolvedValue({
      ok: true,
      value: { divergentSeq: null, keyA: null, keyB: null, aligned: 12 },
    });
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await user.type(screen.getByLabelText("The other run"), "tse_other1");
    await user.click(
      screen.getByRole("button", { name: "Find the divergence" }),
    );
    await screen.findByTestId("bisect-same");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByTestId("run-bisect"));
    expect(screen.queryByTestId("bisect-same")).toBeNull();
    expect(screen.getByLabelText("The other run")).toHaveValue("");
  });

  it("sends one comparison while the first is in flight, however often it is pressed", async () => {
    bisectRuns.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await user.type(screen.getByLabelText("The other run"), "tse_other1");
    const submit = screen.getByRole("button", { name: "Find the divergence" });
    await user.click(submit);
    // The pending button is aria-disabled, not disabled, so this click submits.
    await user.click(submit);
    expect(bisectRuns).toHaveBeenCalledTimes(1);
  });
});

describe("Fork dialog", () => {
  const forkable = () =>
    runRow({ id: "tse_7k2m9q", source: "ledger", replayGrade: "fork" });

  it("opens on an empty field and no attempt after it was closed on a minted one", async () => {
    forkRun.mockResolvedValue({
      ok: true,
      value: { attemptId: "arun_9x2k", attemptNumber: 2 },
    });
    const user = userEvent.setup();
    renderReplay(forkable());
    await user.click(screen.getByTestId("run-fork"));
    await user.type(screen.getByLabelText("Replay up to frame"), "120");
    await user.click(screen.getByRole("button", { name: "Mint the attempt" }));
    await screen.findByTestId("fork-attempt");
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByTestId("run-fork"));
    expect(screen.queryByTestId("fork-attempt")).toBeNull();
    expect(screen.getByLabelText("Replay up to frame")).toHaveValue("");
  });

  it("mints one attempt while the first is in flight, however often it is pressed", async () => {
    forkRun.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderReplay(forkable());
    await user.click(screen.getByTestId("run-fork"));
    await user.type(screen.getByLabelText("Replay up to frame"), "120");
    const submit = screen.getByRole("button", { name: "Mint the attempt" });
    await user.click(submit);
    await user.click(submit);
    expect(forkRun).toHaveBeenCalledTimes(1);
  });

  it("says the fork went unanswered when the action itself throws, and mints nothing (negative)", async () => {
    forkRun.mockRejectedValue(new Error("network"));
    const user = userEvent.setup();
    renderReplay(forkable());
    await user.click(screen.getByTestId("run-fork"));
    await user.type(screen.getByLabelText("Replay up to frame"), "120");
    await user.click(screen.getByRole("button", { name: "Mint the attempt" }));
    expect(await screen.findByTestId("run-fork-failure")).toBeTruthy();
    expect(screen.queryByTestId("fork-attempt")).toBeNull();
  });
});
