// @vitest-environment jsdom
// Fork replay and Bisect (spec §8.4): the two writes that read one recording
// to start another piece of work.
//
// Fork is offered only on a sealed LEDGER run graded fork or retry, and it is
// drawn disabled with the reason everywhere else, so a person is not sent to
// a refusal the row already answers. Bisect reads receipts alone, so it is
// offered on every run.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRow } from "@/data/contracts/runs";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runRow } from "./run.builders";

const { forkRun, bisectRuns, searchBisectRuns, readRunDiff } = vi.hoisted(
  () => ({
    forkRun: vi.fn(),
    bisectRuns: vi.fn(),
    searchBisectRuns: vi.fn(),
    readRunDiff: vi.fn(),
  }),
);
vi.mock("./actions", () => ({ forkRun, bisectRuns }));
vi.mock("./search-actions", () => ({ searchBisectRuns, readRunDiff }));

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
  searchBisectRuns.mockReset().mockResolvedValue({
    ok: true,
    value: {
      runs: [
        runRow({
          id: "tse_other1",
          name: "Fix the release",
          harness: "codex",
          workingDirectory: "/work/oxagen",
          repository: {
            name: "oxagen",
            root: "/work/oxagen",
            branch: "fix/release",
            commit: "aabbcc",
          },
        }),
      ],
      nextCursor: null,
    },
  });
  readRunDiff.mockReset().mockResolvedValue({ ok: true, value: null });
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
    expect(screen.queryByTestId("fork-refused")).toBeNull();
  });

  it("draws Fork disabled with the needs-a-ledger-run reason on a tacho run, and opens no dialog and calls nothing (negative)", async () => {
    const user = userEvent.setup();
    const run = runRow({ source: "tacho", replayGrade: "fork" });
    renderReplay(run);
    const button = screen.getByTestId("run-fork");
    expect(button).toBeDisabled();
    expect(screen.getByTestId("fork-refused")).toHaveTextContent(
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
      expect(screen.getByTestId("fork-refused")).toHaveTextContent(sentence);
    },
  );

  it("draws Fork disabled with the no-grade reason on a ledger run whose replayGrade is null (negative)", () => {
    const run = runRow({ source: "ledger", replayGrade: null });
    renderReplay(run);
    expect(screen.getByTestId("run-fork")).toBeDisabled();
    expect(screen.getByTestId("fork-refused")).toHaveTextContent(
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
    await user.type(screen.getByLabelText("The other run"), "release");
    await user.click(
      await screen.findByRole("option", { name: /Fix the release/ }),
    );
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
    await user.type(screen.getByLabelText("The other run"), "release");
    await user.click(
      await screen.findByRole("option", { name: /Fix the release/ }),
    );
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
    await user.type(screen.getByLabelText("The other run"), "release");
    await user.click(
      await screen.findByRole("option", { name: /Fix the release/ }),
    );
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
});

describe("Bisect run search", () => {
  it("searches names and filters the workspace index, then compares the selected ID", async () => {
    bisectRuns.mockResolvedValue({
      ok: true,
      value: { divergentSeq: null, keyA: null, keyB: null, aligned: 0 },
    });
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    expect(
      screen.getByRole("button", { name: "Find the divergence" }),
    ).toBeDisabled();
    await user.type(
      screen.getByRole("combobox", { name: "The other run" }),
      "release",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Harness" }),
      "codex",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Status" }),
      "sealed",
    );
    await user.type(screen.getByLabelText("Repository or path"), "oxagen");
    await screen.findByRole("option", { name: /Fix the release/ });
    expect(searchBisectRuns).toHaveBeenLastCalledWith(
      "acme",
      "core-platform",
      "tse_7k2m9q",
      {
        cursor: null,
        search: "release",
        harness: "codex",
        status: "sealed",
        repository: "oxagen",
      },
    );
    await user.click(screen.getByRole("combobox", { name: "The other run" }));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByTestId("bisect-selection")).toHaveTextContent(
      "/work/oxagen",
    );
    expect(screen.getByTestId("bisect-selection")).toHaveTextContent(
      "fix/release",
    );
    await user.click(
      screen.getByRole("button", { name: "Find the divergence" }),
    );
    await waitFor(() =>
      expect(bisectRuns).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "tse_7k2m9q",
        "tse_other1",
      ),
    );
  });

  it("loads another cursor page, excludes the current run, and clears a selection when the search changes", async () => {
    searchBisectRuns.mockResolvedValueOnce({
      ok: true,
      value: {
        runs: [runRow(), runRow({ id: "tse_page1", name: "First result" })],
        nextCursor: "older-page",
      },
    });
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await screen.findByRole("option", { name: /First result/ });
    expect(
      screen
        .getAllByRole("option")
        .filter((option) => option.tagName === "BUTTON"),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Load more runs" }));
    await user.click(
      await screen.findByRole("option", { name: /Fix the release/ }),
    );
    expect(searchBisectRuns).toHaveBeenLastCalledWith(
      "acme",
      "core-platform",
      "tse_7k2m9q",
      { cursor: "older-page" },
    );
    await user.type(
      screen.getByRole("combobox", { name: "The other run" }),
      " changed",
    );
    expect(screen.queryByTestId("bisect-selection")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Find the divergence" }),
    ).toBeDisabled();
  });

  it("shows loading, an empty search, and a retryable failure", async () => {
    searchBisectRuns.mockResolvedValueOnce({
      ok: false,
      reason: "error",
      code: "unavailable",
      status: 503,
    });
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    expect(screen.getByText("Searching runs…")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Runs could not be loaded",
    );
    searchBisectRuns.mockResolvedValueOnce({
      ok: true,
      value: { runs: [], nextCursor: null },
    });
    await user.click(screen.getByRole("button", { name: "Retry search" }));
    expect(await screen.findByText(/No matching runs/)).toBeInTheDocument();
  });

  it.each([
    { ok: false, reason: "denied", permission: "workspace.read" },
    { ok: false, reason: "pending_approval", accessRequestId: "apr_wait" },
  ])("preserves a search refusal: $reason", async (failure) => {
    searchBisectRuns.mockResolvedValue(failure);
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      failure.reason === "denied" ? "permission" : "approval",
    );
    expect(screen.queryByRole("button", { name: "Retry search" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Find the divergence" }),
    ).toBeDisabled();
  });

  it("ignores an older search response after the query changes", async () => {
    let resolveOld: (answer: unknown) => void = () => {};
    searchBisectRuns.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await waitFor(() => expect(searchBisectRuns).toHaveBeenCalledTimes(1));
    await user.type(
      screen.getByRole("combobox", { name: "The other run" }),
      "release",
    );
    await screen.findByRole("option", { name: /Fix the release/ });
    resolveOld({
      ok: true,
      value: {
        runs: [runRow({ id: "tse_stale", name: "Stale result" })],
        nextCursor: null,
      },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: /Fix the release/ }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("option", { name: /Stale result/ })).toBeNull();
  });

  it("announces accessible search results and supports escape without closing the dialog", async () => {
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await screen.findByRole("option", { name: /Fix the release/ });
    await expectNoAxe(screen.getByTestId("run-bisect-dialog"));
    await user.click(screen.getByRole("combobox", { name: "The other run" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("run-bisect-dialog")).toBeInTheDocument();
  });

  it("loads the selected run diff on request and escapes the patch as text", async () => {
    const patch = "diff --git a/file b/file\n+<script>alert('unsafe')</script>";
    readRunDiff.mockResolvedValue({
      ok: true,
      value: { patch, truncated: true, complete: true, seq: "12" },
    });
    const user = userEvent.setup();
    renderReplay(runRow());
    await user.click(screen.getByTestId("run-bisect"));
    await user.click(
      await screen.findByRole("option", { name: /Fix the release/ }),
    );
    expect(readRunDiff).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Tracked worktree diff" }),
    );
    expect(await screen.findByText(/<script>alert/)).toBeInTheDocument();
    expect(
      screen.getByText("The recorded patch was truncated."),
    ).toBeInTheDocument();
    expect(readRunDiff).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "tse_other1",
    );
  });

  it.each([
    [null, "No readable diff was retained for this run."],
    [
      { patch: "", truncated: false, complete: true, seq: "2" },
      "The snapshot recorded no tracked-file changes.",
    ],
    [
      { patch: null, truncated: false, complete: false, seq: null },
      "The recording is too long to locate its latest diff in this read. No earlier snapshot is shown.",
    ],
  ])(
    "distinguishes missing, empty, and incomplete diff snapshots",
    async (diff, message) => {
      readRunDiff.mockResolvedValue({ ok: true, value: diff });
      const user = userEvent.setup();
      renderReplay(runRow());
      await user.click(screen.getByTestId("run-bisect"));
      await user.click(
        await screen.findByRole("option", { name: /Fix the release/ }),
      );
      await user.click(
        screen.getByRole("button", { name: "Tracked worktree diff" }),
      );
      expect(await screen.findByText(message)).toBeInTheDocument();
    },
  );
});
