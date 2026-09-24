// @vitest-environment jsdom
// What lane 3 added to the Transcript tab: the filter chips, the paging past
// the cursor, and following a live run's head.
//
// The chips are links, so what they prove is a URL and an accessible state,
// not a click handler. The paging is proved by what survives it: an appended
// page must leave every entry already on screen where it was, and a refused
// cursor must say so rather than emptying the view. Lane 2's own transcript
// rendering, its transport and its zoom disclosures are covered by
// transcript-model.test.ts and the Transcript block of run.test.tsx.
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
  RunTranscript,
  type TranscriptEntry,
  type TranscriptKind,
} from "@/data/contracts/run";
import { toRunTranscript } from "@/data/live/mappers/run";
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

/** A page-action refusal the player shows under the transport. */
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
type KindFilter = import("./transcript").KindFilter;

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };
const RUN = runRow();

type SectionView = {
  read?: Read<RunTranscript>;
  tally?: Read<RunTranscript>;
  kinds?: KindFilter;
  zoom?: RunTranscript["zoom"];
  status?: RunRow["status"];
};

function renderSection(view: SectionView = {}) {
  const {
    read = readOk(mockupTranscript()),
    tally,
    kinds = [],
    zoom = "steps",
    status = RUN.status,
  } = view;
  return render(
    <IntlProvider>
      <TranscriptSection
        read={read}
        tally={tally}
        zoom={zoom}
        kinds={kinds}
        run={{ status, replayGrade: RUN.replayGrade }}
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

/** The app's body fixture without the app-only `chainRef`, as the server sends it. */
function serverBody() {
  const { chainRef: _appChainRef, ...body } = transcriptBody();
  return body;
}

describe("assembled model responses", () => {
  it("renders mapped message blocks and keeps the full-frame link for shortened input", () => {
    const block = {
      id: "b0",
      chars: 10,
      tokens: 3,
      partial: false,
      cost: null,
    };
    const page = runTranscript({ entries: [transcriptEntry()] });
    const first = page.entries[0];
    if (!first) throw new Error("Missing transcript fixture entry");
    // The app's entry names its chain as `subagent.chainRef`; the server's
    // names it differently, so the app-only member is left out of the input.
    const { subagent: _appSubagent, ...entry } = first;
    const mapped = RunTranscript.parse(
      toRunTranscript({
        ...page,
        entries: [
          {
            ...entry,
            callId: null,
            cost: null,
            cumulativeCost: null,
            request: null,
            response: {
              ...serverBody(),
              text: null,
              assembly: {
                blocks: [
                  {
                    ...block,
                    kind: "thinking",
                    text: "Inspect the configuration.",
                    seconds: null,
                    truncated: false,
                  },
                  {
                    ...block,
                    id: "b1",
                    kind: "text",
                    text: "The configuration is ready.",
                    truncated: false,
                  },
                  {
                    ...block,
                    id: "b2",
                    kind: "tool_use",
                    name: "Write",
                    input: { content: "…900 characters" },
                    inputRaw: false,
                    inputFolded: true,
                    callKey: "call1",
                    verdict: null,
                  },
                  {
                    ...block,
                    id: "b3",
                    kind: "tool_result",
                    forId: "b2",
                    ok: true,
                    summary: "Saved configuration.",
                    bytes: 900,
                    ms: 2,
                  },
                ],
                precis: "Prepared configuration.",
                stopReason: "end_turn",
                ttftMs: null,
                durationMs: null,
                tokensPerSecond: null,
                usage: {
                  inputTokens: null,
                  outputTokens: null,
                  cacheReadTokens: null,
                  cacheWriteTokens: null,
                },
                partial: false,
                wire: { bytes: 3000, events: 50 },
              },
            },
          },
        ],
      }),
    );
    renderSection({ read: readOk(mapped), zoom: "everything" });
    const half = screen.getByTestId("transcript-half");
    expect(half.textContent).toContain("Inspect the configuration.");
    expect(half.textContent).toContain("The configuration is ready.");
    expect(half.textContent).toContain("Write");
    expect(half.textContent).toContain("…900 characters");
    expect(half.textContent).toContain("Saved configuration.");
    expect(within(half).getByRole("link").getAttribute("href")).toContain(
      "body=",
    );
  });
});

describe("a subagent's frames", () => {
  // A subagent records on a chain of its own, numbered from 0 like the run's.
  // The Frames tab reads the run's chain, so a link by seq from a subagent's
  // frame would open a different frame with the same number.
  it("names the subagent and links no frame of its chain (negative: the run's own frame still links)", () => {
    const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c1";
    const page = runTranscript({ entries: [transcriptEntry()] });
    const first = page.entries[0];
    if (!first) throw new Error("Missing transcript fixture entry");
    // The app's entry names its chain as `subagent.chainRef`; the server's
    // names it differently, so the app-only member is left out of the input.
    const { subagent: _appSubagent, ...entry } = first;
    const server = {
      ...entry,
      callId: null,
      cost: null,
      cumulativeCost: null,
      request: null,
      response: {
        ...serverBody(),
        text: "Looked through the repository.",
        truncated: true,
        assembly: null,
      },
    };
    const mapped = RunTranscript.parse(
      toRunTranscript({
        ...page,
        entries: [
          {
            ...server,
            seq: "3",
            endSeq: "3",
            subagent: { sessionUuid: CHAIN, id: "agent-1", type: "Explore" },
            response: { ...server.response, seq: "3", sessionUuid: CHAIN },
          },
          {
            ...server,
            seq: "4",
            endSeq: "4",
            response: { ...server.response, seq: "4" },
          },
        ],
      }),
    );
    expect(mapped.entries[0]?.subagent).toEqual({
      chainRef: CHAIN,
      type: "Explore",
      spawnKey: null,
    });
    expect(mapped.entries[0]?.response?.chainRef).toBe(CHAIN);
    renderSection({ read: readOk(mapped), zoom: "everything" });
    const [sub, own] = screen.getAllByTestId("transcript-frame");
    if (sub === undefined || own === undefined)
      throw new Error("both frames are drawn");
    expect(within(sub).getByTestId("transcript-subagent")).toHaveTextContent(
      "subagent Explore",
    );
    expect(within(sub).queryAllByRole("link")).toHaveLength(0);
    expect(within(own).queryByTestId("transcript-subagent")).toBeNull();
    expect(
      within(own)
        .getAllByRole("link")
        .some((link) => link.getAttribute("href")?.includes("body=4")),
    ).toBe(true);
  });
});

describe("a subagent's steps under its Task call", () => {
  // The shape of a wrapped Claude Code run: the gate, the harness check and
  // the receipt of one call share its tool_use_id, and the subagent's own
  // calls land on its chain, numbered from 0, between the Task call's frames.
  const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c3";
  const sub = { chainRef: CHAIN, type: "Explore", spawnKey: "toolu_C" };
  const frame = (over: Partial<TranscriptEntry>): TranscriptEntry =>
    transcriptEntry({
      kind: "frame",
      type: "oxagen:note",
      label: "oxagen:note",
      callKey: null,
      request: null,
      response: null,
      decision: null,
      turn: 1,
      frames: 1,
      cost: null,
      cumulativeCost: null,
      kinds: [],
      ...over,
    });
  const gate = (
    seq: string,
    key: string,
    tool: string,
    target: string | null,
    over: Partial<TranscriptEntry> = {},
  ) =>
    frame({
      seq,
      kind: "policy",
      type: "policy_decision",
      label: `allow ${tool}`,
      callKey: key,
      target,
      decision: {
        seq,
        decision: "allow",
        type: "policy_decision",
        at: transcriptEntry().at,
      },
      ...over,
    });
  const harness = (seq: string, key: string) =>
    frame({
      seq,
      type: "harness_permission",
      label: "allow Bash",
      callKey: key,
    });
  const call = (
    seq: string,
    key: string,
    label: string,
    over: Partial<TranscriptEntry> = {},
  ) =>
    frame({
      seq,
      kind: "tool_call",
      type: "tool_call",
      label,
      callKey: key,
      response: transcriptBody({
        seq,
        fidelity: "digest_only",
        bytesRef: null,
        text: null,
      }),
      ...over,
    });
  const entries = [
    frame({
      seq: "1",
      type: "turn_start",
      request: transcriptBody({ seq: "1", text: "Find the flaky test." }),
    }),
    gate("2", "toolu_A", "Bash", "git status"),
    harness("3", "toolu_A"),
    call("4", "toolu_A", "Bash ok"),
    gate("5", "toolu_C", "Task", null),
    harness("6", "toolu_C"),
    frame({ seq: "7", type: "subagent_start", callKey: "toolu_C" }),
    gate("0", "toolu_X1", "Grep", "flaky", { subagent: sub }),
    call("1", "toolu_X1", "Grep ok", { subagent: sub }),
    gate("2", "toolu_X2", "Read", "apps/app/src/flaky.test.ts", {
      subagent: sub,
    }),
    call("3", "toolu_X2", "Read ok", { subagent: sub }),
    call("8", "toolu_C", "Task ok"),
    gate("9", "toolu_B", "Bash", "git diff"),
    harness("10", "toolu_B"),
    call("11", "toolu_B", "Bash ok"),
  ];

  it("draws the subagent's calls inside the Task step, numbered under it, with no gap in the run's count", () => {
    renderSection({ read: readOk(runTranscript({ entries })) });
    const nested = screen.getByTestId("transcript-subagent-steps");
    const task = nested.closest('[data-testid="transcript-step"]');
    if (!(task instanceof HTMLElement))
      throw new Error("expected the Task step");
    expect(task).toHaveTextContent("Task");
    const inner = within(nested).getAllByTestId("transcript-step");
    expect(inner.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Grep"),
      expect.stringContaining("Read"),
    ]);
    expect(inner[0]).toHaveTextContent("flaky");
    // One step per call. The turn's start draws as the prompt above the turn,
    // not as a step (#4050), and the harness's allow draws no row of its own,
    // so neither leaves a gap in the count.
    const numbers = screen
      .getAllByTestId("step-number")
      .map((n) => n.textContent);
    expect(numbers).toEqual(["1", "2", "2.1", "2.2", "3"]);
  });
});

describe("a decision on a subagent's chain", () => {
  it("names the decision's chain when the server names one, and leaves it off otherwise", () => {
    const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c2";
    const page = runTranscript({ entries: [transcriptEntry()] });
    const first = page.entries[0];
    if (!first) throw new Error("Missing transcript fixture entry");
    const { subagent: _appSubagent, ...entry } = first;
    const decided = (seq: string, sessionUuid?: string) => ({
      ...entry,
      seq,
      endSeq: seq,
      callId: null,
      cost: null,
      cumulativeCost: null,
      request: null,
      response: null,
      decision: {
        seq,
        ...(sessionUuid === undefined ? {} : { sessionUuid }),
        decision: "deny",
        type: "policy_decision",
        at: entry.at,
      },
    });
    const mapped = RunTranscript.parse(
      toRunTranscript({
        ...page,
        entries: [decided("5", CHAIN), decided("6")],
      }),
    );
    expect(mapped.entries[0]?.decision?.chainRef).toBe(CHAIN);
    expect(mapped.entries[1]?.decision).not.toHaveProperty("chainRef");
    expect(mapped.entries[1]?.decision?.decision).toBe("deny");
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
        ...runTranscript(),
        entries: [wire("5", "high"), wire("6", null), wire("7")],
      }),
    );
    expect(mapped.entries.map((e) => e.effort)).toEqual(["high", null, null]);
  });
});

