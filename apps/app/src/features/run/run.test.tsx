// @vitest-environment jsdom
// The Run page over a fake DataSource: the header, the tab chooser, and each
// of the four sections in its ok, empty, denied and error states, with an axe
// check on every render.
//
// Two rules the tests hold the page to, because breaking either is how a
// console starts lying: only the chosen tab makes its read, and a value the
// contract did not carry reads "not recorded" rather than a zero.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalItem } from "@/data/contracts/approvals";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  runCost,
  runDetail,
  runFrame,
  runFrameBody,
  runRow,
  runSource,
  runTranscript,
  transcriptEntry,
} from "./run.builders";

const notFound = vi.fn();
vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    notFound();
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./actions", () => ({
  haltRun: vi.fn(),
  steerRun: vi.fn(),
  summarizeRun: vi.fn(),
  exportRun: vi.fn(),
}));
vi.mock("next-intl/server", async () => {
  const { translator } = await import("@/test/intl");
  return { getTranslations: (namespace?: string) => translator(namespace) };
});
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Run } = await import("./run");

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

const DENIED = {
  ok: false,
  reason: "denied",
  permission: "run.read",
} as const;
const DOWN = readError("frame_store_unreachable", 502);
const NO_APPROVALS = readOk<ApprovalItem[]>([]);

/** The same workspace seen by an organization Member: `export_run` refuses this role. */
const memberCtx = unsafeMint(WsCtx, {
  userId: "usr_priyanair",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

async function renderRun(
  reads: Parameters<typeof runSource>[0],
  view: {
    tab?: string;
    zoom?: string;
    frames?: string;
    body?: string;
    viewer?: typeof ctx;
  } = {},
) {
  const { source, calls } = runSource(reads);
  const element = await Run({
    ctx: view.viewer ?? ctx,
    source,
    runId: "tse_7k2m9q",
    tab: view.tab ?? null,
    zoom: view.zoom ?? null,
    frames: view.frames ?? null,
    body: view.body ?? null,
  });
  const { container } = render(<IntlProvider>{element}</IntlProvider>);
  return { container, calls };
}

const ok = readOk;

afterEach(() => {
  cleanup();
  notFound.mockClear();
});

describe("header", () => {
  it("leads with the generated name, keeps the id under it, and labels the model's sentence", async () => {
    const { container } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Cut the 3.2 release branch");
    expect(screen.getByText("tse_7k2m9q")).toBeTruthy();
    const summary = screen.getByTestId("generated-summary");
    expect(summary).toHaveTextContent("Cut release/3.2 from main");
    expect(summary).toHaveTextContent("generated");
    expect(summary).toHaveTextContent("Written by z-ai/glm-flash-latest on");
    await expectNoAxe(container);
  });

  it("heads a run with no generated name by its id and says no summary was written", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ name: null, summary: null }) })),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "tse_7k2m9q",
    );
    expect(screen.queryByTestId("generated-summary")).toBeNull();
    expect(
      screen.getByText(/No summary yet\. A sealed run can be summarized/),
    ).toBeTruthy();
  });

  it("reads 'not recorded' for a figure the run does not carry, never a zero", async () => {
    await renderRun({
      detail: ok(
        runDetail({
          run: runRow({
            cost: null,
            turns: null,
            sealedAt: null,
            replayGrade: null,
          }),
        }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getAllByText("not recorded").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("states that a witness run witnessed another and links no further", async () => {
    await renderRun({
      detail: ok(runDetail({ witnessed: true })),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-witnessed")).toHaveTextContent(
      "This run witnessed another run.",
    );
  });
});

describe("controls", () => {
  it("draws pause, resume, steer and cancel on a live wrapped run", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ status: "live" }) })),
      transcript: ok(runTranscript()),
    });
    for (const command of ["pause", "resume", "steer", "cancel"]) {
      expect(screen.getByTestId(`run-${command}`)).not.toBeDisabled();
    }
  });

  it("disables every control on a live ledger run and says why (negative)", async () => {
    await renderRun({
      detail: ok(
        runDetail({ run: runRow({ status: "live", source: "ledger" }) }),
      ),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-pause")).toBeDisabled();
    expect(screen.getByTestId("ledger-no-control")).toHaveTextContent(
      "Oxagen holds no run token it can revoke",
    );
  });

  it("offers no control on a sealed run, and offers the record writes instead", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.queryByTestId("run-pause")).toBeNull();
    expect(screen.getByTestId("run-resummarize")).toBeTruthy();
    expect(screen.getByTestId("run-export")).toBeTruthy();
  });

  it("offers Summarize on a sealed run that has none", async () => {
    await renderRun({
      detail: ok(runDetail({ run: runRow({ name: null, summary: null }) })),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-summarize")).toBeTruthy();
  });

  it("draws Export disabled for an organization Member and says which role it needs (negative)", async () => {
    const { container } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { viewer: memberCtx },
    );
    expect(screen.getByTestId("run-export")).toBeDisabled();
    expect(screen.getByTestId("export-no-role")).toHaveTextContent(
      "Owner or Admin role",
    );
    expect(screen.getByTestId("run-resummarize")).not.toBeDisabled();
    await expectNoAxe(container);
  });

  it("offers Export to an Owner with no reason attached", async () => {
    await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByTestId("run-export")).not.toBeDisabled();
    expect(screen.queryByTestId("export-no-role")).toBeNull();
  });
});

