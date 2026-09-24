// @vitest-environment jsdom
// The Transcript tab (mockup `transcriptTab`; pages/run.md, Transcript): the
// header line and its burn meter, the kind chips and what each filters, the
// rows the record reads as, the search, the transport, paging past the
// cursor and following a live run's head.
//
// The chips, the search and the transport are the viewer's own state over
// the whole-run transcript the page read, so what they prove is which rows
// are on screen. The paging is proved by what survives it: an appended page
// leaves every row already on screen where it was, and a refused cursor says
// so rather than emptying the view.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSCRIPT_ENTRY_DEFAULT,
  type RunTranscript,
  type TranscriptKind,
} from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { readError, readOk } from "@/data/read";
import type { ActionResult } from "@/server/kernel";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  mockupTranscript,
  runRow,
  runTranscript,
  transcriptBody,
  transcriptEntry,
} from "./run.builders";
import {
  type FrameSpec,
  releaseSpecs,
  releaseTranscript,
  transcriptOf,
} from "./transcript.builders";

/** A page-action refusal the player shows under the feed. */
const pageFailed = (code: string): ActionResult<RunTranscript> => ({
  ok: false,
  reason: "unavailable",
  code,
});

/** A successful page-action answer. */
const pageOk = (value: RunTranscript): ActionResult<RunTranscript> => ({
  ok: true,
  value,
});

const { readTranscriptPage } = vi.hoisted(() => ({
  readTranscriptPage: vi.fn<typeof import("./actions").readTranscriptPage>(),
}));
vi.mock("./actions", () => ({ readTranscriptPage }));
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));

const { TranscriptSection } = await import("./transcript");
const { paceMs } = await import("./transcript-view");

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };
const RUN = runRow({
  agentKey: "a-intel.core.release-manager",
  taskRef: "a-intel/platform#482",
  turns: 7,
  steps: 41,
  model: { slug: "claude-opus-5", provider: "anthropic", tier: "opus" },
});

type SectionView = {
  read?: Read<RunTranscript>;
  kinds?: TranscriptKind[];
  status?: RunRow["status"];
  run?: Partial<RunRow>;
};

function renderSection(view: SectionView = {}) {
  const {
    read = readOk(releaseTranscript()),
    kinds = [],
    status = RUN.status,
    run = {},
  } = view;
  return render(
    <IntlProvider>
      <TranscriptSection
        read={read}
        run={{
          ...RUN,
          status,
          sealedAt: status === "live" ? null : RUN.sealedAt,
          ...run,
        }}
        kinds={kinds}
        {...PLACE}
      />
    </IntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  readTranscriptPage.mockReset();
  refresh.mockReset();
});

const rows = () => screen.queryAllByTestId("tx-row");
const kinds = () => rows().map((row) => row.getAttribute("data-kind"));
const readout = () => screen.getByTestId("transport-readout");
/** The tool row whose name reads `name`. */
function toolRow(name: string): HTMLElement {
  const found = rows().find(
    (row) => within(row).queryByTestId("tx-tool-name")?.textContent === name,
  );
  if (found === undefined) throw new Error(`no ${name} row`);
  return found;
}

describe("the header line", () => {
  it("names the task, the agent, the model, the turns, the steps and the entries", () => {
    renderSection();
    const bar = screen.getByTestId("tx-runbar");
    expect(bar).toHaveTextContent("a-intel/platform#482");
    expect(bar).toHaveTextContent(
      "a-intel.core.release-manager · claude-opus-5 · 7 turns · 41 steps · 20 entries",
    );
    expect(within(bar).getByText("sealed")).toBeInTheDocument();
  });

  it("reads live on a live run, and the burn against the run's own running total with its basis", () => {
    renderSection({ status: "live" });
    const bar = screen.getByTestId("tx-runbar");
    expect(bar).toHaveTextContent("● live");
    expect(screen.getByTestId("tx-burn")).toHaveTextContent(
      "burn$2.84of $2.84 gateway_observed",
    );
  });

  it("says the burn was not recorded when no frame carried a cost (negative)", () => {
    renderSection({
      read: readOk(
        transcriptOf(
          releaseSpecs().map((spec) => {
            const { costMicros: _cost, ...rest } = spec;
            return rest;
          }),
        ),
      ),
    });
    expect(screen.getByTestId("tx-burn")).toHaveTextContent("burnnot recorded");
  });

  it("leaves the turns out when the run recorded none, rather than print a zero", () => {
    renderSection({ run: { turns: null } });
    expect(screen.getByTestId("tx-runbar")).not.toHaveTextContent("turns");
  });
});