describe("the filter chips", () => {
  const RUN_URL =
    "/acme/core-platform/runs/tse_7k2m9q?tab=transcript&zoom=turns";
  const chipOrder = () =>
    within(screen.getByTestId("transcript-chips"))
      .getAllByRole("link")
      .map((link) => link.getAttribute("data-testid"));

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
    renderSection({ zoom: "turns" });
    for (const chip of ["prompt", "tools", "seal", "thinking"]) {
      expect(screen.getByTestId(`chip-${chip}`)).toHaveAttribute(
        "aria-current",
        "true",
      );
    }
    expect(screen.getByTestId("chip-errors")).not.toHaveAttribute(
      "aria-current",
    );
    const toggle = screen.getByTestId("chip-all");
    expect(toggle).toHaveTextContent("none");
    expect(toggle).toHaveAttribute("href", `${RUN_URL}&kinds=none`);
  });

  it("turns a chip off by linking to every other chip's kinds, in the contract's own order", () => {
    renderSection({ zoom: "turns" });
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "href",
      `${RUN_URL}&kinds=prompt%2Cresponses%2Cthinking%2Cusage%2Crecall%2Cseal`,
    );
  });

  it("files the tools chip over tools and their gate decisions, and offers all when a chip is off", () => {
    renderSection({ kinds: ["tools", "policy"], zoom: "turns" });
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByTestId("chip-prompt")).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByTestId("chip-prompt")).toHaveAttribute(
      "href",
      `${RUN_URL}&kinds=prompt%2Ctools%2Cpolicy`,
    );
    // Turning off the last chip that is on is an explicit none, never the
    // empty list, which would mean every kind.
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "href",
      `${RUN_URL}&kinds=none`,
    );
    const toggle = screen.getByTestId("chip-all");
    expect(toggle).toHaveTextContent("all");
    expect(toggle).toHaveAttribute("href", RUN_URL);
  });

  it("draws every chip off for none, reads no entries, and says how to get the run back", () => {
    renderSection({
      // A failed read must not show: none reads nothing.
      read: readError("frame_store_unreachable", 502),
      kinds: "none",
      zoom: "turns",
    });
    expect(screen.getByTestId("chip-prompt")).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByTestId("chip-prompt")).toHaveAttribute(
      "href",
      `${RUN_URL}&kinds=prompt`,
    );
    expect(screen.getByTestId("chip-all")).toHaveAttribute("href", RUN_URL);
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "Choose all",
    );
    expect(screen.queryByTestId("transcript")).toBeNull();
  });

  it("shows only failed calls behind errors, and links back to everything from it", () => {
    renderSection({ zoom: "turns" });
    const errors = screen.getByTestId("chip-errors");
    expect(errors).toHaveAttribute("title", "Show only failed calls");
    expect(errors).toHaveAttribute("href", `${RUN_URL}&kinds=errors`);
    cleanup();
    renderSection({ kinds: ["errors"], zoom: "turns" });
    expect(screen.getByTestId("chip-errors")).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByTestId("chip-errors")).toHaveAttribute("href", RUN_URL);
    // Errors alone is not a chip of its own kind: every chip reads off.
    expect(screen.getByTestId("chip-tools")).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("counts each chip's entries from the whole-run read", () => {
    const tally = readOk(
      runTranscript({
        entries: [
          transcriptEntry({ seq: "1", kinds: ["tools"] }),
          transcriptEntry({ seq: "2", kinds: ["policy"] }),
          transcriptEntry({ seq: "3", kinds: ["tools", "errors"] }),
        ],
      }),
    );
    renderSection({ tally });
    expect(screen.getByTestId("chip-tools-count")).toHaveTextContent("3");
    expect(screen.getByTestId("chip-errors-count")).toHaveTextContent("1");
    expect(screen.getByTestId("chip-prompt-count")).toHaveTextContent("0");
  });

  it("marks a count from a read that stopped short as a floor", () => {
    const tally = readOk(
      runTranscript({
        entries: [transcriptEntry({ kinds: ["tools"] })],
        complete: false,
        cursor: "ZjoxMQ",
      }),
    );
    renderSection({ tally });
    expect(screen.getByTestId("chip-tools-count")).toHaveTextContent("1+");
  });

  it("draws no counts when the whole-run read failed, rather than zeros (negative)", () => {
    renderSection({ tally: readError("frame_store_unreachable", 502) });
    expect(screen.queryByTestId("chip-tools-count")).toBeNull();
  });

  it("keeps the chips on screen when the read was refused, so the filter can be undone from the failure", () => {
    renderSection({
      read: readError("frame_store_unreachable", 502),
      kinds: ["policy"],
    });
    expect(screen.getByTestId("transcript-chips")).toBeInTheDocument();
    expect(screen.getByTestId("chip-all")).toHaveTextContent("all");
  });

  it("says no entry answers the filter rather than saying the run has no frames (negative)", () => {
    renderSection({
      read: readOk(runTranscript({ entries: [] })),
      kinds: ["policy", "recall"],
    });
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "Choose all",
    );
  });

  it("says the run has no frames when nothing is filtered and it has none", () => {
    renderSection({ read: readOk(runTranscript({ entries: [] })) });
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "no recorded frames yet",
    );
  });

  it("still opens the live stream when the filter matches nothing yet, so a later frame can fill the tab", () => {
    class FakeEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = FakeEventSource.CONNECTING;
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
    const instances: FakeEventSource[] = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    try {
      renderSection({
        read: readOk(runTranscript({ entries: [] })),
        kinds: ["errors"],
        status: "live",
      });
      expect(screen.getByTestId("transcript-empty")).toBeInTheDocument();
      expect(instances).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not open a stream for an empty sealed filter (negative)", () => {
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
        kinds: ["errors"],
        status: "sealed",
      });
      expect(screen.getByTestId("transcript-empty")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes an axe check with a filter applied", async () => {
    const { container } = renderSection({ kinds: ["tools", "errors"] });
    await expectNoAxe(container);
  });
});

