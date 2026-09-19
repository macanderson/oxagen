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
import type { RunTranscript, TranscriptKind } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { readError, readOk } from "@/data/read";
import type { ActionResult } from "@/server/kernel";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { mockupTranscript, runRow, runTranscript } from "./run.builders";

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

describe("the filter chips", () => {
  it("draws one chip per kind the contract publishes, and none the mockup drew that it does not (negative)", () => {
    renderSection();
    for (const kind of [
      "prompt",
      "responses",
      "tools",
      "policy",
      "recall",
      "usage",
      "errors",
    ]) {
      expect(screen.getByTestId(`chip-${kind}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("chip-thinking")).toBeNull();
    expect(screen.queryByTestId("chip-proof")).toBeNull();
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
      "no frames yet",
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
    readTranscriptPage.mockResolvedValue(pageFailed("invalid_input"));
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
});
