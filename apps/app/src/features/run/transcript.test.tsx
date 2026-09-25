// @vitest-environment jsdom
// The Transcript tab (mockup `transcriptTab`; pages/run.md, Transcript): the
// header line and its burn meter, the kind chips and what each filters, the
// rows the record reads as, the search, the transport, paging past the
// cursor and following a live run's head.
//
// The page reads the run at `steps`, folded on the server (ADR-182), and the
// fixtures are written in the contract's shape and read through the port's
// mapper (`transcript.builders.ts`). The chips and the transport are the
// viewer's own state over the rows drawn, so what they prove is which rows
// are on screen; each chip's count is the server's. The search goes to the
// server. The paging is proved by what survives it: an appended page leaves
// every row already on screen where it was, and a refused cursor says so
// rather than emptying the view.
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
import { TRANSCRIPT_ENTRY_DEFAULT, RunTranscript } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { readError, readOk } from "@/data/read";
import type { ActionResult } from "@/server/kernel";
import { expectNoAxe } from "@/test/expect-no-axe";
import { toRunTranscript } from "@/data/live/mappers/run";
import { IntlProvider } from "@/test/intl";
import {
  mockupTranscript,
  runRow,
  runTranscript,
  transcriptBody,
  transcriptEntry,
} from "./run.builders";
import type { KindFilter } from "./tab-props";
import {
  releaseCounts,
  releaseSteps,
  releaseTranscript,
  type StepSpec,
  stepsOf,
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
  kinds?: KindFilter;
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
  window.getSelection()?.removeAllRanges();
  readTranscriptPage.mockReset();
  refresh.mockReset();
});