describe("tabs", () => {
  it("opens Transcript by default and reads only that tab", async () => {
    const { calls } = await renderRun({
      detail: ok(runDetail()),
      transcript: ok(runTranscript()),
    });
    expect(screen.getByRole("region", { name: "Transcript" })).toBeTruthy();
    expect(calls.transcript).toHaveLength(1);
    expect(calls.cost).toHaveLength(0);
    expect(calls.approvals).toHaveLength(0);
  });

  it("reads the transcript by steps when the zoom is not a level (negative)", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { zoom: "everything-else" },
    );
    expect(calls.transcript[0]).toEqual([ctx, "tse_7k2m9q", "steps"]);
  });

  it("reads the level the URL asked for", async () => {
    const { calls } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ zoom: "turns" })),
      },
      { zoom: "turns" },
    );
    expect(calls.transcript[0]).toEqual([ctx, "tse_7k2m9q", "turns"]);
  });

  it("opens Transcript for a tab that is not a section (negative)", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "proof" },
    );
    expect(screen.getByRole("region", { name: "Transcript" })).toBeTruthy();
  });
});

describe("transcript", () => {
  it("draws an entry with its span, its body and the cost it folds", async () => {
    const { container } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "transcript" },
    );
    const [entry] = screen.getAllByTestId("transcript-entry");
    expect(entry).toHaveTextContent("Model call");
    expect(entry).toHaveTextContent("frames 11 to 14");
    expect(entry).toHaveTextContent("Cutting release/3.2 from main.");
    await expectNoAxe(container);
  });

  it("says a digest_only entry has nothing to read rather than drawing an empty body", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(
          runTranscript({
            entries: [transcriptEntry({ text: null, fidelity: "digest_only" })],
          }),
        ),
      },
      { tab: "transcript" },
    );
    expect(screen.getByText(/kept a digest and no body/)).toBeTruthy();
  });

  it("links a cut entry to its frame's whole body on the Frames tab", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(
          runTranscript({
            entries: [transcriptEntry({ seq: "37", truncated: true })],
          }),
        ),
      },
      { tab: "transcript" },
    );
    const note = screen.getByTestId("entry-truncated");
    expect(note).toHaveTextContent("Cut at the length one entry carries.");
    expect(
      within(note).getByRole("link", {
        name: "Read the whole body of frame 37",
      }),
    ).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=frames&body=37",
    );
  });

  it("says when the transcript stopped short of the end (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript({ complete: false })),
      },
      { tab: "transcript" },
    );
    expect(screen.getByText(/stops short of the end/)).toBeTruthy();
  });

  it("names its own failure when the transcript read is refused (negative)", async () => {
    await renderRun(
      { detail: ok(runDetail()), transcript: DENIED },
      { tab: "transcript" },
    );
    expect(
      screen.getByRole("region", { name: "Transcript" }),
    ).toHaveTextContent("Your roles do not include run.read");
  });
});