describe("the kind chips", () => {
  it("draws the design's seven chips with each one's count, all pressed", () => {
    renderSection();
    const chips = within(
      screen.getByRole("group", { name: "Filter the transcript" }),
    );
    const pressed = chips
      .getAllByRole("button", { pressed: true })
      .map((chip) => chip.textContent);
    expect(pressed).toEqual([
      "prompt1",
      "responses5",
      "thinking2",
      "tools6",
      "usage5",
      "recall1",
      "seal0",
    ]);
    expect(screen.getByTestId("chip-all")).toHaveTextContent("none");
    expect(screen.getByTestId("chip-errors")).toHaveTextContent("✗ errors1");
    expect(screen.getByTestId("chip-errors")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("hides the rows a released chip names and keeps its count", () => {
    renderSection();
    expect(kinds().filter((kind) => kind === "tool")).toHaveLength(6);
    fireEvent.click(screen.getByTestId("chip-tools"));
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(kinds()).not.toContain("tool");
    expect(screen.getByTestId("chip-tools")).toHaveTextContent("tools6");
    expect(readout()).toHaveTextContent("14 / 14");
  });

  it("filters thinking on the reply's thinking blocks", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("chip-thinking"));
    expect(kinds()).not.toContain("thinking");
    expect(kinds()).toContain("text");
  });

  it("turns every chip off and on again from the all toggle", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("chip-all"));
    expect(rows()).toHaveLength(0);
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "Nothing to show with these filters.",
    );
    expect(screen.getByTestId("chip-all")).toHaveTextContent("all");
    fireEvent.click(screen.getByTestId("chip-all"));
    expect(rows()).toHaveLength(20);
  });

  it("shows only the failed calls under errors, and says so in the header line", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("chip-errors"));
    expect(kinds()).toEqual(["tool"]);
    expect(rows()[0]).toHaveTextContent("Bash");
    expect(screen.getByTestId("tx-runbar")).toHaveTextContent("errors only");
  });

  it("says a run with no failed call has none to show (negative)", () => {
    renderSection({
      read: readOk(
        transcriptOf(
          releaseSpecs().map((spec) =>
            spec.seq === 12 ? { ...spec, kinds: [], label: "Bash ok" } : spec,
          ),
        ),
      ),
    });
    const errors = screen.getByTestId("chip-errors");
    expect(errors).toHaveAttribute("title", "No failed calls in this run");
    expect(errors).toHaveTextContent(/^✗ errors$/);
    fireEvent.click(errors);
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "No failed calls in this run.",
    );
  });

  it("counts the run's stop frames under seal", () => {
    renderSection({
      read: readOk(
        transcriptOf([
          ...releaseSpecs(),
          {
            seq: 18,
            t: 120,
            type: "agent_stop",
            kind: "frame",
            label: "agent_stop completed",
            turn: null,
          },
        ]),
      ),
    });
    expect(screen.getByTestId("chip-seal")).toHaveTextContent("seal1");
    expect(kinds().at(-1)).toBe("seal");
    // The run is sealed, so its last stop reads as the seal and its instant.
    expect(rows().at(-1)).toHaveTextContent("sealed 08:55:00");
  });

  it("opens with the chips an older link's filter named", () => {
    renderSection({ kinds: ["tools", "errors"] });
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("chip-prompt")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("chip-errors")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("passes an axe check with a chip released and the errors toggle on", async () => {
    const { container } = renderSection();
    fireEvent.click(screen.getByTestId("chip-usage"));
    fireEvent.click(screen.getByTestId("chip-errors"));
    await expectNoAxe(container);
  });
});

