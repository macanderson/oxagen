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
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunTranscript, TranscriptKind } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  mockupTranscript,
  runRow,
  runTranscript,
  transcriptBody,
  transcriptEntry,
} from "./run.builders";

const { readTranscriptPage } = vi.hoisted(() => ({
  readTranscriptPage:
    vi.fn<typeof import("./actions").readTranscriptPage>(),
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
      readOk({ ...more, cursor: null, complete: true }),
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
      readOk({ ...mockupTranscript(), cursor: null, complete: true }),
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
    readTranscriptPage.mockResolvedValue(readError("invalid_input", 400));
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
    readTranscriptPage.mockResolvedValue(
      readError("frame_store_unreachable", 502),
    );
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
    expect(within(transcript).getByTestId("transport-readout")).toBeInTheDocument();
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

  it("says neither half was recorded rather than drawing an empty body (negative)", () => {
    renderSection({
      read: readOk(
        runTranscript({
          entries: [transcriptEntry({ request: null, response: null })],
        }),
      ),
      zoom: "everything",
    });
    expect(screen.getByTestId("entry-no-halves")).toBeInTheDocument();
    expect(screen.queryByTestId("transcript-half")).toBeNull();
  });
});