describe("frames", () => {
  it("draws a frame with its digest, stage, body reference and cost", async () => {
    const { container } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "frames" },
    );
    const [row] = screen.getAllByTestId("frame-row");
    expect(row).toHaveTextContent("model.call_completed");
    expect(row).toHaveTextContent("stage act");
    expect(row).toHaveTextContent("sha256:5f2d1c8a");
    expect(row).toHaveTextContent("bytes retained");
    await expectNoAxe(container);
  });

  it("names every redaction by its reason", async () => {
    await renderRun(
      {
        detail: ok(
          runDetail({
            frames: {
              frames: [
                runFrame({
                  body: {
                    digest: "sha256:9a1b4e7c",
                    bytesRef: "blob://x",
                    fidelity: "full",
                    redactions: [
                      {
                        path: "bytes:12-60",
                        reason: "api key",
                        originalDigest: "sha256:cut",
                      },
                    ],
                  },
                }),
              ],
              cursor: null,
              more: false,
            },
          }),
        ),
        transcript: ok(runTranscript()),
      },
      { tab: "frames" },
    );
    expect(screen.getByTestId("frame-redactions")).toHaveTextContent(
      "removed bytes:12-60: api key",
    );
  });

  it("links to the next frame page when the page came back full with a cursor", async () => {
    await renderRun(
      {
        detail: ok(
          runDetail({
            frames: { frames: [runFrame()], cursor: "ZjoyMA", more: true },
          }),
        ),
        transcript: ok(runTranscript()),
      },
      { tab: "frames" },
    );
    expect(screen.getByRole("link", { name: "Later frames" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=frames&frames=ZjoyMA",
    );
  });

  it("links to no later page when the read carried a resume point but the page was short (negative)", async () => {
    await renderRun(
      {
        detail: ok(
          runDetail({
            frames: { frames: [runFrame()], cursor: "ZjoyMA", more: false },
          }),
        ),
        transcript: ok(runTranscript()),
      },
      { tab: "frames" },
    );
    expect(screen.queryByRole("link", { name: "Later frames" })).toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Frame pages" }),
    ).toBeNull();
  });

  it("keeps the way back to the first frames on a later page that came back empty", async () => {
    const { container } = await renderRun(
      {
        detail: ok(
          runDetail({ frames: { frames: [], cursor: null, more: false } }),
        ),
        transcript: ok(runTranscript()),
      },
      { tab: "frames", frames: "ZjoyMA" },
    );
    expect(screen.getByText(/Nothing lies past the frame/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "First frames" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=frames",
    );
    expect(screen.queryByRole("link", { name: "Later frames" })).toBeNull();
    await expectNoAxe(container);
  });

  it("passes the cursor the URL carried to get_run", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "frames", frames: "ZjoyMA" },
    );
    expect(calls.get[0]).toEqual([
      ctx,
      "tse_7k2m9q",
      { framesAfter: "ZjoyMA" },
    ]);
  });

  it("offers to open the body of a frame with retained bytes, and not of a digest_only one", async () => {
    await renderRun(
      {
        detail: ok(
          runDetail({
            frames: {
              frames: [
                runFrame(),
                runFrame({
                  cursor: "ZjoxMg",
                  seq: "12",
                  body: {
                    digest: "sha256:0c1d",
                    bytesRef: null,
                    redactions: [],
                    fidelity: "digest_only",
                  },
                }),
              ],
              cursor: null,
              more: false,
            },
          }),
        ),
        transcript: ok(runTranscript()),
      },
      { tab: "frames", frames: "ZjoxMA" },
    );
    const links = screen.getAllByTestId("frame-open-body");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=frames&frames=ZjoxMA&body=11",
    );
  });

  it("makes no body read when the URL opens no frame", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "frames" },
    );
    expect(calls.frameBody).toHaveLength(0);
    expect(screen.queryByTestId("frame-body")).toBeNull();
  });

  it("makes no body read for a value that is not a frame seq (negative)", async () => {
    const { calls } = await renderRun(
      { detail: ok(runDetail()), transcript: ok(runTranscript()) },
      { tab: "frames", body: "../etc" },
    );
    expect(calls.frameBody).toHaveLength(0);
  });

  it("reads and draws the open frame's body as text, with its digest, type and size", async () => {
    const { calls, container } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        frameBody: ok(runFrameBody()),
      },
      { tab: "frames", frames: "ZjoxMA", body: "11" },
    );
    expect(calls.frameBody[0]).toEqual([ctx, "tse_7k2m9q", "11"]);
    const body = screen.getByTestId("frame-body");
    expect(body).toHaveTextContent("sha256:9a1b4e7c");
    expect(body).toHaveTextContent("application/json");
    expect(body).toHaveTextContent("92 bytes");
    expect(body).toHaveTextContent("Cut release/3.2 from main.");
    expect(screen.getByRole("region", { name: "Frame 11 body" })).toBeTruthy();
    expect(screen.getByTestId("frame-body-close")).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=frames&frames=ZjoxMA",
    );
    await expectNoAxe(container);
  });

  it("says a digest_only frame has no bytes to read rather than drawing an empty box (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        frameBody: ok(
          runFrameBody({ contentType: null, text: null, bytes: null }),
        ),
      },
      { tab: "frames", body: "11" },
    );
    expect(screen.getByTestId("frame-body")).toHaveTextContent(
      "kept this frame's digest and no bytes",
    );
    expect(screen.getByTestId("frame-body")).toHaveTextContent(
      "no bytes retained",
    );
  });

  it("says retained bytes that are not text are not shown, and keeps their size (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        frameBody: ok(
          runFrameBody({ contentType: "image/png", text: null, bytes: 4096 }),
        ),
      },
      { tab: "frames", body: "11" },
    );
    const body = screen.getByTestId("frame-body");
    expect(body).toHaveTextContent("not UTF-8 text");
    expect(body).toHaveTextContent("4,096 bytes");
  });

  it("names the body read's own failure and keeps the frames page beneath it (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        frameBody: readError("not_found", 404),
      },
      { tab: "frames", body: "999" },
    );
    expect(
      screen.getByRole("region", { name: "Frame 999 body" }),
    ).toHaveTextContent("not_found");
    expect(screen.getAllByTestId("frame-row")).toHaveLength(1);
  });
});

