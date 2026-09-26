// @vitest-environment jsdom
// The Chain and seal tab (mockup `chainTab`; spec §8.3, §8.4): four panels
// over `get_run_chain`. The tab states the grade the seal recorded and
// nothing stronger, a gap is a fact about the record and not a fault to
// soften, a value the read does not carry reads "not recorded", and its three
// actions keep the role and grade gates the header's copies keep.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChainCheckpoint, RunChain } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import { readError, readOk } from "@/data/read";
import type { Read } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runChain, runRow, runSource } from "./run.builders";
import { tabProps } from "./sections.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({
  forkRun: vi.fn(),
  bisectRuns: vi.fn(),
  exportRun: vi.fn(),
  readRunExport: vi.fn(),
  summarizeRun: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { ChainSection, ChainTab } = await import("./chain");

afterEach(cleanup);

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };

function renderChain(
  read: Read<RunChain>,
  {
    run = runRow(),
    orgRole = "owner",
    fromSeq = null,
  }: {
    run?: RunRow;
    orgRole?: "owner" | "admin" | "member" | "viewer";
    fromSeq?: string | null;
  } = {},
) {
  return render(
    <IntlProvider>
      <ChainSection
        read={read}
        run={run}
        place={PLACE}
        orgRole={orgRole}
        fromSeq={fromSeq}
      />
    </IntlProvider>,
  );
}

const CHECKPOINT: ChainCheckpoint = {
  seq: "200",
  chainHead: `sha256:${"d".repeat(64)}`,
  eventCount: 200,
  signedAt: "2026-09-15T08:30:00.000Z",
  deviceKeyFingerprint: "ed25519:2f:91:aa",
  platformKey: "pk_01k4qj9e",
  countersignedAt: "2026-09-15T08:30:10.000Z",
  anchorRoot: null,
  anchoredAt: null,
};

const panel = (name: string) => within(screen.getByRole("region", { name }));

