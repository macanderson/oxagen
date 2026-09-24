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
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  runDetail,
  runFrameBody,
  runRow,
  runSource,
  runTranscript,
  transcriptEntry,
} from "./run.builders";
import {
  evidenceTranscript,
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
  run = runRow(),
  frameBody,
}: {
  everything?: Read<RunTranscript>;
  run?: ReturnType<typeof runRow>;
  frameBody?: Read<ReturnType<typeof runFrameBody>>;
} = {}) {
  const { source, calls } = runSource({
    detail: readOk(runDetail({ run })),
    ...(frameBody === undefined ? {} : { frameBody }),
  });
  const body = await ContextTab(tabProps({ ctx, source, run, everything }));
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
    expect(screen.getByTestId("run-manifest-tally")).toHaveTextContent(
      "3 rendered · 5 cut · 435 tok",
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

  it("reads a manifest the transcript cut at its ceiling from the frame's own bytes", async () => {
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
      frameBody: readOk(runFrameBody({ seq: "1", text: manifestText() })),
    });
    expect(calls.frameBody).toEqual([[ctx, "tse_7k2m9q", "1"]]);
    expect(screen.getByTestId("run-manifest-tally")).toHaveTextContent(
      "3 rendered · 5 cut · 435 tok",
    );
  });

  it("says a manifest whose body was not retained has no items to show, and reads nothing more (negative)", async () => {
    const digestOnly = evidenceTranscript();
    const entries = digestOnly.entries.map((entry) =>
      entry.type === "steering.manifest" && entry.response !== null
        ? {
            ...entry,
            response: {
              ...entry.response,
              text: null,
              fidelity: "digest_only" as const,
            },
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

  it("says the manifest could not be read when the frame body read fails (negative)", async () => {
    await renderContext({
      everything: readOk(evidenceTranscript({}, null)),
      frameBody: readError("frame_store_unreachable", 502),
    });
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
    const quiet = evidenceTranscript();
    await renderContext({
      everything: readOk({
        ...quiet,
        entries: quiet.entries.filter((entry) => entry.kind !== "model_call"),
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
      "435",
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
      "steering.manifest seq 1435 tok",
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
    expect(stats.getByRole("link", { name: "2" })).toBeTruthy();
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
});
