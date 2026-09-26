// @vitest-environment jsdom
// The Context tab (mockup `promptRow`, `runManifestPanel`, `contextTab`):
// the operator's first prompt and the first request's reported input, the
// steering manifest as a spine with its cuts, the prompt window, the context
// frames, the walk and the retrieval figures. What the record carries is
// drawn; what it does not (the window block by block, a frame's score or
// citation, the retrieval figures) says not recorded, never a number.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunTranscript } from "@/data/contracts/run";
import type { RunContext } from "@/data/contracts/run-context";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  contextAssembly,
  contextWindow,
  runContext,
  runDetail,
  runRow,
  runSource,
  runTranscript,
  transcriptEntry,
} from "./run.builders";
import {
  evidenceSteps,
  evidenceTranscript,
  manifestRecall,
  manifestText,
  tabProps,
} from "./sections.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { ContextTab } = await import("./sections");

afterEach(cleanup);

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

async function renderContext({
  everything = readOk(evidenceTranscript()),
  transcript = readOk(evidenceSteps()),
  run = runRow(),
  context,
}: {
  everything?: Read<RunTranscript>;
  /** The run at `steps`, where the first model step is one entry. */
  transcript?: Read<RunTranscript>;
  run?: ReturnType<typeof runRow>;
  /** `get_run_context`; a run that recorded no window when absent. */
  context?: Read<RunContext>;
} = {}) {
  // The tab's one read of its own is `get_run_context`; `calls.frameBody`
  // proves it reads no body.
  const { source, calls } = runSource({
    detail: readOk(runDetail({ run })),
    context,
  });
  const body = await ContextTab(
    tabProps({ ctx, source, run, everything, transcript }),
  );
  const rendered = render(<IntlProvider>{body}</IntlProvider>);
  return { ...rendered, calls };
}

const region = (name: string) => within(screen.getByRole("region", { name }));