describe("searching the transcript", () => {
  const search = (text: string) => {
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search the transcript" }),
      { target: { value: text } },
    );
  };

  it("draws only the turns and steps that match, opens them, and counts what it found", () => {
    renderSection({ zoom: "turns" });
    expect(screen.queryByTestId("transcript-search-count")).toBeNull();
    search("Open Pull Requests");
    expect(screen.getByTestId("transcript-search-count")).toHaveTextContent(
      "1 of 13 entries",
    );
    const turns = screen.getAllByTestId("transcript-turn");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toHaveAttribute("open");
    expect(screen.getAllByTestId("transcript-step")).toHaveLength(1);
  });

  it("keeps a found step's run-wide number", () => {
    renderSection({ zoom: "everything" });
    const numberOf = () =>
      screen
        .getAllByTestId("transcript-step")
        .find((step) => step.textContent.includes("create_tag"))
        ?.querySelector("[data-testid=step-number]")?.textContent;
    const before = numberOf();
    expect(before).toBeDefined();
    search("create_tag");
    expect(numberOf()).toBe(before);
  });

  it("says nothing matches rather than drawing an empty transcript (negative)", () => {
    renderSection();
    search("no-such-words");
    expect(screen.getByTestId("transcript-search-empty")).toHaveTextContent(
      "Nothing matches this search.",
    );
    expect(screen.queryAllByTestId("transcript-turn")).toHaveLength(0);
  });

  it("draws the whole transcript again when the search is cleared", () => {
    renderSection();
    const all = screen.getAllByTestId("transcript-turn").length;
    search("create_tag");
    search("   ");
    expect(screen.getAllByTestId("transcript-turn")).toHaveLength(all);
    expect(screen.queryByTestId("transcript-search-count")).toBeNull();
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
  /** A model call that thought, then a tool call after it, so the model step is not the head. */
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
    expect(screen.queryByTestId("step-thinking")).toBeNull();
    const toggle = screen.getByTestId("expand-thinking");
    expect(toggle).toHaveTextContent("expand thinking");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent("collapse thinking");
    const pane = screen.getByTestId("step-thinking");
    expect(pane).toHaveAttribute("open");
    expect(pane).toHaveTextContent("Check the tag is free first.");
    fireEvent.click(toggle);
    expect(screen.queryByTestId("step-thinking")).toBeNull();
  });

  it("says the harness kept no thought where only the token count was recorded (negative)", () => {
    renderSection({ read: thought(false), zoom: "everything" });
    expect(screen.queryByTestId("step-thinking")).toBeNull();
    expect(screen.getByTestId("step-thinking-unkept")).toHaveTextContent(
      "The model spent 42 tokens thinking.",
    );
  });

  it("draws no effort or thinking chip on a step that recorded neither (negative)", () => {
    renderSection();
    expect(screen.queryByTestId("step-effort")).toBeNull();
    expect(screen.queryByTestId("step-thinking-tokens")).toBeNull();
  });
});