describe("the rows", () => {
  it("opens on the operator's first prompt, named with the task", () => {
    renderSection();
    const [first] = rows();
    expect(first).toHaveAttribute("data-kind", "prompt");
    const you = screen.getByTestId("transcript-you");
    expect(you).toHaveTextContent("YOU");
    expect(you).toHaveTextContent(/^YOUCut the 4\.11\.0 release notes/);
    expect(you).toHaveTextContent(
      "Marcus Bell · operatortask a-intel/platform#482first prompt",
    );
  });

  it("leads each call with the tool's short name and its arguments on the first line", () => {
    renderSection();
    const list = toolRow("github__list_pull_requests");
    expect(within(list).getByTestId("tx-tool-arg")).toHaveTextContent(
      "a-intel/platform · state closed · base main",
    );
    expect(list).toHaveTextContent("1.1 s");
    expect(list).toHaveTextContent("7 lines");
    expect(
      within(toolRow("Read")).getByTestId("tx-tool-arg"),
    ).toHaveTextContent("…/platform/CHANGELOG.md");
    // No row reads as the model frame that carried the call.
    const names = screen
      .getAllByTestId("tx-tool-name")
      .map((name) => name.textContent);
    for (const frameType of ["llm_call", "model.response", "tool_call"])
      expect(names).not.toContain(frameType);
    expect(
      names.filter((name) => name === "github__list_pull_requests"),
    ).toHaveLength(1);
  });

  it("opens the gateway's own decision behind the ⚖ chip, on the Governed actions tab", () => {
    renderSection();
    const chip = within(toolRow("github__list_pull_requests")).getByRole(
      "link",
      { name: "allow · fr 6" },
    );
    expect(chip).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=6",
    );
  });

  it("folds the call as it was made and a link to its frame under the row", () => {
    renderSection();
    const list = toolRow("github__list_pull_requests");
    expect(within(list).queryByTestId("tx-call-fold")).toBeNull();
    fireEvent.click(
      within(list).getByRole("button", { name: "Show the call" }),
    );
    const fold = within(list).getByTestId("tx-call-fold");
    expect(fold).toHaveTextContent('"repo": "a-intel/platform"');
    expect(
      within(fold).getByRole("link", { name: "tool_call · fr 7" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=7",
    );
    // The whole output opens with it.
    expect(within(list).getByTestId("tx-out")).toHaveTextContent("#470");
  });

  it("shows six lines of a longer output and says how many it holds back", () => {
    renderSection();
    const list = toolRow("github__list_pull_requests");
    expect(within(list).getByTestId("tx-out")).not.toHaveTextContent("#470");
    expect(
      within(list).getByRole("button", { name: /1 more line/ }),
    ).toBeTruthy();
  });

  it("reads a new file as the diff it is, and marks a failed call and its output", () => {
    renderSection();
    const write = toolRow("Write");
    expect(within(write).getByTestId("tx-diff")).toHaveTextContent("new file");
    expect(write).toHaveTextContent("+13 −0");
    const bash = toolRow("Bash");
    expect(bash).toHaveTextContent("✗");
    expect(within(bash).getByTestId("tx-out").className).toContain(
      "text-error",
    );
  });

  it("parks a call waiting on an approval, with its request's frame and no duration", () => {
    renderSection();
    const release = toolRow("github__create_release");
    expect(
      within(release).getByRole("link", { name: "parked · fr 17" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=17",
    );
    expect(release).toHaveTextContent("Held at Oxagen until someone answers.");
    expect(release).not.toHaveTextContent(/\d ms/);
  });

  it("says what each model step cost, its tokens and the running total, with the frame behind them", () => {
    renderSection();
    const usage = screen.getAllByTestId("tx-usage")[0];
    if (usage === undefined) throw new Error("expected a usage row");
    expect(usage).toHaveTextContent(
      "usage · claude-opus-5 · in 3,368 · cache 12,000 · out 412",
    );
    expect(usage).toHaveTextContent("$0.4126");
    expect(usage).toHaveTextContent("Σ $0.4126");
    expect(
      within(usage).getByRole("link", {
        name: "model.response · fr 4",
      }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=4",
    );
  });

  it("lists three recalled frames and folds the rest with their tokens", () => {
    renderSection();
    const recall = screen.getByTestId("tx-recall");
    expect(recall).toHaveTextContent("◉ recall · 6 frames · 11,204 tok");
    expect(recall).not.toHaveTextContent("RELEASING.md");
    fireEvent.click(
      within(recall).getByRole("button", { name: /3 more · 5,218 tok/ }),
    );
    expect(recall).toHaveTextContent("RELEASING.md");
    expect(
      within(recall).getByRole("link", { name: "open the Context tab" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=context",
    );
  });

  it("reads the agent's last words as the answer once the run has stopped, and not while it runs", () => {
    renderSection();
    const agents = screen.getAllByTestId("transcript-agent");
    expect(agents.at(-1)).toHaveTextContent(/^ANSWER/);
    expect(agents[0]).toHaveTextContent(/^AGENT/);
    cleanup();
    renderSection({ status: "live" });
    expect(screen.getAllByTestId("transcript-agent").at(-1)).toHaveTextContent(
      /^AGENT/,
    );
  });

  it("folds the model's words after the first sentence until asked", () => {
    renderSection();
    const second = screen.getAllByTestId("transcript-agent")[1];
    if (second === undefined) throw new Error("expected the agent's words");
    expect(second).toHaveTextContent("31 merged in range. …");
    expect(second).not.toHaveTextContent("Reading CHANGELOG.md");
    fireEvent.click(
      within(second).getByRole("button", { name: "Show the rest" }),
    );
    expect(second).toHaveTextContent(
      "Reading CHANGELOG.md for the heading order",
    );
  });

  it("opens every thought with expand thinking, and closes them again", () => {
    renderSection({
      read: readOk(
        transcriptOf(
          releaseSpecs().map((spec) =>
            spec.seq === 4
              ? {
                  ...spec,
                  blocks: [
                    {
                      kind: "thinking" as const,
                      text: "First thought. Second thought.",
                    },
                  ],
                }
              : spec,
          ),
        ),
      ),
    });
    const [thought] = screen.getAllByTestId("tx-think");
    expect(thought).not.toHaveTextContent("Second thought.");
    fireEvent.click(screen.getByRole("button", { name: "expand thinking" }));
    expect(thought).toHaveTextContent("Second thought.");
    fireEvent.click(screen.getByRole("button", { name: "collapse thinking" }));
    expect(thought).not.toHaveTextContent("Second thought.");
  });

  it("reads each row's clock in the viewer's zone and names its place in the run", () => {
    renderSection();
    const time = rows()[2]?.querySelector("time");
    expect(time?.textContent).toBe("08:00:07.7");
    expect(time?.getAttribute("dateTime")).toBe("2026-09-15T08:00:07.700Z");
    expect(time?.getAttribute("title")).toBe("+7.7 s from the run's start");
  });

  it("marks a subagent's row and links no frame of its chain (negative: the run's own frame still links)", () => {
    const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c1";
    const specs: FrameSpec[] = [
      {
        seq: 3,
        t: 1,
        type: "tool_call",
        kind: "tool_call",
        label: "Grep ok",
        turn: 1,
        subagent: { chainRef: CHAIN, type: "Explore" },
        response: '{"input":{"pattern":"flaky"},"output":"a.test.ts"}',
      },
      {
        seq: 4,
        t: 2,
        type: "tool_call",
        kind: "tool_call",
        label: "Grep ok",
        turn: 1,
        response: '{"input":{"pattern":"retry"},"output":"b.test.ts"}',
      },
    ];
    renderSection({ read: readOk(transcriptOf(specs)) });
    const [sub, own] = rows();
    if (sub === undefined || own === undefined)
      throw new Error("both rows are drawn");
    expect(within(sub).getByTestId("transcript-subagent")).toHaveTextContent(
      "subagent Explore",
    );
    fireEvent.click(within(sub).getByRole("button", { name: "Show the call" }));
    expect(within(sub).queryAllByRole("link")).toHaveLength(0);
    fireEvent.click(within(own).getByRole("button", { name: "Show the call" }));
    expect(
      within(own).getByRole("link", { name: "tool_call · fr 4" }),
    ).toBeTruthy();
  });

  it("says a body was cut at the ceiling inside the call's fold", () => {
    renderSection({
      read: readOk(
        transcriptOf(
          releaseSpecs().map((spec) =>
            spec.seq === 9 ? { ...spec, truncated: true } : spec,
          ),
        ),
      ),
    });
    const read = toolRow("Read");
    fireEvent.click(
      within(read).getByRole("button", { name: "Show the call" }),
    );
    expect(within(read).getByTestId("tx-call-fold")).toHaveTextContent(
      "Cut at the length one entry carries.",
    );
  });

  it("closes on the design's note", () => {
    renderSection();
    expect(screen.getByTestId("transcript-note")).toHaveTextContent(
      "The transcript is what the agent showed its operator. The gateway’s own frames sit behind the ⚖ chips.",
    );
  });

  it("passes an axe check with a call's fold and the recall open", async () => {
    const { container } = renderSection();
    fireEvent.click(
      within(toolRow("Read")).getByRole("button", { name: "Show the call" }),
    );
    fireEvent.click(
      within(screen.getByTestId("tx-recall")).getByRole("button", {
        name: /3 more/,
      }),
    );
    await expectNoAxe(container);
  });
});

describe("the search", () => {
  it("shows every match at once, counts them and marks them", () => {
    renderSection();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search the transcript" }),
      { target: { value: "changelog" } },
    );
    expect(screen.getByTestId("tx-matches")).toHaveTextContent(
      "5 of 20 entries",
    );
    expect(rows()).toHaveLength(5);
    expect(
      screen.getAllByText(/changelog/i, { selector: "mark" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByTestId("transport-readout")).toBeNull();
    expect(screen.getByText("Search shows every match at once.")).toBeTruthy();
  });

  it("says nothing matches rather than showing an empty feed (negative)", () => {
    renderSection();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search the transcript" }),
      { target: { value: "no such words" } },
    );
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "Nothing matches this search.",
    );
  });
});

describe("the transport", () => {
  it("paces on the recorded gap, held between 90 ms and 1.4 s, both divided by the speed", () => {
    expect(paceMs(0, 1)).toBe(90);
    expect(paceMs(700, 1)).toBe(700);
    expect(paceMs(60_000, 1)).toBe(1400);
    expect(paceMs(60_000, 2)).toBe(700);
    expect(paceMs(60, 6)).toBe(15);
    expect(paceMs(-5, 1)).toBe(90);
  });

  it("opens a sealed run at its end, ready to replay", () => {
    renderSection();
    expect(readout()).toHaveTextContent("20 / 20");
    expect(screen.getByTestId("tx-play")).toHaveTextContent("replay");
    expect(screen.getByRole("button", { name: "Step forward" })).toBeDisabled();
  });

  it("steps back a row at a time and rewinds to nothing, moving the burn with it", () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Step back" }));
    expect(readout()).toHaveTextContent("19 / 20");
    expect(rows()).toHaveLength(19);
    expect(screen.getByTestId("tx-play")).toHaveTextContent("play");
    expect(screen.getByTestId("tx-burn")).toHaveTextContent("$2.84of $2.84");
    fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
    expect(readout()).toHaveTextContent("0 / 20");
    expect(rows()).toHaveLength(0);
    expect(screen.getByTestId("tx-burn")).toHaveTextContent("none yet");
    fireEvent.click(screen.getByRole("button", { name: "To the end" }));
    expect(readout()).toHaveTextContent("20 / 20");
  });

  it("replays from the start at the recorded pace, faster at a higher speed, and pauses", () => {
    vi.useFakeTimers();
    try {
      renderSection();
      fireEvent.click(screen.getByTestId("tx-play"));
      expect(readout()).toHaveTextContent("0 / 20");
      expect(screen.getByTestId("tx-play")).toHaveTextContent("pause");
      // The first row is at the run's start: the floor, 90 ms.
      act(() => {
        vi.advanceTimersByTime(90);
      });
      expect(readout()).toHaveTextContent("1 / 20");
      // The recall row is 0.3 s in.
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(readout()).toHaveTextContent("2 / 20");
      fireEvent.click(screen.getByRole("button", { name: "6×" }));
      expect(screen.getByRole("button", { name: "6×" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      // 7.4 s to the thought, held at 1.4 s and divided by six.
      act(() => {
        vi.advanceTimersByTime(234);
      });
      expect(readout()).toHaveTextContent("3 / 20");
      fireEvent.click(screen.getByTestId("tx-play"));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(readout()).toHaveTextContent("3 / 20");
    } finally {
      vi.useRealTimers();
    }
  });

  it("follows a live run from its head, and pausing holds the rows shown", () => {
    renderSection({ status: "live" });
    expect(readout()).toHaveTextContent("20 / 20");
    expect(screen.getByTestId("tx-play")).toHaveTextContent("pause");
    fireEvent.click(screen.getByTestId("tx-play"));
    expect(screen.getByTestId("tx-play")).toHaveTextContent("play");
    expect(readout()).toHaveTextContent("20 / 20");
  });
});

describe("paging past the cursor", () => {
  const paged = readOk(releaseTranscript({ cursor: "ZjoxMQ", complete: true }));
  /** The run's tail: the approval answered, the release made, the agent stopped. */
  const tail = transcriptOf([
    ...releaseSpecs(),
    {
      seq: 18,
      t: 110,
      type: "approval_decision",
      kind: "policy",
      label: "approve mcp__github__create_release",
      turn: 1,
      callKey: "toolu_6",
      decision: "approve",
    },
    {
      seq: 19,
      t: 111,
      type: "tool_call",
      kind: "tool_call",
      label: "mcp__github__create_release ok",
      turn: 1,
      callKey: "toolu_6",
      response: '{"input":{"tag_name":"v4.11.0"},"output":"draft created"}',
    },
  ]);
  const tailPage = { ...tail, entries: tail.entries.slice(-2) };

  it("offers to read more only when the read carried a cursor", () => {
    renderSection({ read: paged });
    expect(screen.getByTestId("transcript-more")).toBeInTheDocument();
    expect(screen.getByTestId("transcript-count")).toHaveTextContent(
      "More lie past this page",
    );
    cleanup();
    renderSection();
    expect(screen.queryByTestId("transcript-more")).toBeNull();
    expect(screen.queryByTestId("transcript-count")).toBeNull();
  });

  it("reads the next page from the cursor, whole, and appends it", async () => {
    readTranscriptPage.mockResolvedValue(
      pageOk({ ...tailPage, cursor: null, complete: true }),
    );
    renderSection({ read: paged, kinds: ["tools"] });
    const before = rows().map((row) => row.textContent);
    fireEvent.click(screen.getByTestId("transcript-more"));
    await waitFor(() => {
      expect(
        within(toolRow("github__create_release")).queryByText(
          "⏸ parked · fr 17",
        ),
      ).toBeNull();
    });
    // The chips filter in the browser, so the page is read whole.
    expect(readTranscriptPage).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "tse_7k2m9q",
      "everything",
      [],
      "ZjoxMQ",
    );
    // The release call is now one row with its answer and its result.
    expect(toolRow("github__create_release")).toHaveTextContent(
      "draft created",
    );
    expect(
      rows()
        .slice(0, -1)
        .map((row) => row.textContent),
    ).toEqual(before.slice(0, -1));
  });

  it("stops offering more once the page it read carried no cursor", async () => {
    readTranscriptPage.mockResolvedValue(
      pageOk({ ...tailPage, cursor: null, complete: true }),
    );
    renderSection({ read: paged });
    fireEvent.click(screen.getByTestId("transcript-more"));
    await waitFor(() => {
      expect(screen.queryByTestId("transcript-more")).toBeNull();
    });
  });

  it("names a cursor the capability did not write, and keeps every row already read (negative)", async () => {
    readTranscriptPage.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_cursor",
      field: "after",
    });
    renderSection({ read: paged });
    const before = rows().length;
    fireEvent.click(screen.getByTestId("transcript-more"));
    await waitFor(() => {
      expect(screen.getByTestId("transcript-page-failed")).toHaveTextContent(
        "not one this read wrote",
      );
    });
    expect(rows()).toHaveLength(before);
  });

  it("says a page failed for any other reason without claiming the cursor was bad (negative)", async () => {
    readTranscriptPage.mockResolvedValue(pageFailed("frame_store_unreachable"));
    renderSection({ read: paged });
    fireEvent.click(screen.getByTestId("transcript-more"));
    await waitFor(() => {
      expect(screen.getByTestId("transcript-page-failed")).toHaveTextContent(
        "could not be read",
      );
    });
  });

  it("says a page that threw before it answered failed, rather than leaving the control spinning (negative)", async () => {
    readTranscriptPage.mockRejectedValue(new Error("network"));
    renderSection({ read: paged });
    fireEvent.click(screen.getByTestId("transcript-more"));
    await waitFor(() => {
      expect(screen.getByTestId("transcript-page-failed")).toBeInTheDocument();
    });
    expect(screen.getByTestId("transcript-more")).not.toBeDisabled();
  });

  it("says the read stopped short when the run had more frames than it carried (negative)", () => {
    renderSection({ read: readOk(releaseTranscript({ complete: false })) });
    expect(screen.getByTestId("transcript-count")).toHaveTextContent(
      "stops short of the end",
    );
  });
});

/** An EventSource the test drives, capturing each one the hook opens. */
function fakeEventSource(state: number) {
  const instances: {
    onmessage: ((event: MessageEvent<string>) => void) | null;
  }[] = [];
  class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readyState = state;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: (() => void) | null = null;
    close(): void {
      this.readyState = FakeEventSource.CLOSED;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    constructor() {
      instances.push(this);
    }
  }
  vi.stubGlobal("EventSource", FakeEventSource);
  return instances;
}

describe("following a live run", () => {
  it("does not re-read the page on a timer: the stream is what says a frame landed (negative)", () => {
    vi.useFakeTimers();
    try {
      renderSection({ read: readOk(mockupTranscript()), status: "live" });
      vi.advanceTimersByTime(60_000);
      expect(refresh).not.toHaveBeenCalled();
      expect(readTranscriptPage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws no footer while following an open stream, and the transport stays reachable", () => {
    fakeEventSource(1);
    try {
      renderSection({
        read: readOk(mockupTranscript({ cursor: "ZjoxMQ", complete: false })),
        status: "live",
      });
      expect(screen.queryByTestId("transcript-count")).toBeNull();
      expect(readout()).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads the tail once more for a frame that landed during an active read, rather than dropping it (negative)", async () => {
    const instances = fakeEventSource(1);
    // readTranscriptPage never resolves until the test tells it to, so the
    // second frame is guaranteed to land while the first read is in flight.
    const pending: ((read: ActionResult<RunTranscript>) => void)[] = [];
    readTranscriptPage.mockImplementation(
      () =>
        new Promise<ActionResult<RunTranscript>>((resolve) => {
          pending.push(resolve);
        }),
    );
    vi.useFakeTimers();
    try {
      renderSection({
        read: readOk(mockupTranscript({ cursor: "ZjoxMQ", complete: false })),
        status: "live",
      });
      const [source] = instances;
      if (source === undefined) throw new Error("no EventSource opened");
      // The first frame starts the one read the guard lets through.
      source.onmessage?.(new MessageEvent("message", { data: "{}" }));
      await vi.advanceTimersByTimeAsync(750);
      expect(pending).toHaveLength(1);
      // A second frame lands while that read is still pending.
      source.onmessage?.(new MessageEvent("message", { data: "{}" }));
      await vi.advanceTimersByTimeAsync(750);
      expect(pending).toHaveLength(1);
      // The active read settles. The recorded signal triggers the follow-up
      // tail read on its own, with no third frame required.
      const resolveFirst = pending[0];
      if (resolveFirst === undefined) throw new Error("no pending read");
      await act(async () => {
        resolveFirst(
          pageOk({
            ...mockupTranscript(),
            entries: [],
            cursor: "next",
            complete: false,
          }),
        );
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(pending).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("drains every full page from one coalesced signal until a short page, rather than stalling behind the head (negative)", async () => {
    const instances = fakeEventSource(1);
    const fullPage = (cursor: string, seqFrom: number) =>
      pageOk(
        runTranscript({
          zoom: "everything",
          entries: Array.from({ length: TRANSCRIPT_ENTRY_DEFAULT }, (_, i) =>
            transcriptEntry({
              seq: String(seqFrom + i),
              endSeq: String(seqFrom + i),
              turn: null,
              request: null,
              response: null,
            }),
          ),
          cursor,
          complete: false,
        }),
      );
    const shortPage = pageOk(
      runTranscript({
        zoom: "everything",
        entries: [
          transcriptEntry({
            seq: "450",
            endSeq: "450",
            turn: null,
            request: null,
            response: null,
          }),
        ],
        cursor: null,
        complete: true,
      }),
    );
    readTranscriptPage
      .mockResolvedValueOnce(fullPage("page2", 100))
      .mockResolvedValueOnce(fullPage("page3", 300))
      .mockResolvedValueOnce(shortPage);
    vi.useFakeTimers();
    try {
      renderSection({
        read: readOk(mockupTranscript({ cursor: "page1", complete: false })),
        status: "live",
      });
      const [source] = instances;
      if (source === undefined) throw new Error("no EventSource opened");
      source.onmessage?.(new MessageEvent("message", { data: "{}" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(750);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      expect(readTranscriptPage.mock.calls.map((call) => call[5])).toEqual([
        "page1",
        "page2",
        "page3",
      ]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("live access changes", () => {
  it("names the required access instead of suggesting transport recovery, and stops calling the run live", () => {
    const sources: EventTarget[] = [];
    class DeniedSource extends EventTarget {
      static readonly CLOSED = 2;
      readyState = 1;
      constructor() {
        super();
        sources.push(this);
      }
      close() {
        this.readyState = DeniedSource.CLOSED;
      }
    }
    vi.stubGlobal("EventSource", DeniedSource);
    try {
      renderSection({
        read: readOk(mockupTranscript({ cursor: "ZjoxMQ", complete: false })),
        status: "live",
      });
      act(() => {
        sources[0]?.dispatchEvent(
          new MessageEvent("error", {
            data: JSON.stringify({ code: "authz_denied" }),
          }),
        );
      });
      expect(screen.getByTestId("transcript-count")).toHaveTextContent(
        "Ask a workspace Owner or organization Admin",
      );
      expect(screen.getByTestId("transcript-count")).not.toHaveTextContent(
        "connection",
      );
      expect(screen.getByTestId("transcript-more")).toBeDisabled();
      expect(screen.getByTestId("tx-runbar")).not.toHaveTextContent("live");
      fireEvent.click(screen.getByRole("button", { name: "Rewind" }));
      fireEvent.click(screen.getByRole("button", { name: "To the end" }));
      expect(sources).toHaveLength(1);
      expect(screen.getByTestId("transcript-count")).toHaveTextContent(
        "Ask a workspace Owner",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a run with no frames", () => {
  it("says the run has none yet", () => {
    renderSection({ read: readOk(runTranscript({ entries: [] })) });
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "no recorded frames yet",
    );
  });

  it("names its own failure when the transcript read is refused (negative)", () => {
    renderSection({ read: readError("frame_store_unreachable", 502) });
    expect(
      screen.getByRole("region", { name: "Transcript" }),
    ).toHaveTextContent(/could not be loaded|frame_store_unreachable/);
  });

  it("says a run whose frames carry nothing to read has no rows, rather than draw an empty feed", () => {
    renderSection({
      read: readOk(
        runTranscript({
          entries: [
            transcriptEntry({ request: null, response: null, cost: null }),
          ],
        }),
      ),
    });
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "No frame of this run carries words to read.",
    );
    expect(screen.getByTestId("chip-all")).toBeInTheDocument();
  });

  it("still opens the live stream while a live run has no frames, so the first can fill the tab", () => {
    const instances = fakeEventSource(0);
    try {
      renderSection({
        read: readOk(runTranscript({ entries: [] })),
        status: "live",
      });
      expect(screen.getByTestId("transcript-empty")).toBeInTheDocument();
      expect(instances).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not open a stream for an empty sealed run (negative)", () => {
    class FakeEventSource {
      constructor() {
        throw new Error("EventSource must not open for a sealed empty tab");
      }
      close(): void {}
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    try {
      renderSection({
        read: readOk(runTranscript({ entries: [] })),
        status: "sealed",
      });
      expect(screen.getByTestId("transcript-empty")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows the access refusal on an empty live run", () => {
    const sources: EventTarget[] = [];
    class Source extends EventTarget {
      static readonly CLOSED = 2;
      readyState = 1;
      constructor() {
        super();
        sources.push(this);
      }
      close() {
        this.readyState = Source.CLOSED;
      }
    }
    vi.stubGlobal("EventSource", Source);
    try {
      renderSection({
        read: readOk(runTranscript({ entries: [] })),
        status: "live",
      });
      act(() => {
        sources[0]?.dispatchEvent(
          new MessageEvent("error", {
            data: JSON.stringify({ code: "forbidden" }),
          }),
        );
      });
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Ask a workspace Owner or organization Admin",
      );
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a body the recorder kept whole", () => {
  it("reads a one-line model reply as the agent's words", () => {
    renderSection({
      read: readOk(
        runTranscript({
          entries: [
            transcriptEntry({
              request: null,
              response: transcriptBody({ text: "cutting it now" }),
            }),
          ],
        }),
      ),
    });
    expect(screen.getByTestId("transcript-agent")).toHaveTextContent(
      "cutting it now",
    );
  });
});