const rows = () => screen.queryAllByTestId("tx-row");
const kinds = () => rows().map((row) => row.getAttribute("data-kind"));
const readout = () => screen.getByTestId("transport-readout");
/** The tool name a row prints for itself, not one of a nested subagent row. */
function ownToolName(row: HTMLElement): string | null {
  const name = Array.from(
    row.querySelectorAll('[data-testid="tx-tool-name"]'),
  ).find((found) => found.closest('[data-testid="tx-row"]') === row);
  return name?.textContent ?? null;
}
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
      "a-intel.core.release-manager · claude-opus-5 · 7 turns · 41 steps · 13 entries",
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
        stepsOf(
          releaseSteps().map((spec) => {
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
  it("draws the design's seven chips with the server's count for each, all pressed", () => {
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
    // The counts are the server's over the whole run, not the rows drawn.
    expect(rows()).toHaveLength(20);
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
        stepsOf(
          releaseSteps().map((spec) =>
            spec.seq === 12
              ? { ...spec, kinds: ["tools"], outcome: "ok", label: "Bash ok" }
              : spec,
          ),
          { counts: { ...releaseCounts(), errors: 0 } },
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

  it("counts the run's stop under seal, and draws it as the seal", () => {
    const counts = releaseCounts();
    renderSection({
      read: readOk(
        stepsOf(
          [
            ...releaseSteps(),
            {
              seq: 18,
              t: 120,
              type: "agent_stop",
              kind: "frame",
              node: "seal",
              label: "agent_stop completed",
              turn: null,
              kinds: ["seal"],
            },
          ],
          { counts: { ...counts, kinds: { ...counts.kinds, seal: 1 } } },
        ),
      ),
    });
    expect(screen.getByTestId("chip-seal")).toHaveTextContent("seal1");
    expect(kinds().at(-1)).toBe("seal");
    // The run is sealed, so its last stop reads as the seal and its instant.
    expect(rows().at(-1)).toHaveTextContent("sealed 08:55:00");
  });

  it("opens every chip off from a link that says none", () => {
    renderSection({ kinds: "none" });
    const chips = within(
      screen.getByRole("group", { name: "Filter the transcript" }),
    );
    expect(chips.queryAllByRole("button", { pressed: true })).toEqual([]);
    expect(rows()).toHaveLength(0);
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "Nothing to show with these filters.",
    );
    expect(screen.getByTestId("chip-all")).toHaveTextContent("all");
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
  it("opens on the operator's first prompt on one line, and names the task once it opens", () => {
    renderSection();
    const [first] = rows();
    expect(first).toHaveAttribute("data-kind", "prompt");
    const you = screen.getByTestId("transcript-you");
    expect(you).toHaveTextContent(/^You⏵Cut the 4\.11\.0 release notes/);
    expect(you).not.toHaveTextContent("first prompt");
    fireEvent.click(within(you).getByRole("button", { name: "Show in full" }));
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

  it("draws a closed call as its one line, with nothing of the call or its output under it (negative)", () => {
    renderSection();
    const list = toolRow("github__list_pull_requests");
    expect(within(list).queryByTestId("tx-call-fold")).toBeNull();
    expect(within(list).queryByTestId("tx-out")).toBeNull();
    expect(
      within(list).queryByRole("button", { name: /more line/ }),
    ).toBeNull();
    expect(
      within(list).getByRole("button", { name: "Show the call" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("opens a call from a click on its line, and not from a click that ends a selection", () => {
    renderSection();
    const list = toolRow("github__list_pull_requests");
    const line = within(list).getByTestId("tx-call-line");
    // The reader selects the line's text to copy it.
    const range = document.createRange();
    range.selectNodeContents(line);
    window.getSelection()?.addRange(range);
    fireEvent.click(line);
    expect(within(list).queryByTestId("tx-call-fold")).toBeNull();
    window.getSelection()?.removeAllRanges();
    fireEvent.click(line);
    expect(within(list).getByTestId("tx-call-fold")).toBeTruthy();
    expect(
      within(list).getByRole("button", { name: "Hide the call" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("reads a new file as the diff it is, and marks a failed call and its output", () => {
    renderSection();
    const write = toolRow("Write");
    expect(write).toHaveTextContent("+13 −0");
    expect(within(write).queryByTestId("tx-diff")).toBeNull();
    fireEvent.click(
      within(write).getByRole("button", { name: "Show the call" }),
    );
    expect(within(write).getByTestId("tx-diff")).toHaveTextContent("new file");
    // The diff is the whole of what the edit did, so its "File created"
    // output does not repeat it.
    expect(within(write).queryByTestId("tx-out")).toBeNull();
    const bash = toolRow("Bash");
    expect(bash).toHaveTextContent("✗");
    fireEvent.click(
      within(bash).getByRole("button", { name: "Show the call" }),
    );
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
    expect(release).not.toHaveTextContent(/\d ms/);
    expect(release).not.toHaveTextContent(
      "Held at Oxagen until someone answers.",
    );
    fireEvent.click(
      within(release).getByRole("button", { name: "Show the call" }),
    );
    expect(release).toHaveTextContent("Held at Oxagen until someone answers.");
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

  it("reads the recall as its heading, and lists what was recalled once it opens", () => {
    renderSection();
    const recall = screen.getByTestId("tx-recall");
    expect(recall).toHaveTextContent("◉ recall · 6 frames · 11,204 tok");
    expect(recall).not.toHaveTextContent("RELEASING.md");
    expect(within(recall).queryByTestId("tx-recall-items")).toBeNull();
    fireEvent.click(
      within(recall).getByRole("button", { name: "Show what was recalled" }),
    );
    expect(within(recall).getByTestId("tx-recall-items")).toHaveTextContent(
      "RELEASING.md",
    );
    expect(
      within(recall).getByRole("link", { name: "open the Context tab" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=context",
    );
  });

  it("lists only the items that reached the model when the server says a manifest cut some (negative)", () => {
    const base = releaseTranscript();
    const entries = base.entries.map((entry) => {
      const recall = entry.recall;
      if (recall === null) return entry;
      const [first, second] = recall.items;
      if (first === undefined || second === undefined) return entry;
      return {
        ...entry,
        recall: {
          ...recall,
          unit: "items" as const,
          count: 1,
          cut: 1,
          items: [
            first,
            { ...second, outcome: "cut" as const, reason: "budget" },
          ],
        },
      };
    });
    renderSection({ read: readOk({ ...base, entries }) });
    const recall = screen.getByTestId("tx-recall");
    expect(recall).toHaveTextContent("1 cut");
    fireEvent.click(
      within(recall).getByRole("button", { name: "Show what was recalled" }),
    );
    const items = within(recall).getByTestId("tx-recall-items");
    expect(items).toHaveTextContent("Repository a-intel/platform @ a4c91e2");
    expect(items).not.toHaveTextContent("CHANGELOG.md");
  });

  it("reads the agent's last words as the answer once the run has stopped, and not while it runs", () => {
    renderSection();
    const agents = screen.getAllByTestId("transcript-agent");
    // The catalogue says the role in sentence case; the tag's style sets it
    // in capitals (#3375).
    expect(agents.at(-1)?.querySelector("span")?.className).toContain(
      "uppercase",
    );
    expect(agents.at(-1)).toHaveTextContent(/^Answer/);
    expect(agents[0]).toHaveTextContent(/^Agent/);
    cleanup();
    renderSection({ status: "live" });
    expect(screen.getAllByTestId("transcript-agent").at(-1)).toHaveTextContent(
      /^Agent/,
    );
  });

  it("draws the model's words on one line until asked, then as they were written", () => {
    renderSection({
      read: readOk(
        stepsOf(
          releaseSteps().map((spec) =>
            spec.seq === 8
              ? {
                  ...spec,
                  response: {
                    seq: 8,
                    type: "model.response",
                    blocks: [
                      {
                        kind: "text" as const,
                        text: "31 merged in range.\n\nReading CHANGELOG.md for the heading order.",
                      },
                    ],
                  },
                }
              : spec,
          ),
        ),
      ),
    });
    const second = screen.getAllByTestId("transcript-agent")[1];
    if (second === undefined) throw new Error("expected the agent's words");
    expect(second.textContent).toContain(
      "31 merged in range. Reading CHANGELOG.md",
    );
    const fold = within(second).getByRole("button", { name: "Show in full" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(fold);
    expect(second.textContent).toContain(
      "31 merged in range.\n\nReading CHANGELOG.md",
    );
    expect(
      within(second).getByRole("button", { name: "Show less" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("opens every thought with expand thinking, and closes them again", () => {
    renderSection({
      read: readOk(
        stepsOf(
          releaseSteps().map((spec) =>
            spec.seq === 3
              ? {
                  ...spec,
                  response: {
                    seq: 4,
                    type: "model.response",
                    blocks: [
                      {
                        kind: "thinking" as const,
                        text: "First thought.\nSecond thought.",
                      },
                    ],
                  },
                }
              : spec,
          ),
        ),
      ),
    });
    // The first thought, re-read each time: it is a span on one line while
    // closed and a block of every line once open.
    const thought = () => screen.getAllByTestId("tx-think")[0];
    expect(thought()?.tagName).toBe("SPAN");
    expect(thought()?.textContent).toBe("First thought. Second thought.");
    fireEvent.click(screen.getByRole("button", { name: "expand thinking" }));
    expect(thought()?.tagName).toBe("DIV");
    expect(thought()?.textContent).toBe("First thought.\nSecond thought.");
    fireEvent.click(screen.getByRole("button", { name: "collapse thinking" }));
    expect(thought()?.tagName).toBe("SPAN");
    // Its own fold opens the one thought.
    fireEvent.click(screen.getByRole("button", { name: "thinking · 2 lines" }));
    expect(thought()?.tagName).toBe("DIV");
  });

  it("reads each row's clock in the viewer's zone and names its place in the run", () => {
    renderSection();
    // The first call's row, at the step's opening frame.
    const time = rows()[5]?.querySelector("time");
    expect(time?.textContent).toBe("08:00:07.8");
    expect(time?.getAttribute("dateTime")).toBe("2026-09-15T08:00:07.800Z");
    expect(time?.getAttribute("title")).toBe("+7.8 s from the run's start");
  });

  it("marks a subagent's row and links no frame of its chain (negative: the run's own frame still links)", () => {
    const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c1";
    const grep = (seq: number, t: number, body: string): StepSpec => ({
      seq,
      t,
      type: "tool_call",
      kind: "tool_call",
      node: "tool",
      label: "Grep ok",
      turn: 1,
      subject: "Grep",
      family: "search",
      outcome: "ok",
      response: { seq, type: "tool_call", text: body },
    });
    const specs: StepSpec[] = [
      {
        ...grep(3, 1, '{"input":{"pattern":"flaky"},"output":"a.test.ts"}'),
        subagent: { sessionUuid: CHAIN, type: "Explore" },
        response: {
          seq: 3,
          type: "tool_call",
          sessionUuid: CHAIN,
          text: '{"input":{"pattern":"flaky"},"output":"a.test.ts"}',
        },
      },
      grep(4, 2, '{"input":{"pattern":"retry"},"output":"b.test.ts"}'),
    ];
    renderSection({ read: readOk(stepsOf(specs)) });
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

  it("shows a step's result as its output and its request as the call, never one for the other (#3375)", () => {
    renderSection({
      read: readOk(
        stepsOf([
          {
            seq: 1,
            endSeq: 2,
            t: 0,
            type: "tool.engine_call_started",
            kind: "tool_call",
            node: "tool",
            turn: 1,
            subject: "run_lint",
            family: "shell",
            outcome: "ok",
            request: {
              seq: 1,
              type: "tool.engine_call_started",
              text: JSON.stringify({ command: "pnpm lint" }),
            },
            response: {
              seq: 2,
              type: "tool.engine_call_completed",
              text: JSON.stringify({ output: "0 problems" }),
            },
          },
        ]),
      ),
    });
    const lint = toolRow("run_lint");
    expect(within(lint).getByTestId("tx-tool-arg")).toHaveTextContent(
      "pnpm lint",
    );
    fireEvent.click(
      within(lint).getByRole("button", { name: "Show the call" }),
    );
    expect(within(lint).getByTestId("tx-args")).toHaveTextContent("pnpm lint");
    expect(within(lint).getByTestId("tx-args")).not.toHaveTextContent(
      "0 problems",
    );
    expect(within(lint).getByTestId("tx-out")).toHaveTextContent("0 problems");
    expect(within(lint).getByTestId("tx-out")).not.toHaveTextContent(
      "pnpm lint",
    );
  });

  it("reads a call with no result as running only while the run is live, never on a halted run (#3375)", () => {
    const open: StepSpec = {
      seq: 1,
      t: 0,
      type: "tool.engine_call_started",
      kind: "tool_call",
      node: "tool",
      turn: 1,
      subject: "run_lint",
      family: "shell",
      outcome: "pending",
      request: {
        seq: 1,
        type: "tool.engine_call_started",
        text: JSON.stringify({ command: "pnpm lint" }),
      },
    };
    renderSection({ read: readOk(stepsOf([open])), status: "live" });
    expect(toolRow("run_lint")).toHaveTextContent("running…");
    cleanup();
    renderSection({ read: readOk(stepsOf([open])), status: "halted" });
    const lint = toolRow("run_lint");
    expect(lint).toHaveTextContent("no result recorded");
    expect(lint).not.toHaveTextContent("running");
  });

  it("says a body was cut at the ceiling inside the call's fold", () => {
    renderSection({
      read: readOk(
        stepsOf(
          releaseSteps().map((spec) =>
            spec.seq === 9 && spec.response !== undefined
              ? { ...spec, response: { ...spec.response, truncated: true } }
              : spec,
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
        name: "Show what was recalled",
      }),
    );
    await expectNoAxe(container);
  });
});

describe("event rows", () => {
  /**
   * One turn holding three entries that are neither a call nor a reply, as
   * the server states them: a decision recorded on no call, a notice with
   * two lines of text, and a hook the recorder filed under errors with
   * nothing to read.
   */
  const EVENTS: StepSpec[] = [
    {
      seq: 1,
      t: 0,
      type: "turn_start",
      kind: "frame",
      node: "prompt",
      turn: 1,
      request: { seq: 1, type: "turn_start", text: "Cut the release." },
    },
    {
      seq: 2,
      t: 1,
      type: "policy_decision",
      kind: "policy",
      node: "policy",
      label: "deny Bash",
      subject: "Bash",
      outcome: "denied",
      gates: [{ seq: 2, decision: "deny", type: "policy_decision" }],
      turn: 1,
    },
    {
      seq: 3,
      t: 2,
      type: "notification",
      kind: "frame",
      node: "event",
      turn: 1,
      response: {
        seq: 3,
        type: "notification",
        text: "Build finished\nall 42 tests passed",
      },
    },
    {
      seq: 4,
      t: 3,
      type: "hook_error",
      kind: "frame",
      node: "event",
      turn: 1,
      kinds: ["errors"],
      outcome: "failed",
    },
  ];
  const events = () =>
    rows().filter((row) => row.getAttribute("data-kind") === "event");

  it("names a decision on no recorded call by the call the server names, marks a denial failed, and links the decision, not the frame", () => {
    renderSection({ read: readOk(stepsOf(EVENTS)) });
    expect(events()).toHaveLength(3);
    const [decision] = events();
    if (decision === undefined) throw new Error("a decision row");
    expect(decision).toHaveTextContent("✗");
    expect(within(decision).getByText("Bash")).toBeTruthy();
    expect(
      within(decision).getByRole("link", { name: "deny · fr 2" }),
    ).toBeTruthy();
    expect(within(decision).queryByText("policy_decision · fr 2")).toBeNull();
  });

  it("shows an event's text on one line, opens it as written, then folds it again", () => {
    renderSection({ read: readOk(stepsOf(EVENTS)) });
    const [, notice] = events();
    if (notice === undefined) throw new Error("a notice row");
    expect(notice).toHaveTextContent("●");
    expect(within(notice).getByText("notification")).toBeTruthy();
    expect(within(notice).getByTestId("tx-event-line")).toHaveAttribute(
      "title",
      "Build finished all 42 tests passed",
    );
    expect(notice.querySelector("pre")).toBeNull();
    const fold = within(notice).getByRole("button", { name: "Show in full" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(fold);
    expect(notice.querySelector("pre")?.textContent).toBe(
      "Build finished\nall 42 tests passed",
    );
    fireEvent.click(within(notice).getByRole("button", { name: "Show less" }));
    expect(notice.querySelector("pre")).toBeNull();
    expect(
      within(notice).getByRole("link", { name: "notification · fr 3" }),
    ).toBeTruthy();
  });

  it("draws an event filed under errors as failed even with no text, and offers nothing to fold (negative)", () => {
    renderSection({ read: readOk(stepsOf(EVENTS)) });
    const [, , hook] = events();
    if (hook === undefined) throw new Error("a hook row");
    expect(hook).toHaveTextContent("✗");
    expect(within(hook).getByText("hook_error")).toBeTruthy();
    expect(within(hook).queryByRole("button")).toBeNull();
    expect(
      within(hook).getByRole("link", { name: "hook_error · fr 4" }),
    ).toBeTruthy();
  });
});

/** Types `value` into the search field. */
function search(value: string) {
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search the transcript" }),
    { target: { value } },
  );
}

/**
 * The server's answer to a search: the release run's entries that hold the
 * query, each naming where, and what it found across the run.
 */
function found(
  query: string,
  seqs: readonly number[],
  unsearched = 0,
): ActionResult<RunTranscript> {
  return pageOk(
    stepsOf(
      releaseSteps()
        .filter((spec) => seqs.includes(spec.seq))
        .map((spec) => ({ ...spec, matches: ["response" as const] })),
      {
        counts: releaseCounts(),
        search: { query, matched: seqs.length, unsearched },
      },
    ),
  );
}

describe("the search", () => {
  it("sends the query to the server once the reader stops typing, and reads the whole bodies", async () => {
    readTranscriptPage.mockResolvedValue(found("changelog", [8, 9]));
    renderSection();
    search("change");
    search("changelog");
    await waitFor(() => {
      expect(screen.getByTestId("tx-matches")).toHaveTextContent(
        "2 of 13 entries",
      );
    });
    // One read for the words the reader stopped on, not one per keystroke.
    expect(readTranscriptPage).toHaveBeenCalledTimes(1);
    expect(readTranscriptPage).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "tse_7k2m9q",
      "steps",
      { text: "full", query: "changelog" },
    );
  });

  it("draws only the entries the server matched, opens each, and marks the words", async () => {
    readTranscriptPage.mockResolvedValue(found("changelog", [8, 9]));
    renderSection();
    search("changelog");
    await waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    // The Read call's row opens, so the match inside its output shows.
    expect(within(toolRow("Read")).getByTestId("tx-call-fold")).toBeTruthy();
    expect(
      screen.getAllByText(/changelog/i, { selector: "mark" }).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByTestId("transport-readout")).toBeNull();
    expect(screen.getByText("Search shows every match at once.")).toBeTruthy();
  });

  it("says how many bodies the search could not look inside", async () => {
    readTranscriptPage.mockResolvedValue(found("changelog", [9], 3));
    renderSection();
    search("changelog");
    await waitFor(() => {
      expect(screen.getByTestId("tx-unsearched")).toHaveTextContent(
        "3 bodies were not searched",
      );
    });
  });

  it("says nothing matches rather than showing an empty feed (negative)", async () => {
    readTranscriptPage.mockResolvedValue(found("no such words", []));
    renderSection();
    search("no such words");
    await waitFor(() => {
      expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
        "Nothing matches this search.",
      );
    });
  });

  it("says a search that did not run failed, and keeps the run's rows (negative)", async () => {
    readTranscriptPage.mockResolvedValue(pageFailed("frame_store_unreachable"));
    renderSection();
    search("changelog");
    await waitFor(() => {
      expect(screen.getByTestId("tx-matches")).toHaveTextContent(
        "The search did not run.",
      );
    });
    expect(rows()).toHaveLength(20);
  });

  it("reads nothing for a field of nothing but space, and draws the run again when it is cleared (negative)", async () => {
    readTranscriptPage.mockResolvedValue(found("changelog", [9]));
    renderSection();
    search("   ");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readTranscriptPage).not.toHaveBeenCalled();
    search("changelog");
    await waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
    search("");
    expect(rows()).toHaveLength(20);
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
      // 0.1 s to the first model step's thought, divided by six.
      act(() => {
        vi.advanceTimersByTime(17);
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
  /**
   * The run's tail: the approval answered and the release made. The server
   * sends the release call's step again, grown by its answer and its result.
   */
  const release = releaseSteps().at(-1);
  if (release === undefined) throw new Error("the release call");
  const tailPage = stepsOf([
    {
      ...release,
      endSeq: 19,
      frames: 4,
      outcome: "ok",
      durationMs: 13_900,
      gates: [
        ...(release.gates ?? []),
        { seq: 18, decision: "approve", type: "approval_decision" },
      ],
      response: {
        seq: 19,
        type: "tool_call",
        text: '{"input":{"tag_name":"v4.11.0"},"output":"draft created"}',
      },
    },
  ]);

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
    // The chips show and hide rows already read, so the page is read whole,
    // at the zoom and with the bodies the page read.
    expect(readTranscriptPage).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "tse_7k2m9q",
      "steps",
      { after: "ZjoxMQ", text: "full" },
    );
    // The release call is now one row carrying the answer that landed with the
    // appended page.
    const release = toolRow("github__create_release");
    expect(release).toHaveTextContent("approve \u00b7 fr 18");
    expect(
      rows()
        .slice(0, -1)
        .map((row) => row.textContent),
    ).toEqual(before.slice(0, -1));
    // A row leads on one line, so the result the page carried is behind the
    // call's fold rather than in the row's own text.
    fireEvent.click(
      within(release).getByRole("button", { name: "Show the call" }),
    );
    expect(within(release).getByTestId("tx-out")).toHaveTextContent(
      "draft created",
    );
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
      expect(
        readTranscriptPage.mock.calls.map((call) => call[4].after),
      ).toEqual(["page1", "page2", "page3"]);
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

describe("a call the in-app assistant parked", () => {
  /**
   * An assistant turn's one tool call, as the server folds it: the request
   * and its receipt in one step, with the outcome and the approval the
   * receipt named stated on the entry.
   */
  const assistantCall = (outcome: "parked" | "denied", approvalId?: string) =>
    stepsOf([
      {
        seq: 3,
        endSeq: 4,
        t: 1,
        type: "tool.engine_call_started",
        kind: "tool_call",
        node: "tool",
        label: "create_workspace",
        turn: 1,
        callId: "tool-1-0",
        subject: "create_workspace",
        family: "tool",
        outcome,
        ...(approvalId === undefined ? {} : { approvalId }),
        kinds: outcome === "denied" ? ["tools", "errors"] : ["tools"],
        request: {
          seq: 3,
          type: "tool.engine_call_started",
          text: '{"name":"ops"}',
        },
        response: {
          seq: 4,
          type: "tool.engine_call_completed",
          text: '"refused: create_workspace is waiting for approval"',
        },
      },
    ]);

  it("shows the call as parked, links its receipt, and names the approval it waits on", async () => {
    const { container } = renderSection({
      read: readOk(assistantCall("parked", "apr_0a1b2c3d4e5f6g7h8j9k0m")),
    });
    const call = toolRow("create_workspace");
    // Waiting on a person is not a failure.
    expect(call).not.toHaveTextContent("✗");
    expect(
      within(call).getByRole("link", { name: "parked · fr 4" }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=4",
    );
    // The note and the approval id sit in the call's fold, with its output.
    fireEvent.click(
      within(call).getByRole("button", { name: "Show the call" }),
    );
    expect(call).toHaveTextContent("Held at Oxagen until someone answers.");
    expect(within(call).getByTestId("tx-parked-approval")).toHaveTextContent(
      "Approval apr_0a1b2c3d4e5f6g7h8j9k0m",
    );
    await expectNoAxe(container);
  });

  it("still shows a denied call as refused, with no approval (negative)", () => {
    renderSection({ read: readOk(assistantCall("denied")) });
    const call = toolRow("create_workspace");
    expect(call).toHaveTextContent("✗");
    expect(within(call).queryByRole("link", { name: /parked/ })).toBeNull();
    fireEvent.click(
      within(call).getByRole("button", { name: "Show the call" }),
    );
    expect(call).not.toHaveTextContent("Held at Oxagen until someone answers.");
    expect(within(call).queryByTestId("tx-parked-approval")).toBeNull();
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

// ── Carried from #4026 ──────────────────────────────────────────────────────
//
// #4026 changed how a wrapped Claude Code session reads on the Transcript tab,
// and tested it against the turn-and-step view this page replaced with the
// rev1 feed. The tests below state the same behaviour on the feed: where #4026
// asserted a step number, a zoom or a chip link, the feed's equivalent is a
// nested row, the transport's count, or the chip's own pressed state.

describe("a subagent's steps under its Task call", () => {
  // The shape of a wrapped Claude Code run as the server folds it: the gate,
  // the harness check and the receipt of one call are one step, and the
  // subagent's own calls, on its chain and numbered from 0, name the Task
  // call's step as their parent.
  const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c3";
  const onChain = { sessionUuid: CHAIN, type: "Explore" };
  const call = (
    seq: number,
    endSeq: number,
    subject: string,
    family: StepSpec["family"],
    target: string | undefined,
    over: Partial<StepSpec> = {},
  ): StepSpec => ({
    seq,
    endSeq,
    t: seq,
    type: "policy_decision",
    kind: "tool_call",
    node: "tool",
    label: `allow ${subject}`,
    turn: 1,
    subject,
    family,
    outcome: "ok",
    ...(target === undefined ? {} : { target }),
    gates: [{ seq, decision: "allow", type: "policy_decision" }],
    kinds: ["tools", "policy"],
    response: {
      seq: endSeq,
      type: "tool_call",
      fidelity: "digest_only",
    },
    ...over,
  });
  const prompt = (text: string): StepSpec => ({
    seq: 1,
    t: 0,
    type: "turn_start",
    kind: "frame",
    node: "prompt",
    turn: 1,
    request: { seq: 1, type: "turn_start", text },
  });
  const steps: StepSpec[] = [
    prompt("Find the flaky test."),
    call(2, 4, "Bash", "shell", "git status"),
    call(5, 8, "Task", "agent", undefined),
    call(0, 1, "Grep", "search", "flaky", {
      subagent: onChain,
      parentKey: "5",
      gates: [
        {
          seq: 0,
          decision: "allow",
          type: "policy_decision",
          sessionUuid: CHAIN,
        },
      ],
      response: {
        seq: 1,
        type: "tool_call",
        fidelity: "digest_only",
        sessionUuid: CHAIN,
      },
    }),
    call(2, 3, "Read", "read", "apps/app/src/flaky.test.ts", {
      subagent: onChain,
      parentKey: "5",
      gates: [
        {
          seq: 2,
          decision: "allow",
          type: "policy_decision",
          sessionUuid: CHAIN,
        },
      ],
      response: {
        seq: 3,
        type: "tool_call",
        fidelity: "digest_only",
        sessionUuid: CHAIN,
      },
    }),
    call(9, 11, "Bash", "shell", "git diff"),
  ];

  it("draws the subagent's calls inside the Task row, with no gap in the run's count", () => {
    renderSection({ read: readOk(stepsOf(steps)) });
    const nested = screen.getByTestId("transcript-subagent-steps");
    const task = nested.closest('[data-testid="tx-row"]');
    if (!(task instanceof HTMLElement))
      throw new Error("expected the Task row");
    expect(within(task).getAllByTestId("tx-tool-name")[0]).toHaveTextContent(
      "Task",
    );
    const inner = within(nested).getAllByTestId("tx-row");
    expect(inner.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Grep"),
      expect.stringContaining("Read"),
    ]);
    expect(inner[0]).toHaveTextContent("flaky");
    // One row per call, as the server folded it. The transport counts the
    // rows drawn with no gap: the prompt, the two Bash calls, the Task call
    // and the subagent's two calls under it. (#4026 numbered steps 1, 2,
    // 2.1, 2.2, 3; the feed has no step numbers.)
    expect(rows()).toHaveLength(6);
    expect(readout()).toHaveTextContent("6 / 6");
    expect(
      rows().flatMap((row) => {
        const name = row.querySelector('[data-testid="tx-tool-name"]');
        return name === null ? [] : [name.textContent];
      }),
    ).toEqual(["Bash", "Task", "Grep", "Read", "Bash"]);
  });

  it("replaces an entry a live read sends again rather than drawing it twice (#4048)", async () => {
    const instances = fakeEventSource(1);
    // The view holds the run through the subagent's first call. The next read
    // sends the turn's opening entry again, as it stands now, with what came
    // after.
    const held = stepsOf(steps.slice(0, 4), { cursor: "c1", complete: false });
    const again = prompt("Find the flaky test and quarantine nothing.");
    readTranscriptPage.mockResolvedValueOnce(
      pageOk(
        stepsOf([again, ...steps.slice(4)], { cursor: "c2", complete: false }),
      ),
    );
    vi.useFakeTimers();
    try {
      renderSection({ read: readOk(held), status: "live" });
      const [source] = instances;
      if (source === undefined) throw new Error("no EventSource opened");
      source.onmessage?.(new MessageEvent("message", { data: "{}" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(750);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      expect(readTranscriptPage.mock.calls.map((c) => c[4].after)).toEqual([
        "c1",
      ]);
      // The same six rows as the whole run read at once, the prompt once and
      // as the later read has it.
      expect(rows()).toHaveLength(6);
      const prompts = rows().filter((row) =>
        row.textContent.includes("Find the flaky test"),
      );
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toHaveTextContent("quarantine nothing");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("the effort a model call ran at", () => {
  it("maps the server's effort, and reads a missing one as unrecorded (negative)", () => {
    const first = runTranscript({ entries: [transcriptEntry()] }).entries[0];
    if (!first) throw new Error("Missing transcript fixture entry");
    const { subagent: _appSubagent, ...entry } = first;
    const wire = (seq: string, effort?: string | null) => ({
      ...entry,
      seq,
      endSeq: seq,
      callId: null,
      cost: null,
      cumulativeCost: null,
      request: null,
      response: null,
      ...(effort === undefined ? {} : { effort }),
    });
    const mapped = RunTranscript.parse(
      toRunTranscript({
        zoom: "steps",
        kinds: [],
        cursor: null,
        complete: true,
        entries: [wire("5", "high"), wire("6", null), wire("7")],
      }),
    );
    expect(mapped.entries.map((e) => e.effort)).toEqual(["high", null, null]);
  });
});

describe("thinking and effort on a model step", () => {
  const usage = {
    inputUncached: 10,
    cacheRead: 0,
    cacheWrite: 0,
    output: 5,
    reasoning: 42,
  };
  /** A model call that thought, then a tool call after it. */
  const thought = (withBlocks: boolean) =>
    readOk(
      runTranscript({
        entries: [
          transcriptEntry({
            seq: "1",
            endSeq: "1",
            frames: 1,
            kind: "model_call",
            type: "llm_call",
            label: "anthropic/claude-fable-5-1",
            kinds: ["responses", "thinking", "usage"],
            effort: "high",
            usage,
            response: transcriptBody({
              seq: "1",
              type: "llm_call",
              text: "Tagging now.",
              blocks: withBlocks
                ? [
                    { kind: "thinking", text: "Check the tag is free first." },
                    { kind: "text", text: "Tagging now." },
                  ]
                : [{ kind: "text", text: "Tagging now." }],
            }),
          }),
          transcriptEntry({
            seq: "2",
            endSeq: "2",
            frames: 1,
            kind: "tool_call",
            type: "tool_call",
            label: "create_tag ok",
            callKey: "call_1",
            node: "tool",
            subject: "create_tag",
            family: "tool",
            kinds: ["tools"],
            response: transcriptBody({
              seq: "2",
              type: "tool_call",
              text: '{"ok":true}',
            }),
          }),
        ],
      }),
    );

  it("names the effort and the thinking tokens on the step", () => {
    renderSection({ read: thought(true) });
    expect(screen.getByTestId("step-effort")).toHaveTextContent("effort high");
    expect(screen.getByTestId("step-thinking-tokens")).toHaveTextContent(
      "42 thinking tokens",
    );
  });

  it("opens every kept thought on expand thinking, and closes them again", () => {
    renderSection({ read: thought(true) });
    const toggle = screen.getByTestId("expand-thinking");
    expect(toggle).toHaveTextContent("expand thinking");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent("collapse thinking");
    expect(screen.getByTestId("tx-think")).toHaveTextContent(
      "Check the tag is free first.",
    );
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveTextContent("expand thinking");
  });

  it("says the harness kept no thought where only the token count was recorded (negative)", () => {
    renderSection({ read: thought(false) });
    expect(screen.queryByTestId("tx-think")).toBeNull();
    expect(screen.getByTestId("step-thinking-unkept")).toHaveTextContent(
      "The model spent 42 tokens thinking.",
    );
  });

  it("draws no effort or thinking chip on a step that recorded neither (negative)", () => {
    renderSection({
      read: readOk(
        stepsOf(
          releaseSteps().map((spec) =>
            spec.usage === undefined
              ? spec
              : { ...spec, usage: { ...spec.usage, reasoning: null } },
          ),
        ),
      ),
    });
    expect(screen.queryByTestId("step-effort")).toBeNull();
    expect(screen.queryByTestId("step-thinking-tokens")).toBeNull();
    expect(screen.queryByTestId("step-thinking-unkept")).toBeNull();
  });
});

describe("searching the transcript", () => {
  it("keeps a found row's place in the run", async () => {
    readTranscriptPage.mockResolvedValue(found("changelog", [9]));
    renderSection();
    const clockOf = () =>
      rows()
        .find((row) => within(row).queryByText("Read") !== null)
        ?.querySelector("time")
        ?.getAttribute("dateTime");
    const before = clockOf();
    expect(before).toBeDefined();
    search("changelog");
    await waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
    expect(clockOf()).toBe(before);
  });
});

describe("the filter chips, as #4026 drew them", () => {
  const chipOrder = () =>
    within(screen.getByTestId("transcript-chips"))
      .getAllByRole("button")
      .map((chip) => chip.getAttribute("data-testid"));

  it("draws the mockup's chips in the mockup's order, then all/none and errors, and no policy or proof chip (negative)", () => {
    renderSection();
    expect(chipOrder()).toEqual([
      "chip-prompt",
      "chip-responses",
      "chip-thinking",
      "chip-tools",
      "chip-usage",
      "chip-recall",
      "chip-seal",
      "chip-all",
      "chip-errors",
    ]);
    expect(screen.queryByTestId("chip-policy")).toBeNull();
    expect(screen.queryByTestId("chip-proof")).toBeNull();
  });

  it("draws every chip on when nothing is filtered, and offers none", () => {
    renderSection();
    for (const chip of ["prompt", "tools", "seal", "thinking"]) {
      expect(screen.getByTestId(`chip-${chip}`)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
    expect(screen.getByTestId("chip-errors")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("chip-all")).toHaveTextContent("none");
  });

  it("turns one chip off and leaves every other chip on", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("chip-tools"));
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    for (const chip of ["prompt", "responses", "thinking", "usage", "recall"]) {
      expect(screen.getByTestId(`chip-${chip}`)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }
    expect(screen.getByTestId("chip-all")).toHaveTextContent("all");
  });

  it("files the tools chip over tools and their gate decisions, and offers all when a chip is off", () => {
    renderSection({ kinds: ["tools", "policy"] });
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("chip-prompt")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // A decision draws as the ⚖ chip on the call it was made about, so the
    // tools chip alone still shows the gate decisions.
    expect(kinds()).toContain("tool");
    expect(kinds()).not.toContain("prompt");
    expect(screen.getAllByText(/⚖/).length).toBeGreaterThan(0);
    const toggle = screen.getByTestId("chip-all");
    expect(toggle).toHaveTextContent("all");
    fireEvent.click(toggle);
    expect(screen.getByTestId("chip-prompt")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("draws every chip off for none, reads no entries, and says how to get the run back", () => {
    renderSection();
    fireEvent.click(screen.getByTestId("chip-all"));
    expect(screen.getByTestId("chip-prompt")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("chip-all")).toHaveTextContent("all");
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "Nothing to show with these filters.",
    );
    expect(rows()).toHaveLength(0);
    // The chips filter the read in hand; none asks the server for nothing.
    expect(readTranscriptPage).not.toHaveBeenCalled();
  });

  it("shows only failed calls behind errors, and back to everything from it", () => {
    renderSection();
    const errors = screen.getByTestId("chip-errors");
    expect(errors).toHaveAttribute("title", "Show only failed calls");
    fireEvent.click(errors);
    expect(errors).toHaveAttribute("aria-pressed", "true");
    expect(rows().length).toBeGreaterThan(0);
    expect(rows()).toHaveLength(1);
    fireEvent.click(errors);
    expect(errors).toHaveAttribute("aria-pressed", "false");
    expect(rows()).toHaveLength(20);
  });

  it("shows the server's count of the whole run on each chip", () => {
    renderSection();
    expect(screen.getByTestId("chip-tools-count")).toHaveTextContent(
      String(kinds().filter((kind) => kind === "tool").length),
    );
    expect(screen.getByTestId("chip-errors-count")).toHaveTextContent("1");
    expect(screen.getByTestId("chip-prompt-count")).toHaveTextContent("1");
    expect(screen.getByTestId("chip-seal-count")).toHaveTextContent("0");
  });

  it("marks a count from a read that stopped short as a floor", () => {
    renderSection({
      read: readOk(releaseTranscript({ complete: false, cursor: "ZjoxMQ" })),
    });
    expect(screen.getByTestId("chip-tools-count")).toHaveTextContent("6+");
  });

  it("draws no counts when the whole-run read failed, rather than zeros (negative)", () => {
    renderSection({ read: readError("frame_store_unreachable", 502) });
    expect(screen.queryByTestId("chip-tools-count")).toBeNull();
  });

  it("names its own failure when the read was refused, since no chip can have caused it (negative)", () => {
    // #4026 kept the chips on a refused read so a filter that narrowed the
    // read could be undone. The page reads the whole run once and the chips
    // show and hide its rows, so no chip narrows the read and a refusal is
    // the read's own.
    renderSection({
      read: readError("frame_store_unreachable", 502),
      kinds: ["policy"],
    });
    expect(screen.queryByTestId("transcript-chips")).toBeNull();
    expect(screen.queryByTestId("transcript")).toBeNull();
  });
});

describe("a read the page makes again", () => {
  const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000d4";
  const tool = (
    seq: number,
    t: number,
    subject: string,
    family: StepSpec["family"],
    body: string,
    over: Partial<StepSpec> = {},
  ): StepSpec => ({
    seq,
    t,
    type: "tool_call",
    kind: "tool_call",
    node: "tool",
    label: `${subject} ok`,
    turn: 1,
    subject,
    family,
    outcome: "ok",
    response: { seq, type: "tool_call", text: body },
    ...over,
  });
  /** A step on the subagent's chain, which the Task call at 2 spawned. */
  const onChain: Partial<StepSpec> = {
    subagent: { sessionUuid: CHAIN, type: "Explore" },
    parentKey: "2",
  };
  /** A run whose subagent, spawned by the Task call at 2, calls Grep. */
  const specs = (late: boolean): StepSpec[] => [
    {
      seq: 1,
      t: 0,
      type: "turn_start",
      kind: "frame",
      node: "prompt",
      turn: 1,
      request: { seq: 1, type: "turn_start", text: "Find the flaky test." },
    },
    tool(
      2,
      1,
      "Task",
      "agent",
      '{"input":{"description":"Search the tests"},"output":"done"}',
    ),
    tool(
      0,
      2,
      "Grep",
      "search",
      '{"input":{"pattern":"flaky"},"output":"a.test.ts"}',
      onChain,
    ),
    // Recorded late: the tail read's cursor had already passed it. The
    // server places it after its call, before entries the reader holds.
    ...(late
      ? [
          tool(
            1,
            5,
            "Read",
            "read",
            '{"input":{"file_path":"a.test.ts"},"output":"it()"}',
            onChain,
          ),
        ]
      : []),
    tool(3, 3, "Bash", "shell", '{"input":{"command":"git diff"},"output":""}'),
  ];
  const view = (read: Read<RunTranscript>, status: RunRow["status"]) => (
    <IntlProvider>
      <TranscriptSection
        read={read}
        run={{
          ...RUN,
          status,
          sealedAt: status === "live" ? null : RUN.sealedAt,
        }}
        kinds={[]}
        {...PLACE}
      />
    </IntlProvider>
  );
  const names = () =>
    rows().flatMap((row) => {
      const name = ownToolName(row);
      return name === null ? [] : [name];
    });

  it("takes the page's new read, so a subagent frame recorded behind the cursor shows under its call once the run seals (#4083)", () => {
    const { rerender } = render(
      view(
        readOk(stepsOf(specs(false), { cursor: "c1", complete: true })),
        "live",
      ),
    );
    expect(names()).toEqual(["Task", "Grep", "Bash"]);
    // The seal refreshes the page, which reads the whole run again.
    rerender(view(readOk(stepsOf(specs(true))), "sealed"));
    expect(names()).toEqual(["Task", "Grep", "Read", "Bash"]);
    const nested = screen.getByTestId("transcript-subagent-steps");
    expect(
      within(nested)
        .getAllByTestId("tx-tool-name")
        .map((name) => name.textContent),
    ).toEqual(["Grep", "Read"]);
    // The new read carried no cursor, so nothing more is offered.
    expect(screen.queryByTestId("transcript-more")).toBeNull();
  });

  it("keeps the rows it holds when the page renders again with the same read (negative)", () => {
    const read = readOk(stepsOf(specs(false)));
    const { rerender } = render(view(read, "sealed"));
    rerender(view(read, "sealed"));
    expect(names()).toEqual(["Task", "Grep", "Bash"]);
  });
});