describe("ChainSection", () => {
  it("draws the four panels of the design in order, with the hash rule and the frame range", async () => {
    const { container } = renderChain(readOk(runChain()));
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      "Hash chain",
      "Seal and attestation",
      "Replay grade",
      "Checkpoints",
    ]);
    const hash = panel("Hash chain");
    expect(hash.getByText("431 read · seq 1 to 431")).toBeTruthy();
    expect(hash.getByText("tacho.sha256_prev_hash_v1")).toBeTruthy();
    expect(hash.getByText("no gaps")).toBeTruthy();
    expect(hash.getByTestId("chain-no-gaps")).toHaveTextContent("none found");
    // A wrapped agent's frames are client-attested, and the note says so.
    expect(hash.getByText(/client-attested/)).toBeTruthy();
    await expectNoAxe(container);
  });

  it("states the recorded grade even where the ladder shows a stronger rung reached: the load-bearing honesty test", () => {
    renderChain(readOk(runChain({ recordedGrade: "view" })));
    const grade = panel("Replay grade");
    // The aside states the recorded word, and only the recorded rung is highlighted.
    expect(grade.getByText("view", { selector: "[data-grade]" })).toBeTruthy();
    const recorded = screen
      .getAllByTestId("chain-rung")
      .filter((row) => row.dataset.recorded === "true");
    expect(recorded.map((row) => row.querySelector("td")?.textContent)).toEqual(
      ["view"],
    );
    // The fork rung is reached on what the read could see, and the table says so without raising the grade.
    const fork = screen
      .getAllByTestId("chain-rung")
      .find((row) => row.textContent.startsWith("fork"));
    expect(fork?.dataset.met).toBe("true");
    expect(fork?.dataset.recorded).toBeUndefined();
    expect(grade.queryByText("fork", { selector: "[data-grade]" })).toBeNull();
  });

  it("says no grade was recorded rather than stating one (negative)", () => {
    renderChain(readOk(runChain({ recordedGrade: null })));
    const grade = panel("Replay grade");
    expect(grade.getByText("not recorded")).toBeTruthy();
    expect(grade.getByText(/recorded no grade/)).toBeTruthy();
    expect(
      screen
        .getAllByTestId("chain-rung")
        .some((row) => row.dataset.recorded === "true"),
    ).toBe(false);
  });

  it("names each gap the walk found and the seal recorded, and marks the chain as having gaps", () => {
    renderChain(
      readOk(
        runChain({
          gaps: {
            missingSequences: [
              { from: "12", to: "19" },
              { from: "40", to: "40" },
            ],
            missingFrameCount: 9,
            missingBodies: 3,
            recorded: ["telemetry_gap", "tool_bodies"],
          },
        }),
      ),
    );
    const hash = panel("Hash chain");
    expect(hash.getByText("gaps found")).toBeTruthy();
    expect(hash.getByText("9 missing frames:")).toBeTruthy();
    expect(hash.getByText("12-19, 40")).toBeTruthy();
    expect(hash.getByText("3 frames with no retained body")).toBeTruthy();
    expect(
      hash.getAllByTestId("chain-recorded-gap").map((item) => item.textContent),
    ).toEqual([
      "telemetry stopped for part of the run",
      "no tool result body was retained",
    ]);
    expect(hash.getByText("the seal recorded a telemetry gap")).toBeTruthy();
  });

  it("names only the gaps the record carries: bodies lost with no frame lost, and frames lost with every body kept", () => {
    const clean = runChain().gaps;
    renderChain(readOk(runChain({ gaps: { ...clean, missingBodies: 2 } })));
    const bodies = within(screen.getByTestId("chain-gaps"));
    expect(bodies.getByText("2 frames with no retained body")).toBeTruthy();
    expect(bodies.queryByText(/missing frames/)).toBeNull();
    cleanup();
    renderChain(
      readOk(
        runChain({
          gaps: {
            ...clean,
            missingSequences: [{ from: "7", to: "7" }],
            missingFrameCount: 1,
          },
        }),
      ),
    );
    const frames = within(screen.getByTestId("chain-gaps"));
    expect(frames.getByText("1 missing frames:")).toBeTruthy();
    expect(frames.getByText("7")).toBeTruthy();
    expect(frames.queryByText(/no retained body/)).toBeNull();
  });

  it("counts the frames without a range when the read names no first or last frame (negative)", () => {
    renderChain(readOk(runChain({ firstSeq: null, lastSeq: null })));
    const frames = panel("Hash chain").getByText("Frames").nextElementSibling;
    expect(frames).toHaveTextContent(/^431 read$/);
  });

  it("says a seal field the ledger did not carry is not recorded, and takes the chain's root when the seal names none (negative)", () => {
    const [seal] = runChain().seals;
    if (seal === undefined) throw new Error("fixture has a seal");
    const bare = {
      ...seal,
      finalRunSeq: null,
      finalEventDigest: null,
      eventStreamDigest: null,
      merkleRoot: null,
    };
    renderChain(readOk(runChain({ seals: [bare] })));
    const facts = panel("Seal and attestation");
    for (const label of [
      "Final sequence",
      "Final frame digest",
      "Event stream digest",
    ])
      expect(facts.getByText(label).nextElementSibling).toHaveTextContent(
        "not recorded",
      );
    expect(facts.getByText("Merkle root").nextElementSibling).toHaveTextContent(
      `sha256:${"c".repeat(64)}`,
    );
    cleanup();
    renderChain(readOk(runChain({ seals: [bare], merkleRoot: null })));
    expect(
      panel("Seal and attestation").getByText("Merkle root").nextElementSibling,
    ).toHaveTextContent("not recorded");
  });

  it("says an attempt's root is not recorded when that seal carries none (negative)", () => {
    const [seal] = runChain().seals;
    if (seal === undefined) throw new Error("fixture has a seal");
    renderChain(
      readOk(
        runChain({
          seals: [
            seal,
            {
              ...seal,
              sealedAt: "2026-09-15T08:58:00.000Z",
              merkleRoot: null,
            },
          ],
        }),
      ),
    );
    const [, second] = screen.getAllByTestId("chain-attempt");
    if (second === undefined) throw new Error("two attempts");
    expect(
      within(second).getByText("Merkle root").nextElementSibling,
    ).toHaveTextContent("not recorded");
  });

  it("draws a countersignature with no platform key named, and the root a checkpoint was anchored in", () => {
    renderChain(
      readOk(
        runChain({
          checkpoints: [
            {
              ...CHECKPOINT,
              platformKey: null,
              anchorRoot: `sha256:${"9".repeat(64)}`,
              anchoredAt: "2026-09-15T08:40:00.000Z",
            },
          ],
        }),
      ),
    );
    const [row] = screen.getAllByTestId("chain-checkpoint");
    if (row === undefined) throw new Error("a row");
    expect(within(row).getByText("countersigned")).toBeTruthy();
    expect(within(row).queryByText("pk_01k4qj9e")).toBeNull();
    expect(
      within(row).getByText(`anchored in sha256:${"9".repeat(64)}`),
    ).toBeTruthy();
  });

  it("says the gaps are a prefix's when the walk stopped short (negative)", () => {
    renderChain(readOk(runChain({ complete: false })));
    expect(screen.getByTestId("chain-prefix")).toBeTruthy();
    expect(
      panel("Hash chain").getByText("no gaps in the part read"),
    ).toBeTruthy();
  });

  it("draws the seal's recorded fields and says an unsigned seal carries no signature, never a guessed key (negative)", () => {
    renderChain(readOk(runChain()));
    const seal = panel("Seal and attestation");
    expect(seal.getByText("sealed")).toBeTruthy();
    for (const label of ["Signature", "Signs over"]) {
      const value = seal.getByText(label).nextElementSibling;
      expect(value).toHaveTextContent("not recorded");
      expect(value?.querySelector("[title]")).toHaveAttribute(
        "title",
        "The seal was written with no attester key, or before seals were signed.",
      );
    }
    expect(screen.queryByTestId("chain-signature")).toBeNull();
    expect(seal.getByText(`sha256:${"c".repeat(64)}`)).toBeTruthy();
    expect(
      seal.getByText("Archive segment").nextElementSibling,
    ).toHaveTextContent("not recorded");
    expect(seal.getByText("completed")).toBeTruthy();
    expect(seal.getByText("431 frames")).toBeTruthy();
    expect(seal.getByText("harness")).toBeTruthy();
  });

  describe("the seal's attestation (ADR-195)", () => {
    const SIGNED: NonNullable<RunChain["seals"][number]["attestation"]> = {
      alg: "ed25519",
      keyRef: "3f9a0c21d4e8b765",
      sig: "c2lnbmVkIGF0IHNlYWwgdGltZQ==",
      signsOver: [
        "run_id",
        "attempt_id",
        "frame_count",
        "merkle_root",
        "archive_segment_digest",
        "enforcement_tier",
        "completeness_gaps",
        "replay_grade",
      ],
    };

    function signedChain() {
      const [seal] = runChain().seals;
      if (seal === undefined) throw new Error("fixture has a seal");
      return runChain({
        seals: [
          {
            ...seal,
            archiveSegmentRef: "evidence/o/w/segments/a/f.ndjson.zst",
            archiveSegmentDigest: `sha256:${"9".repeat(64)}`,
            attestation: SIGNED,
          },
        ],
      });
    }

    it("names the key and the signature the seal wrote, and the fields it signs", async () => {
      const { container } = renderChain(readOk(signedChain()));
      const seal = panel("Seal and attestation");
      expect(screen.getByTestId("chain-signature")).toHaveTextContent(
        "ed25519 key 3f9a0c21d4e8b765",
      );
      expect(seal.getByText("Signature").nextElementSibling).toHaveTextContent(
        SIGNED.sig,
      );
      expect(seal.getByText("Signs over").nextElementSibling).toHaveTextContent(
        "run_id, attempt_id, frame_count, merkle_root, archive_segment_digest, enforcement_tier, completeness_gaps, replay_grade",
      );
      expect(seal.queryByText("not recorded", { exact: false })).toBeNull();
      await expectNoAxe(container);
    });

    it("draws each attempt's own signature when a run was retried: the first unsigned, the second signed", () => {
      const [seal] = runChain().seals;
      if (seal === undefined) throw new Error("fixture has a seal");
      renderChain(
        readOk(
          runChain({
            seals: [
              seal,
              {
                ...seal,
                sealedAt: "2026-09-15T08:58:00.000Z",
                attestation: SIGNED,
              },
            ],
          }),
        ),
      );
      const [first, second] = screen.getAllByTestId("chain-attempt");
      if (first === undefined || second === undefined)
        throw new Error("two attempts");
      expect(
        within(first).getByText("Signature").nextElementSibling,
      ).toHaveTextContent("not recorded");
      expect(within(second).getByTestId("chain-signature")).toHaveTextContent(
        "ed25519 key 3f9a0c21d4e8b765",
      );
    });
  });

  describe("a compacted run (ADR-058, #4000)", () => {
    it("says the run is read from its archive segment, above the four panels", async () => {
      const { container } = renderChain(readOk(runChain()), {
        run: runRow({ id: "arun_5f0c", source: "ledger", compacted: true }),
      });
      const note = screen.getByTestId("chain-compacted");
      expect(note).toHaveTextContent(
        "Compacted. This run is read from its archive segment.",
      );
      expect(note.querySelector("b")).toHaveTextContent("Compacted.");
      expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(4);
      await expectNoAxe(container);
    });

    it("draws no note on a run whose frames are still in the log, or a wrapped session (negative)", () => {
      renderChain(readOk(runChain()), {
        run: runRow({ id: "arun_5f0c", source: "ledger", compacted: false }),
      });
      expect(screen.queryByTestId("chain-compacted")).toBeNull();
      cleanup();
      renderChain(readOk(runChain()));
      expect(screen.queryByTestId("chain-compacted")).toBeNull();
    });

    it("draws no note over a chain it could not read (negative)", () => {
      renderChain(readError("frame_store_unreachable", 502), {
        run: runRow({ id: "arun_5f0c", source: "ledger", compacted: true }),
      });
      expect(screen.queryByTestId("chain-compacted")).toBeNull();
    });
  });

  it("says a live run has no seal yet and draws no seal facts (negative)", () => {
    renderChain(readOk(runChain({ seals: [], merkleRoot: null })), {
      run: runRow({ status: "live", sealedAt: null }),
    });
    expect(screen.getByTestId("chain-unsealed")).toBeTruthy();
    expect(screen.queryByTestId("chain-seals")).toBeNull();
    expect(panel("Hash chain").getByText("counted at the seal")).toBeTruthy();
  });

  it("labels each seal with its attempt when a run was retried", () => {
    const [seal] = runChain().seals;
    if (seal === undefined) throw new Error("fixture has a seal");
    renderChain(
      readOk(
        runChain({
          seals: [seal, { ...seal, sealedAt: "2026-09-15T08:58:00.000Z" }],
        }),
      ),
    );
    expect(
      screen
        .getAllByTestId("chain-attempt")
        .map((node) => node.querySelector("h4")?.textContent),
    ).toEqual(["Attempt 1", "Attempt 2"]);
  });

  it("lists each checkpoint with its frame link, short chain head, coverage and signature", () => {
    renderChain(
      readOk(
        runChain({
          checkpoints: [
            CHECKPOINT,
            {
              ...CHECKPOINT,
              seq: "400",
              chainHead: `sha256:${"7".repeat(64)}`,
              eventCount: 400,
              countersignedAt: null,
              platformKey: null,
            },
          ],
        }),
      ),
    );
    const rows = screen.getAllByTestId("chain-checkpoint");
    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    if (first === undefined || second === undefined)
      throw new Error("two rows");
    expect(within(first).getByRole("link", { name: "200" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=200",
    );
    expect(within(first).getByText("dddddddd…")).toHaveAttribute(
      "title",
      CHECKPOINT.chainHead,
    );
    expect(within(first).getByText("countersigned")).toBeTruthy();
    expect(within(first).getByText("pk_01k4qj9e")).toBeTruthy();
    expect(
      within(second).getByTestId("chain-not-countersigned"),
    ).toHaveTextContent("host signed");
    expect(
      panel("Hash chain").getByText(
        "2 signed by the host device key, 1 countersigned by Oxagen at ingest",
      ),
    ).toBeTruthy();
  });

  it("says a ledger run commits at its seal rather than drawing an empty checkpoint table", () => {
    renderChain(
      readOk(
        runChain({
          hashRule: "ledger.event_stream_digest_v1",
          checkpoints: [],
        }),
      ),
    );
    expect(screen.getByTestId("chain-no-checkpoints")).toHaveTextContent(
      "commits at its seal",
    );
    expect(
      panel("Hash chain").getByText("ledger.event_stream_digest_v1"),
    ).toBeTruthy();
    expect(
      panel("Hash chain").getByText("none, a ledger run commits at its seal"),
    ).toBeTruthy();
  });

  it("offers bisect, fork from the open frame and the export on a sealed ledger run graded fork", () => {
    renderChain(readOk(runChain()), {
      run: runRow({ source: "ledger", replayGrade: "fork" }),
      fromSeq: "15",
    });
    expect(screen.getByTestId("chain-bisect")).toHaveTextContent(
      "Bisect against another run",
    );
    expect(screen.getByTestId("chain-fork")).toHaveTextContent(
      "Fork replay from frame 15",
    );
    expect(screen.getByTestId("chain-fork")).not.toBeDisabled();
    expect(screen.getByTestId("chain-export")).toHaveTextContent(
      "Export the bundle",
    );
    expect(screen.getByTestId("chain-export")).not.toBeDisabled();
  });

  it("keeps the fork's grade gate and the export's role gate, with the reason on the button (negative)", () => {
    renderChain(readOk(runChain()), {
      run: runRow({ source: "tacho", replayGrade: "fork" }),
      orgRole: "member",
    });
    expect(screen.getByTestId("chain-fork")).toBeDisabled();
    expect(screen.getByTestId("chain-fork")).toHaveTextContent(
      "Fork replay from a frame",
    );
    expect(screen.getByTestId("chain-fork-refused")).toHaveTextContent(
      "wrapped agent",
    );
    expect(screen.getByTestId("chain-export")).toBeDisabled();
    expect(screen.getByTestId("chain-export-refused")).toHaveTextContent(
      "Owner or Admin",
    );
  });

  it("offers no bisect on a live run (negative)", () => {
    renderChain(readOk(runChain({ seals: [] })), {
      run: runRow({ status: "live", sealedAt: null }),
    });
    expect(screen.queryByTestId("chain-bisect")).toBeNull();
    expect(screen.getByTestId("chain-fork")).toBeDisabled();
  });

  it("names a refused read and draws no panel of a chain it could not read (negative)", async () => {
    const { container } = renderChain({
      ok: false,
      reason: "denied",
      permission: "run.read",
    });
    expect(screen.getByText(/run\.read/)).toBeTruthy();
    expect(screen.queryByTestId("chain-checkpoint")).toBeNull();
    expect(screen.queryByRole("region", { name: "Hash chain" })).toBeNull();
    await expectNoAxe(container);
  });

  it("names a failed read from the frame store (negative)", () => {
    renderChain(readError("frame_store_unreachable", 502));
    expect(screen.getByTestId("chain-failure")).toBeTruthy();
    expect(screen.queryByTestId("chain-rung")).toBeNull();
  });
});

describe("ChainTab", () => {
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

  it("reads the chain once, for this run, and starts the fork from the frame the page has open", async () => {
    const { source, calls } = runSource({
      detail: readOk({
        run: runRow(),
        frames: { frames: [], cursor: null, more: false },
        witnessed: false,
      }),
      chain: readOk(runChain()),
    });
    const body = await ChainTab(
      tabProps({
        ctx,
        source,
        run: runRow({ source: "ledger", replayGrade: "fork" }),
        body: "41",
      }),
    );
    render(<IntlProvider>{body}</IntlProvider>);
    expect(calls.chain).toEqual([[ctx, "tse_7k2m9q"]]);
    expect(screen.getByTestId("chain-fork")).toHaveTextContent(
      "Fork replay from frame 41",
    );
  });
});