describe("paging past the cursor", () => {
  const paged = readOk(mockupTranscript({ cursor: "ZjoxMQ", complete: true }));

  it("offers to read more only when the read carried a cursor", () => {
    renderSection({ read: paged });
    expect(screen.getByTestId("transcript-more")).toBeInTheDocument();
    cleanup();
    renderSection();
    expect(screen.queryByTestId("transcript-more")).toBeNull();
  });

  it("reads the next page from the cursor, through the same chips, and appends it", async () => {
    const more = mockupTranscript();
    readTranscriptPage.mockResolvedValue(
      pageOk({ ...more, cursor: null, complete: true }),
    );
    renderSection({ read: paged, kinds: ["tools"] });
    const before = screen.getAllByTestId("transcript-frame").length;
    fireEvent.click(screen.getByTestId("transcript-more"));
    await waitFor(() => {
      expect(screen.getAllByTestId("transcript-frame").length).toBeGreaterThan(
        before,
      );
    });
    expect(readTranscriptPage).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      "tse_7k2m9q",
      "everything",
      ["tools"],
      "ZjoxMQ",
    );
    // The page that was already on screen is still there: an append never
    // replaces what a person has scrolled to.
    expect(screen.getAllByTestId("transcript-frame").length).toBe(before * 2);
  });

  it("stops offering more once the page it read carried no cursor", async () => {
    readTranscriptPage.mockResolvedValue(
      pageOk({ ...mockupTranscript(), cursor: null, complete: true }),
    );
    renderSection({ read: paged });
    fireEvent.click(screen.getByTestId("transcript-more"));
    await waitFor(() => {
      expect(screen.queryByTestId("transcript-more")).toBeNull();
    });
    expect(screen.getByTestId("transcript-count")).toHaveTextContent(
      "This is the whole run",
    );
  });

  it("names a cursor the capability did not write, and keeps every entry already read (negative)", async () => {
    readTranscriptPage.mockResolvedValue({
      ok: false,
      reason: "invalid",
      code: "invalid_cursor",
      field: "after",
    });
    renderSection({ read: paged });
    const before = screen.getAllByTestId("transcript-frame").length;
    fireEvent.click(screen.getByTestId("transcript-more"));
    await waitFor(() => {
      expect(screen.getByTestId("transcript-page-failed")).toHaveTextContent(
        "not one this read wrote",
      );
    });
    expect(screen.getAllByTestId("transcript-frame")).toHaveLength(before);
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

  it("says more lies past the page rather than that the run is complete (negative)", () => {
    renderSection({ read: paged });
    const count = screen.getByTestId("transcript-count");
    expect(count).toHaveTextContent("More lie past this page");
    expect(count).not.toHaveTextContent("This is the whole run");
  });
});

describe("following a live run", () => {
  it("draws the recording line, and says it follows the head rather than that it polls", () => {
    renderSection({ read: readOk(mockupTranscript()), status: "live" });
    expect(screen.getByTestId("transcript-count")).toHaveTextContent(
      "follows the run's head",
    );
  });

  it("does not re-read the page on a timer: the stream is what says a frame landed (negative)", () => {
    vi.useFakeTimers();
    try {
      renderSection({ read: readOk(mockupTranscript()), status: "live" });
      vi.advanceTimersByTime(60_000);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("draws no follow line on a sealed run (negative)", () => {
    renderSection({ read: readOk(mockupTranscript()), status: "sealed" });
    expect(screen.getByTestId("transcript-count")).not.toHaveTextContent(
      "follows the run's head",
    );
  });

  it("keeps the transport and the frames reachable while following", () => {
    renderSection({ read: readOk(mockupTranscript()), status: "live" });
    const transcript = screen.getByTestId("transcript");
    expect(
      within(transcript).getByTestId("transport-readout"),
    ).toBeInTheDocument();
  });

  it("reads the tail once more for a frame that landed during an active read, rather than dropping it (negative)", async () => {
    // A fake EventSource: the test drives it directly rather than opening a
    // real connection, and captures the one instance the hook constructs.
    class FakeEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = FakeEventSource.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      close(): void {
        this.readyState = FakeEventSource.CLOSED;
      }
      addEventListener(): void {
        // The "done" listener is never exercised by this test.
      }
      removeEventListener(): void {}
      constructor() {
        instances.push(this);
      }
    }
    const instances: FakeEventSource[] = [];
    vi.stubGlobal("EventSource", FakeEventSource);

    // readTranscriptPage never resolves until the test tells it to, so the
    // second frame is guaranteed to land while the first read is in flight.
    const pending: Array<(read: ActionResult<RunTranscript>) => void> = [];
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

      // A second frame lands while that read is still pending. Before the
      // fix this signal was simply discarded by the `readingRef.current`
      // guard, and nothing recorded that it had arrived.
      source.onmessage?.(new MessageEvent("message", { data: "{}" }));
      await vi.advanceTimersByTimeAsync(750);
      expect(pending).toHaveLength(1);

      // The active read settles. The recorded signal must now trigger the
      // follow-up tail read on its own, with no third frame required.
      const resolveFirst = pending[0];
      if (resolveFirst === undefined) throw new Error("no pending read");
      await act(async () => {
        resolveFirst(
          pageOk({ ...mockupTranscript(), cursor: "next", complete: false }),
        );
        // Flush the microtask queue: the promise's own continuation, the
        // state updates it triggers, and the follow-up loadMore's call into
        // readTranscriptPage each resolve as a separate microtask hop. Fake
        // timers are active, so waitFor's real-timer polling never fires.
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(pending).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("drains every full page from one coalesced signal until a short page, rather than stalling behind the head (negative)", async () => {
    // A live run that already has more history than one coalesce window can
    // surface: the stream fires once after COALESCE_MS, loadMore must keep
    // reading while each page is full and still carries a resume cursor.
    class FakeEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readyState = FakeEventSource.OPEN;
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
    const instances: FakeEventSource[] = [];
    vi.stubGlobal("EventSource", FakeEventSource);

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
          transcriptEntry({
            seq: "451",
            endSeq: "451",
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

      // One coalesced signal: before the drain fix this would read only the
      // first full page and leave the rest unread until another frame.
      source.onmessage?.(new MessageEvent("message", { data: "{}" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(750);
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });

      expect(readTranscriptPage).toHaveBeenCalledTimes(3);
      expect(readTranscriptPage).toHaveBeenNthCalledWith(
        1,
        "acme",
        "core-platform",
        "tse_7k2m9q",
        "everything",
        [],
        "page1",
      );
      expect(readTranscriptPage).toHaveBeenNthCalledWith(
        2,
        "acme",
        "core-platform",
        "tse_7k2m9q",
        "everything",
        [],
        "page2",
      );
      expect(readTranscriptPage).toHaveBeenNthCalledWith(
        3,
        "acme",
        "core-platform",
        "tse_7k2m9q",
        "everything",
        [],
        "page3",
      );
      // A fourth call would mean the short page did not stop the drain.
      expect(readTranscriptPage).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe("a step carrying both halves", () => {
  /**
   * The contract folds a step at the `steps` and `turns` zooms, so one entry
   * carries a tool's input in `request` and its result in `response`. A
   * renderer that picked between them positionally would draw the input where
   * the result belongs, and nothing about the page would look wrong.
   */
  const folded = transcriptEntry({
    seq: "20",
    endSeq: "21",
    kind: "tool_call",
    type: "tool_result",
    label: "create_release ok",
    request: transcriptBody({
      seq: "20",
      text: '{"branch":"release/3.2"}',
    }),
    response: transcriptBody({
      seq: "21",
      text: '{"ok":true,"tag":"v3.2.0"}',
    }),
  });

  it("shows the result, and does not show the input in its place", () => {
    renderSection({
      read: readOk(runTranscript({ entries: [folded] })),
      zoom: "everything",
    });
    const frame = screen.getByTestId("transcript-frame");
    expect(frame).toHaveTextContent('{"ok":true,"tag":"v3.2.0"}');
    const halves = within(frame).getAllByTestId("transcript-half");
    const result = halves.at(-1);
    if (result === undefined) throw new Error("the result half is drawn");
    expect(result).toHaveAttribute("data-half", "Returned");
    expect(result).toHaveTextContent('{"ok":true,"tag":"v3.2.0"}');
    expect(result).not.toHaveTextContent('{"branch":"release/3.2"}');
  });

  it("shows both halves at the steps zoom, which is where a folded entry can reach the view", () => {
    // The Transcript tab reads at `everything` today, so a folded entry does
    // not reach this renderer through it. The port takes the zoom, though, and
    // the Cost tab already reads at `turns` and `steps`, so the renderer is
    // held to the folded shape rather than to the caller that happens to be
    // wired to it.
    renderSection({
      read: readOk(runTranscript({ zoom: "steps", entries: [folded] })),
      zoom: "steps",
    });
    const halves = screen.getAllByTestId("transcript-half");
    expect(halves.map((half) => half.getAttribute("data-half"))).toEqual([
      "Called with",
      "Returned",
    ]);
    const frame = screen.getByTestId("transcript-frame");
    expect(frame).toHaveTextContent('{"branch":"release/3.2"}');
    expect(frame).toHaveTextContent('{"ok":true,"tag":"v3.2.0"}');
  });

  it("still draws a one-half entry as one half, named by the half it is", () => {
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
      zoom: "everything",
    });
    const halves = screen.getAllByTestId("transcript-half");
    expect(halves).toHaveLength(1);
    expect(halves[0]).toHaveAttribute("data-half", "Returned");
    expect(halves[0]).toHaveTextContent("cutting it now");
  });

  it("still draws an outgoing-only entry as Sent, not as Called with (negative)", () => {
    renderSection({
      read: readOk(
        runTranscript({
          entries: [
            transcriptEntry({
              kind: "tool_call",
              request: transcriptBody({ text: '{"branch":"release/3.2"}' }),
              response: null,
            }),
          ],
        }),
      ),
      zoom: "everything",
    });
    const halves = screen.getAllByTestId("transcript-half");
    expect(halves).toHaveLength(1);
    expect(halves[0]).toHaveAttribute("data-half", "Sent");
  });

  it("shows the input too, labelled as what the tool was called with", () => {
    renderSection({
      read: readOk(runTranscript({ entries: [folded] })),
      zoom: "everything",
    });
    const halves = screen.getAllByTestId("transcript-half");
    expect(halves).toHaveLength(2);
    const [input] = halves;
    if (input === undefined) throw new Error("the input half is drawn");
    expect(input).toHaveAttribute("data-half", "Called with");
    expect(input).toHaveTextContent('{"branch":"release/3.2"}');
  });

  it("labels a model exchange's outgoing half Sent, not Called with", () => {
    renderSection({
      read: readOk(
        runTranscript({
          entries: [
            transcriptEntry({
              kind: "model_call",
              request: transcriptBody({ seq: "8", text: "cut the release" }),
              response: transcriptBody({ seq: "9", text: "cutting it now" }),
            }),
          ],
        }),
      ),
      zoom: "everything",
    });
    const [outgoing] = screen.getAllByTestId("transcript-half");
    if (outgoing === undefined) throw new Error("the outgoing half is drawn");
    expect(outgoing).toHaveAttribute("data-half", "Sent");
  });

  it("draws no row for a step with nothing to read, and says so inside a step that has (negative)", () => {
    // A frame with neither half and no decision is bookkeeping or a
    // digest-only duplicate: it gets no row of its own. Inside a step that
    // does have a body, the same frame still says what it lacks.
    renderSection({
      read: readOk(
        runTranscript({
          entries: [transcriptEntry({ request: null, response: null })],
        }),
      ),
      zoom: "everything",
    });
    expect(screen.queryByTestId("transcript-step")).toBeNull();
    expect(screen.queryByTestId("entry-no-halves")).toBeNull();
    expect(screen.queryByTestId("transcript-half")).toBeNull();
  });
});

describe("live access changes", () => {
  it("names the required access instead of suggesting transport recovery", () => {
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
    expect(
      screen.getByTestId("transcript").querySelector(".animate-pulse"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /go live/i })).toBeNull();
    fireEvent.change(screen.getByRole("slider"), { target: { value: "0" } });
    expect(screen.getByTestId("transcript-count")).toHaveTextContent(
      "Ask a workspace Owner",
    );
    expect(sources).toHaveLength(1);
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: slider.getAttribute("max") } });
    expect(sources).toHaveLength(1);
    expect(screen.getByTestId("transcript-count")).toHaveTextContent(
      "Ask a workspace Owner",
    );
  });
});

describe("empty transcript access changes", () => {
  const accessCases: { kinds: TranscriptKind[] }[] = [
    { kinds: [] },
    { kinds: ["errors"] },
  ];
  it.each(accessCases)("shows access refusal for filter %j", ({ kinds }) => {
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
    renderSection({
      read: readOk(runTranscript({ entries: [] })),
      kinds,
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
    expect(screen.getByTestId("transcript-empty")).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});

// Run-relative time. A transcript reads in the run's own clock: the rail
// counts from the run's first frame and the frame head names the elapsed
// time. The wall clock was drawn here as minute-of-hour and second-of-minute
// with no hour, so a run that crossed an hour boundary appeared to run
// backwards, and no reading told anyone where in the run they were. The
// absolute instant is not dropped — it stays on the rail's `dateTime`.
describe("run-relative time", () => {
  const START = "2026-09-20T08:07:09.000Z";
  const LATER = "2026-09-20T08:19:43.000Z";

  function twoFrames() {
    return readOk(
      runTranscript({
        entries: [
          transcriptEntry({
            seq: "1",
            endSeq: "1",
            at: START,
            elapsedMs: 0,
          }),
          transcriptEntry({
            seq: "2",
            endSeq: "2",
            at: LATER,
            elapsedMs: 754_000,
          }),
        ],
      }),
    );
  }

  it("counts the step rail from the run's start and keeps the instant in dateTime", () => {
    renderSection({ read: twoFrames(), zoom: "everything" });
    const rails = screen
      .getAllByTestId("transcript-step")
      .map((step) => step.querySelector("time"));
    expect(rails.map((time) => time?.textContent)).toEqual(["0:00", "12:34"]);
    expect(rails.map((time) => time?.getAttribute("dateTime"))).toEqual([
      START,
      LATER,
    ]);
  });

  it("names the frame head's time as elapsed, not as a wall-clock reading", () => {
    renderSection({ read: twoFrames(), zoom: "everything" });
    const heads = screen
      .getAllByTestId("transcript-frame")
      .map((frame) => frame.textContent);
    expect(heads[0]).toContain("+0 ms");
    expect(heads[1]).toContain("+12:34");
    // The hour the run happened to start in is not a reading of the run.
    for (const head of heads) expect(head).not.toContain("08:");
  });
});