describe("ContextTab", () => {
  it("draws the prompt the operator wrote and the input the first request reported, with the split it does not have said so", async () => {
    const { container } = await renderContext();
    const prompt = region("Prompt");
    expect(prompt.getByText("Written by Marcus Bell")).toBeTruthy();
    expect(screen.getByTestId("run-context-first-prompt")).toHaveTextContent(
      "“Cut 4.11.0 release notes. Task a-intel/platform#482.”",
    );
    expect(prompt.getByText(/15,368 tok sent/)).toBeTruthy();
    expect(prompt.getByText(/tok written not recorded/)).toBeTruthy();
    const bars = within(screen.getByTestId("run-context-bars"));
    expect(bars.getAllByText("not recorded")).toHaveLength(3);
    expect(
      prompt.getByText(
        /The first request sent 15,368 tokens, and 12,000 of them came from cache\./,
      ),
    ).toBeTruthy();
    expect(
      prompt.getByRole("link", { name: "Open the window" }),
    ).toHaveAttribute("href", "#run-context-window");
    await expectNoAxe(container);
  });

  it("draws the manifest frame as a spine: the tally, the rendered items, three cuts and the rest folded", async () => {
    await renderContext();
    const manifest = region("Steering manifest");
    // The tally is the server's reading of the manifest (`recall`, ADR-182):
    // what it rendered, what it cut, and the tokens it spent.
    expect(screen.getByTestId("run-manifest-tally")).toHaveTextContent(
      "3 rendered · 5 cut · 1,340 tok",
    );
    const items = screen.getAllByTestId("run-manifest-item");
    expect(
      items.filter((item) => item.dataset.outcome === "included"),
    ).toHaveLength(3);
    expect(items.filter((item) => item.dataset.outcome === "cut")).toHaveLength(
      5,
    );
    expect(manifest.getByText("ctx.release.never-merge")).toBeTruthy();
    expect(manifest.getAllByText("cut: budget")).toHaveLength(3);
    expect(
      manifest.getByText("Superseded by ctx.release.notes-format."),
    ).toBeTruthy();
    expect(manifest.getByText("2 more cut")).toBeTruthy();
    expect(
      manifest.getByText(/Recorded once at frame 1 on bundle v41\./),
    ).toBeTruthy();
    // Steering has no Preview tab: the button says so rather than opening nothing.
    const preview = manifest.getByRole("button", { name: "Open in Preview" });
    expect(preview).toBeDisabled();
    expect(preview).toHaveAccessibleDescription(
      "Steering has no Preview tab yet.",
    );
    expect(screen.queryByTestId("run-manifest-observe")).toBeNull();
  });

  it("says an observe-tier run's manifest was assembled and not delivered", async () => {
    await renderContext({ run: runRow({ enforcementTier: "observe" }) });
    expect(screen.getByTestId("run-manifest-observe")).toHaveTextContent(
      "Assembled, not delivered.",
    );
  });

  it("draws a manifest the transcript cut at its ceiling from the server's reading, and reads no body of its own", async () => {
    // The server read the frame's whole body for `recall` (ADR-182); the
    // text the transcript carries is never parsed here.
    const cut = evidenceTranscript();
    const entries = cut.entries.map((entry) =>
      entry.type === "steering.manifest" && entry.response !== null
        ? {
            ...entry,
            response: { ...entry.response, text: '{"sch', truncated: true },
          }
        : entry,
    );
    const { calls } = await renderContext({
      everything: readOk({ ...cut, entries }),
    });
    expect(calls.frameBody).toEqual([]);
    expect(screen.getByTestId("run-manifest-tally")).toHaveTextContent(
      "3 rendered · 5 cut · 1,340 tok",
    );
    expect(screen.getAllByTestId("run-manifest-item")).toHaveLength(8);
  });

  it("draws the items the server read even when the transcript carries no text for the frame", async () => {
    const base = evidenceTranscript();
    const entries = base.entries.map((entry) =>
      entry.type === "steering.manifest" && entry.response !== null
        ? { ...entry, response: { ...entry.response, text: null } }
        : entry,
    );
    await renderContext({ everything: readOk({ ...base, entries }) });
    const items = screen.getAllByTestId("run-manifest-item");
    expect(items).toHaveLength(8);
    expect(items[0]).toHaveTextContent("ctx.release.never-merge");
    expect(items[0]).toHaveTextContent("must");
  });

  it("says a manifest whose body was not retained has no items to show, and reads nothing more (negative)", async () => {
    const digestOnly = evidenceTranscript();
    // The server read no body either, so its recall is the frame count the
    // frame recorded, which here is none.
    const entries = digestOnly.entries.map((entry) =>
      entry.type === "steering.manifest" && entry.response !== null
        ? {
            ...entry,
            response: {
              ...entry.response,
              text: null,
              fidelity: "digest_only" as const,
            },
            recall: manifestRecall(null),
          }
        : entry,
    );
    const { calls } = await renderContext({
      everything: readOk({ ...digestOnly, entries }),
    });
    expect(calls.frameBody).toEqual([]);
    expect(
      region("Steering manifest").getByText(
        "The manifest frame's body was not retained, so its items are not shown.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("run-manifest-tally")).toBeNull();
  });

  it("says the manifest could not be read when the server could not read its body (negative)", async () => {
    const base = evidenceTranscript();
    const entries = base.entries.map((entry) =>
      entry.type === "steering.manifest"
        ? { ...entry, recall: manifestRecall({ state: "unreadable" }) }
        : entry,
    );
    const { calls } = await renderContext({
      everything: readOk({ ...base, entries }),
    });
    expect(calls.frameBody).toEqual([]);
    expect(screen.queryByTestId("run-manifest-item")).toBeNull();
    expect(
      region("Steering manifest").getByText(
        "The manifest frame's body could not be read.",
      ),
    ).toBeTruthy();
  });

  it("says a body that is not a manifest is not one, never a list of guesses (negative)", async () => {
    await renderContext({
      everything: readOk(evidenceTranscript({}, JSON.stringify({ items: 3 }))),
    });
    expect(
      region("Steering manifest").getByText(
        "The manifest frame's body is not a manifest this page can read.",
      ),
    ).toBeTruthy();
  });

  it("says no manifest frame is on the record when the run sealed none", async () => {
    const without = evidenceTranscript();
    await renderContext({
      everything: readOk({
        ...without,
        entries: without.entries.filter(
          (entry) => entry.type !== "steering.manifest",
        ),
      }),
    });
    expect(
      region("Steering manifest").getByText(
        "No steering manifest frame is on this run's record.",
      ),
    ).toBeTruthy();
  });

  it("draws the first request's window total and says the blocks are not recorded", async () => {
    await renderContext();
    const window = region("Prompt window");
    expect(window.getByText("model.request seq 4")).toBeTruthy();
    expect(window.getByText("15,368 tok in")).toBeTruthy();
    expect(window.getByText("not recorded block by block")).toBeTruthy();
  });

  it("says there is no window on record when no model request is in view (negative)", async () => {
    const quiet = evidenceSteps();
    await renderContext({
      transcript: readOk({
        ...quiet,
        entries: quiet.entries.filter((entry) => entry.node !== "model"),
      }),
    });
    expect(screen.getByTestId("run-context-no-window")).toHaveTextContent(
      "No window on record",
    );
    expect(screen.queryByRole("region", { name: "Prompt window" })).toBeNull();
    expect(
      region("Prompt").getByText(
        "No model request is in view for this run, so the window is not shown.",
      ),
    ).toBeTruthy();
  });

  it("lists the context frames with the design's columns, and the tokens only where a frame counted them", async () => {
    await renderContext();
    const table = screen.getByRole("table", { name: "Context frames" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Kind", "Frame", "Tok", "Score", "Cited"]);
    const [manifest, assembled] = screen.getAllByTestId("run-context-frame");
    if (manifest === undefined || assembled === undefined)
      throw new Error("two rows");
    const cells = (row: HTMLElement) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    expect(cells(manifest)).toEqual([
      "steering.manifest",
      "1",
      "1,340",
      "not recorded",
      "not recorded",
    ]);
    expect(cells(assembled)).toEqual([
      "context.assembled",
      "2",
      "not recorded",
      "not recorded",
      "not recorded",
    ]);
    expect(within(assembled).getByRole("link", { name: "2" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=2",
    );
  });

  it("walks the frames that fed the window, in the order they were recorded, each opening its frame", async () => {
    await renderContext();
    const walk = region("Walk the window");
    expect(walk.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "steering.manifest seq 11,340 tok",
      "context.assembled seq 2fr 2",
      "turn_start seq 3fr 3",
      "model.request seq 415,368 tok",
    ]);
  });

  it("draws the retrieval figures as not recorded and names where the context was assembled", async () => {
    await renderContext();
    const stats = region("Retrieval stats");
    for (const label of [
      "Candidates scored",
      "Admitted",
      "Held back",
      "Below the floor",
      "Headroom left",
      "Composition digest",
    ])
      expect(stats.getByText(label).nextElementSibling).toHaveTextContent(
        "not recorded",
      );
    // The frame is named by its type and seq, not a bare number, and opens
    // in the player.
    expect(
      stats.getByRole("link", { name: "context.assembled · fr 2" }),
    ).toHaveAttribute("href", expect.stringContaining("tab=actions&body=2"));
  });

  it("says the run recorded no recall when no frame answers the recall chip", async () => {
    await renderContext({
      everything: readOk(runTranscript({ entries: [transcriptEntry()] })),
    });
    expect(screen.getByText("This run recorded no recall.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Context frames" })).toBeNull();
  });

  it("names the transcript read's failure and reads no manifest (negative)", async () => {
    const { calls } = await renderContext({
      everything: readError("frame_store_unreachable", 502),
    });
    expect(calls.frameBody).toEqual([]);
    expect(
      region("Prompt").getByText(/frame_store_unreachable|could not|failed/i),
    ).toBeTruthy();
    expect(screen.queryByTestId("run-manifest")).toBeNull();
  });

  it("names the operator by id when no name is recorded, and says so when neither is (negative)", async () => {
    await renderContext({ run: runRow({ operatorName: null }) });
    expect(
      region("Prompt").getByText("Written by prn_marcusbell"),
    ).toBeTruthy();
    cleanup();
    await renderContext({
      run: runRow({ operatorName: null, operatorId: null }),
    });
    expect(region("Prompt").getByText("Operator not recorded")).toBeTruthy();
  });

  it("says the first prompt's text was not retained rather than quoting nothing (negative)", async () => {
    const base = evidenceTranscript();
    const entries = base.entries.map((entry) =>
      entry.type === "turn_start" && entry.response !== null
        ? { ...entry, response: { ...entry.response, text: null } }
        : entry,
    );
    await renderContext({ everything: readOk({ ...base, entries }) });
    expect(screen.getByTestId("run-context-first-prompt")).toHaveTextContent(
      "The first prompt's text was not retained.",
    );
  });

  it("says how much came from cache when the request did not report every input class (negative)", async () => {
    const base = evidenceSteps();
    const entries = base.entries.map((entry) =>
      entry.usage === null || entry.usage === undefined
        ? entry
        : { ...entry, usage: { ...entry.usage, cacheWrite: null } },
    );
    await renderContext({ transcript: readOk({ ...base, entries }) });
    const prompt = region("Prompt");
    expect(
      prompt.getByText(
        /12,000 tokens of the first request came from cache\. Its full input was not reported\./,
      ),
    ).toBeTruthy();
    expect(prompt.getByText(/tok sent not recorded/)).toBeTruthy();
  });

  it("names a cut with no reason, draws no line for a reason it does not know, and folds nothing at three cuts or fewer", async () => {
    const item = (
      id: string,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      id,
      kind: "record",
      force: "should",
      tokens: 10,
      outcome: "included",
      ...overrides,
    });
    await renderContext({
      everything: readOk(
        evidenceTranscript(
          {},
          manifestText({
            items: [
              item("steer.release-freeze", { kind: "steer", force: "must" }),
              item("ctx.unreasoned", { outcome: "cut" }),
              item("ctx.pinned", { outcome: "cut", reason: "pinned" }),
            ],
            bundle_version: undefined,
          }),
        ),
      ),
    });
    const items = screen.getAllByTestId("run-manifest-item");
    expect(items).toHaveLength(3);
    const [steer, unreasoned, pinned] = items;
    if (steer === undefined || unreasoned === undefined || pinned === undefined)
      throw new Error("three items");
    expect(steer).toHaveTextContent("steer");
    expect(unreasoned).toHaveTextContent("cut: no reason recorded");
    expect(pinned).toHaveTextContent("cut: pinned");
    // A reason this page has no sentence for is shown as its word, never explained.
    expect(pinned.querySelector("p")).toBeNull();
    expect(screen.queryByText(/more cut/)).toBeNull();
    // A manifest that names no bundle says only the frame it was recorded at.
    expect(
      region("Steering manifest").getByText(
        /^Recorded once at frame 1\. A recorded frame never changes/,
      ),
    ).toBeTruthy();
  });
});

describe("ContextTab with the window on record (ADR-200)", () => {
  /** A first request whose blocks split its 15,368 reported tokens by bytes. */
  const measured = contextWindow({
    seq: "4",
    promptTokens: 15_368,
    bytes: 30_736,
    blocks: [
      { kind: "system", bytes: 3074, items: 1, tokens: 1537 },
      { kind: "steering", bytes: 1536, items: 1, tokens: 768 },
      { kind: "tools", bytes: 12_294, items: 14, tokens: 6147 },
      { kind: "context", bytes: 3074, items: 2, tokens: 1537 },
      { kind: "conversation", bytes: 10_758, items: 5, tokens: 5379 },
    ],
  });

  it("draws the first request's blocks, and 'tok sent' is the window's total", async () => {
    const { calls, container } = await renderContext({
      context: readOk(
        runContext({ windows: [measured], assemblies: [contextAssembly()] }),
      ),
    });
    expect(calls.context).toHaveLength(1);
    expect(calls.frameBody).toEqual([]);
    const prompt = region("Prompt");
    expect(prompt.getByText(/15,368 tok sent/)).toBeTruthy();
    const bars = screen.getAllByTestId("run-context-bar");
    expect(bars.map((bar) => bar.getAttribute("data-kind"))).toEqual([
      "system",
      "steering",
      "tools",
      "context",
      "conversation",
    ]);
    expect(bars[2]).toHaveTextContent("Tool definitions6,147 tok");
    expect(
      prompt.getByText(/Each block is its share of the request's bytes\./),
    ).toBeTruthy();
    const window = region("Prompt window");
    expect(window.getByText("frame 4")).toBeTruthy();
    expect(window.getByText("15,368 tok in")).toBeTruthy();
    expect(window.queryByText("not recorded block by block")).toBeNull();
    expect(window.getAllByTestId("window-part")).toHaveLength(5);
    // The parts add up to the total the header reads.
    expect(
      window
        .getAllByTestId("window-part")
        .map((part) => Number((part.textContent ?? "").replace(/\D/g, "")))
        .reduce((sum, tokens) => sum + tokens, 0),
    ).toBe(15_368);
    await expectNoAxe(container);
  });

  it("fills the retrieval figures from the assembler's manifest, and leaves the floor it does not record", async () => {
    const { container } = await renderContext({
      context: readOk(runContext({ assemblies: [contextAssembly()] })),
    });
    const stats = region("Retrieval stats");
    const value = (label: string) =>
      stats.getByText(label).nextElementSibling?.textContent;
    expect(value("Candidates scored")).toBe("9");
    expect(value("Admitted")).toBe("4");
    expect(value("Held back")).toBe("5");
    expect(value("Below the floor")).toBe("not recorded");
    expect(value("Headroom left")).toBe("1,400 tok");
    expect(value("Composition digest")).toBe(`sha256:${"b".repeat(64)}`);
    expect(stats.getByText("600 of 2,000 tok")).toBeTruthy();
    await expectNoAxe(container);
  });

  it("names the context read's failure in the Prompt window and keeps the reported total (negative)", async () => {
    const { container } = await renderContext({
      context: readError("frame_store_unreachable", 502),
    });
    const window = region("Prompt window");
    expect(window.getByText("15,368 tok in")).toBeTruthy();
    expect(window.getByText(/frame_store_unreachable/)).toBeTruthy();
    expect(region("Prompt").getByText(/15,368 tok sent/)).toBeTruthy();
    await expectNoAxe(container);
  });
});
