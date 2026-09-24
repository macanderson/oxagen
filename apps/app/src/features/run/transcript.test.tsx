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

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };
const RUN = runRow();

type SectionView = {
  read?: Read<RunTranscript>;
  kinds?: TranscriptKind[];
  zoom?: RunTranscript["zoom"];
  status?: RunRow["status"];
};

function renderSection(view: SectionView = {}) {
  const {
    read = readOk(mockupTranscript()),
    kinds = [],
    zoom = "steps",
    status = RUN.status,
  } = view;
  return render(
    <IntlProvider>
      <TranscriptSection
        read={read}
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
    const entry = page.entries[0];
    if (!entry) throw new Error("Missing transcript fixture entry");
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
              ...transcriptBody(),
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

describe("the filter chips", () => {
  it("draws the spec's chip row in order, with thinking and seal as counts that filter nothing", () => {
    renderSection();
    const row = screen.getByTestId("transcript-chips");
    const names = Array.from(row.querySelectorAll('[data-testid^="chip-"]'))
      .map((node) => node.getAttribute("data-testid"))
      .filter((id) => id !== null && !id.startsWith("chip-count-"));
    expect(names).toEqual([
      "chip-prompt",
      "chip-responses",
      "chip-thinking",
      "chip-tools",
      "chip-usage",
      "chip-recall",
      "chip-seal",
      "chip-policy",
      "chip-errors",
    ]);
    for (const gap of ["thinking", "seal"]) {
      const chip = screen.getByTestId(`chip-${gap}`);
      expect(chip.tagName).toBe("SPAN");
      expect(chip).toHaveAttribute("aria-disabled", "true");
      expect(chip).toHaveAttribute("data-gap", `transcript-kind-${gap}`);
      expect(chip).not.toHaveAttribute("href");
    }
    expect(screen.getByTestId("chip-errors")).toHaveTextContent("✗ errors");
    expect(screen.queryByTestId("chip-proof")).toBeNull();
  });

  it("counts each chip over the whole run, thinking from the reasoning blocks, and gives seal no count", () => {
    const thought = transcriptEntry({
      seq: "3",
      endSeq: "3",
      kinds: ["responses"],
      response: transcriptBody({
        blocks: [
          { kind: "thinking", text: "Group by label first." },
          { kind: "text", text: "Grouping." },
        ],
      }),
    });
    const tool = transcriptEntry({
      seq: "4",
      endSeq: "4",
      kind: "tool_call",
      kinds: ["tools", "errors"],
    });
    renderSection({
      read: readOk(runTranscript({ entries: [thought, tool] })),
    });
    expect(screen.getByTestId("chip-count-responses")).toHaveTextContent("1");
    expect(screen.getByTestId("chip-count-thinking")).toHaveTextContent("1");
    expect(screen.getByTestId("chip-count-tools")).toHaveTextContent("1");
    expect(screen.getByTestId("chip-count-errors")).toHaveTextContent("1");
    expect(screen.getByTestId("chip-count-prompt")).toHaveTextContent("0");
    expect(screen.queryByTestId("chip-count-seal")).toBeNull();
  });

  it("gives no chip a count when the whole-run read failed (negative)", () => {
    renderSection({ read: readError("frame_store_unreachable", 502) });
    expect(screen.queryByTestId("chip-count-prompt")).toBeNull();
  });

  it("marks a pressed chip with aria-current, which is the attribute a link may carry", () => {
    renderSection({ kinds: ["tools"] });
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByTestId("chip-prompt")).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("links a chip that is off to the filter with it added, in the contract's own order", () => {
    renderSection({ kinds: ["tools"], zoom: "turns" });
    expect(screen.getByTestId("chip-errors")).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=transcript&zoom=turns&kinds=tools%2Cerrors",
    );
  });

  it("links a chip that is on to the filter with it taken off again", () => {
    renderSection({ kinds: ["tools"], zoom: "turns" });
    expect(screen.getByTestId("chip-tools")).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=transcript&zoom=turns",
    );
  });

  it("offers no clear link when nothing is filtered (negative)", () => {
    renderSection();
    expect(screen.queryByTestId("chip-clear")).toBeNull();
  });

  it("labels the toggle back to every entry all", () => {
    renderSection({ kinds: ["tools"] });
    expect(screen.getByTestId("chip-clear")).toHaveTextContent("all");
  });

  it("keeps the chips on screen when the read was refused, so the filter can be cleared from the failure", () => {
    renderSection({
      read: readError("frame_store_unreachable", 502),
      kinds: ["policy"],
    });
    expect(screen.getByTestId("transcript-chips")).toBeInTheDocument();
    expect(screen.getByTestId("chip-clear")).toBeInTheDocument();
  });

  it("says no entry answers the filter rather than saying the run has no frames (negative)", () => {
    renderSection({
      read: readOk(runTranscript({ entries: [] })),
      kinds: ["policy", "recall"],
    });
    expect(screen.getByTestId("transcript-empty")).toHaveTextContent(
      "Clear the filter",
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

describe("the feed head, the search and the transport ends", () => {
  it("prints the task, the agent, the model, the turns, the steps, the entries, the status and the burn", () => {
    render(
      <IntlProvider>
        <TranscriptSection
          read={readOk(runTranscript())}
          zoom="steps"
          kinds={[]}
          run={{
            status: "live",
            replayGrade: RUN.replayGrade,
            taskRef: "acme/platform#482",
            agentKey: "acme.core.release-bot",
            model: RUN.model,
            turns: 7,
            steps: 41,
            cost: {
              micros: "4131265",
              currency: "USD",
              basis: "gateway_observed",
            },
          }}
          {...PLACE}
        />
      </IntlProvider>,
    );
    const head = screen.getByTestId("transcript-head");
    expect(head).toHaveTextContent(
      `acme/platform#482 · acme.core.release-bot · ${RUN.model?.slug ?? ""} · 7 turns · 41 steps · 1 entry`,
    );
    expect(head).toHaveTextContent("live");
    expect(screen.getByTestId("transcript-burn")).toHaveTextContent(
      /burn .* of /,
    );
  });

  it("leaves out what the run row does not carry rather than printing a zero (negative)", () => {
    renderSection();
    const head = screen.getByTestId("transcript-head");
    expect(head).not.toHaveTextContent("turns");
    expect(head).toHaveTextContent("13 entries");
  });

  it("narrows the turns drawn to those that match the search, and says when none does", () => {
    renderSection();
    const search = screen.getByRole("searchbox", {
      name: "Search the transcript",
    });
    expect(search).toHaveAttribute("placeholder", "search the transcript");
    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(screen.getByTestId("transcript-no-match")).toHaveTextContent(
      "No entry on this page matches that search.",
    );
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.queryByTestId("transcript-no-match")).toBeNull();
  });

  it("jumps to the first and the last frame and shows the position as n / N", () => {
    const entries = [
      transcriptEntry({ seq: "1", endSeq: "1" }),
      transcriptEntry({ seq: "2", endSeq: "2" }),
      transcriptEntry({ seq: "3", endSeq: "3" }),
    ];
    renderSection({
      read: readOk(runTranscript({ entries })),
      status: "sealed",
    });
    const readout = screen.getByTestId("transport-readout");
    expect(readout).toHaveTextContent("3 / 3");
    expect(screen.getByTestId("transport-last")).toBeDisabled();
    fireEvent.click(screen.getByTestId("transport-first"));
    expect(readout).toHaveTextContent("1 / 3");
    expect(screen.getByTestId("transport-first")).toBeDisabled();
    fireEvent.click(screen.getByTestId("transport-last"));
    expect(readout).toHaveTextContent("3 / 3");
  });
});
