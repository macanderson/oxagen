// @vitest-environment jsdom
// The Chain and seal tab (spec §8.3, §8.4): the panel states the grade the
// seal recorded and nothing stronger, a gap is a fact about the record and
// not a fault to soften, and a value the store did not carry reads "not
// recorded" rather than a blank cell.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChainCheckpoint, RunChain } from "@/data/contracts/run";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { ChainSection } from "./chain";
import { runChain } from "./run.builders";

afterEach(cleanup);

function renderChain(
  read: ReturnType<typeof readOk<RunChain>> | ReturnType<typeof readError>,
) {
  return render(
    <IntlProvider>
      <ChainSection read={read} />
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

describe("ChainSection", () => {
  it("states the recorded grade even where the ladder shows a stronger rung met: the load-bearing honesty test", () => {
    const { container } = renderChain(
      readOk(runChain({ recordedGrade: "view" })),
    );
    // The Replay grade panel's badge is the recorded word, View, never Fork.
    const grade = screen.getByRole("region", { name: "Replay grade" });
    const badge = grade.querySelector("[data-grade]");
    expect(badge).toHaveAttribute("data-grade", "view");
    // Nothing on the page claims the run's grade is Fork, even though the
    // ladder's fork rung is met.
    expect(container.querySelector('[data-grade="fork"]')).toBeNull();
    const forkRung = screen
      .getAllByTestId("chain-rung")
      .find((rung) => rung.textContent.includes("Fork"));
    expect(forkRung).toHaveAttribute("data-met", "true");
  });

  it("renders the no-grade ladder sentence and no grade badge when recordedGrade is null (negative)", () => {
    const { container } = renderChain(
      readOk(runChain({ recordedGrade: null })),
    );
    expect(container.querySelector("[data-grade]")).toBeNull();
    expect(
      screen.getByText(
        "This run's seal recorded no grade, so nothing here states one. The ladder says what the recording holds.",
      ),
    ).toBeInTheDocument();
    // Each rung still says what it allows, and none is stated as the run's.
    expect(screen.getAllByTestId("chain-rung").length).toBeGreaterThan(0);
  });

  it("renders sequence gaps as ranges, a single-sequence gap as one number, and the missing-frame and missing-body counts", () => {
    renderChain(
      readOk(
        runChain({
          complete: true,
          gaps: {
            missingSequences: [
              { from: "12", to: "14" },
              { from: "20", to: "20" },
            ],
            missingFrameCount: 4,
            missingBodies: 2,
            recorded: [],
          },
        }),
      ),
    );
    expect(
      screen.getByText("Missing sequences").nextElementSibling,
    ).toHaveTextContent("12-14, 20");
    expect(
      screen.getByText("Missing frames").nextElementSibling,
    ).toHaveTextContent("4");
    expect(
      screen.getByText("Frames with no retained body").nextElementSibling,
    ).toHaveTextContent("2");
  });

  it("renders the chain-no-gaps line rather than a table of zeros when there is no gap at all", () => {
    renderChain(
      readOk(
        runChain({
          gaps: {
            missingSequences: [],
            missingFrameCount: 0,
            missingBodies: 0,
            recorded: [],
          },
        }),
      ),
    );
    expect(screen.getByTestId("chain-no-gaps")).toHaveTextContent(
      "The walk found no missing sequence and no missing body, and the seal recorded no gap.",
    );
    expect(screen.queryByText("Missing sequences")).toBeNull();
  });

  it("renders the chain-prefix line when the walk stopped before the end of the recording", () => {
    renderChain(readOk(runChain({ complete: false })));
    expect(screen.getByTestId("chain-prefix")).toHaveTextContent(
      "This walk stopped before the end of the recording, so these are the gaps of the part it read, not of the whole run.",
    );
  });

  it("renders the chain-unsealed line and no seal facts when seals is empty (negative)", () => {
    renderChain(readOk(runChain({ seals: [] })));
    expect(screen.getByTestId("chain-unsealed")).toHaveTextContent(
      "This run has no seal yet. A seal is written when the run ends, and it is what an attestation signs.",
    );
    expect(screen.queryByText("Seal")).toBeNull();
    expect(screen.queryByText("Terminal status")).toBeNull();
    // The panel still stands, so a reader sees where the seal will be.
    expect(
      screen.getByRole("region", { name: "Seal and attestation" }),
    ).toBeTruthy();
  });

  it("renders the seal's terminal status, event stream digest and Merkle root, with a null seal Merkle root reading 'not recorded' rather than blank", () => {
    const base = runChain();
    const [firstSeal] = base.seals;
    if (firstSeal === undefined) throw new Error("the fixture carries a seal");
    const chain = runChain({
      seals: [{ ...firstSeal, merkleRoot: null }],
    });
    renderChain(readOk(chain));
    const sealHeading = screen.getByText("Seal");
    const sealSection = sealHeading.closest("div");
    if (sealSection === null) throw new Error("the seal has a section");
    const scoped = within(sealSection);
    expect(
      scoped.getByText("Terminal status").nextElementSibling,
    ).toHaveTextContent("completed");
    expect(scoped.getByText("Signs over").nextElementSibling).toHaveTextContent(
      firstSeal.eventStreamDigest ?? "",
    );
    expect(
      scoped.getByText("Merkle root").nextElementSibling,
    ).toHaveTextContent("not recorded");
  });

  it("labels each seal with its attempt number when a run has more than one (finding 8, negative)", () => {
    const base = runChain();
    const [firstSeal] = base.seals;
    if (firstSeal === undefined) throw new Error("the fixture carries a seal");
    const chain = runChain({
      seals: [
        { ...firstSeal, terminalStatus: "abandoned" },
        { ...firstSeal, terminalStatus: "completed" },
      ],
    });
    renderChain(readOk(chain));
    expect(screen.getByText("Seal of attempt 1")).toBeInTheDocument();
    expect(screen.getByText("Seal of attempt 2")).toBeInTheDocument();
    // No heading carries a colon-joined suffix.
    expect(screen.queryByText(/Seal: /)).not.toBeInTheDocument();
  });

  it("renders the chain-no-checkpoints explanation rather than an empty table when checkpoints is empty", () => {
    renderChain(readOk(runChain({ checkpoints: [] })));
    expect(screen.getByTestId("chain-no-checkpoints")).toHaveTextContent(
      "This recording carries no checkpoint. A ledger run commits at its seal rather than along the way, so there is nothing missing here.",
    );
  });

  it("says a checkpoint's countersignedAt is not recorded rather than rendering an empty cell", () => {
    renderChain(
      readOk(
        runChain({
          checkpoints: [
            { ...CHECKPOINT, countersignedAt: null, platformKey: null },
          ],
        }),
      ),
    );
    const row = screen.getByTestId("chain-checkpoint");
    const cells = within(row).getAllByRole("cell");
    expect(cells[3]).toHaveTextContent("not countersigned");
  });

  it("renders the recorded gap kinds as prose from run.chain.gap.*", () => {
    renderChain(
      readOk(
        runChain({
          gaps: {
            missingSequences: [],
            missingFrameCount: 0,
            missingBodies: 0,
            recorded: ["digest_only", "chain_break"],
          },
        }),
      ),
    );
    const list = screen.getByTestId("chain-recorded-gaps");
    expect(list).toHaveTextContent("digests kept, bodies not retained");
    expect(list).toHaveTextContent("the hash chain does not hold end to end");
  });

  it("renders the ReadFailure treatment for a refused read from the frame store", () => {
    renderChain(readError("frame_store_unreachable", 502));
    expect(
      screen.getByText(
        "Chain and seal could not be loaded: the control plane answered frame_store_unreachable. Nothing was changed, and runs kept recording.",
      ),
    ).toBeInTheDocument();
  });

  it("renders the ReadFailure treatment for a read denied on run.read (negative)", () => {
    render(
      <IntlProvider>
        <ChainSection
          read={{ ok: false, reason: "denied", permission: "run.read" }}
        />
      </IntlProvider>,
    );
    expect(
      screen.getByText(
        "You cannot see Chain and seal in this workspace. Your roles do not include run.read; an organization owner can grant it.",
      ),
    ).toBeInTheDocument();
  });

  it("passes an axe check on the loaded render", async () => {
    const { container } = renderChain(readOk(runChain()));
    await expectNoAxe(container);
  });
});