describe("cost", () => {
  it("draws the rollup with its basis, its token classes and its price entries", async () => {
    const { container } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        cost: ok(runCost()),
      },
      { tab: "cost" },
    );
    const section = screen.getByRole("region", { name: "Cost" });
    expect(section).toHaveTextContent("gateway_observed");
    expect(section).toHaveTextContent("cache read");
    expect(section).toHaveTextContent("prc_01k4qj9e");
    expect(screen.getByTestId("cost-model-row")).toHaveTextContent(
      "claude-opus-5",
    );
    expect(screen.getByTestId("cost-tool-row")).toHaveTextContent(
      "create_release",
    );
    await expectNoAxe(container);
  });

  it("says the rollup has not run rather than printing zeros (negative)", async () => {
    await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        cost: ok({ rollup: null }),
      },
      { tab: "cost" },
    );
    expect(screen.getByTestId("cost-not-rolled-up")).toHaveTextContent(
      "A zero here would be a measurement",
    );
    expect(screen.queryByTestId("cost-model-row")).toBeNull();
  });
});

describe("policy", () => {
  it("reads the approvals of this run alone and makes no mandate read when none is named", async () => {
    const { calls, container } = await renderRun(
      {
        detail: ok(runDetail()),
        transcript: ok(runTranscript()),
        approvals: NO_APPROVALS,
      },
      { tab: "policy" },
    );
    expect(calls.approvals[0]).toEqual([ctx, { runId: "tse_7k2m9q" }]);
    expect(calls.mandates).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Approvals" })).toBeTruthy();
    await expectNoAxe(container);
  });
});

describe("failures", () => {
  it("is not found when the run is not in this workspace (negative)", async () => {
    await expect(
      renderRun({ detail: readError("run_not_found", 404) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });

  it("names the store that is down and says runs kept recording (negative)", async () => {
    const { container } = await renderRun({ detail: DOWN });
    expect(screen.getByText(/frame_store_unreachable/)).toBeTruthy();
    expect(screen.getByText(/runs kept recording/)).toBeTruthy();
    await expectNoAxe(container);
  });

  it("names the permission a denied viewer lacks (negative)", async () => {
    await renderRun({ detail: DENIED });
    expect(screen.getByText(/Your roles do not include run.read/)).toBeTruthy();
  });
});
