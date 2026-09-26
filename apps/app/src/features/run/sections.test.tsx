// @vitest-environment jsdom
// The Policy tab (mockup `pRun`, the policy branch) and `entriesOf`, which the
// tab strip counts with: one row per decision frame, Frame, Call and Outcome
// from the record, and the rules, taint and latency the transcript does not
// carry said to be not recorded rather than guessed. A frame on a subagent's
// chain links by its chain and seq, a list read short says it is a prefix, and
// a failed read says it failed.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runTranscript, transcriptEntry } from "./run.builders";
import { evidenceTranscript } from "./sections.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { PolicyDecisions } = await import("./policy-tab");
const { entriesOf } = await import("./recorded-entries");

afterEach(cleanup);

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };
const CHAIN = "0192d4a8-7c1e-7a00-8000-0000000000c1";
const AT = "2026-09-23T12:00:00.000Z";

const policyEntry = (seq: string, chainRef?: string) =>
  transcriptEntry({
    seq,
    endSeq: seq,
    type: "policy_decision",
    kind: "frame",
    kinds: ["policy"],
    label: "deny Bash",
    // The call the decision was made on, as the server states it; the page
    // reads no label.
    node: "policy",
    subject: "Bash",
    outcome: "denied",
    decision: {
      seq,
      ...(chainRef === undefined ? {} : { chainRef }),
      decision: "deny",
      type: "policy_decision",
      harness: false,
      at: AT,
    },
    ...(chainRef === undefined
      ? {}
      : { subagent: { chainRef, type: "Explore" } }),
  });

function renderPolicy(read: Parameters<typeof PolicyDecisions>[0]["read"]) {
  return render(
    <IntlProvider>
      <PolicyDecisions read={read} place={PLACE} />
    </IntlProvider>,
  );
}

describe("PolicyDecisions", () => {
  it("draws the design's six columns, one row per decision, with the call, the outcome and the frame link", async () => {
    const { container } = renderPolicy(readOk(evidenceTranscript()));
    const table = screen.getByRole("table", { name: "Policy decisions" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([
      "Frame",
      "Call",
      "Outcome",
      "Rules that fired",
      "Taint",
      "Latency",
    ]);
    const rows = screen.getAllByTestId("run-policy-decision");
    expect(rows).toHaveLength(2);
    const [allow, ask] = rows;
    if (allow === undefined || ask === undefined) throw new Error("two rows");
    expect(within(allow).getByRole("link", { name: "7" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=7",
    );
    expect(within(allow).getByText("github__list_pull_requests")).toBeTruthy();
    expect(within(allow).getByText("allow")).toBeTruthy();
    expect(within(ask).getByText("github__create_release")).toBeTruthy();
    expect(within(ask).getByText("ask")).toBeTruthy();
    await expectNoAxe(container);
  });

  it("says the rules, taint and latency are not recorded rather than drawing a guess (negative)", () => {
    renderPolicy(readOk(evidenceTranscript()));
    const [row] = screen.getAllByTestId("run-policy-decision");
    if (row === undefined) throw new Error("a row");
    const cells = within(row).getAllByRole("cell");
    expect(cells.slice(3).map((cell) => cell.textContent)).toEqual([
      "not recorded",
      "not recorded",
      "not recorded",
    ]);
    expect(screen.queryByText(/\d+ ms/)).toBeNull();
    expect(screen.getByText(/not on the transcript yet/)).toBeTruthy();
  });

  it("links the run's own decision by its seq and a subagent's by its chain and seq (#3823)", () => {
    renderPolicy(
      readOk(
        runTranscript({
          entries: [policyEntry("4"), policyEntry("4", CHAIN)],
        }),
      ),
    );
    const [own, subagent] = screen.getAllByTestId("run-policy-decision");
    if (own === undefined || subagent === undefined)
      throw new Error("two rows");
    expect(within(own).getByRole("link", { name: "4" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=4",
    );
    // The subagent's frame 4 is not the run's frame 4: the link names both.
    expect(within(subagent).getByRole("link", { name: "4" })).toHaveAttribute(
      "href",
      `/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=${CHAIN}%3A4`,
    );
    expect(within(own).getByText("Bash")).toBeTruthy();
    expect(within(own).getByText("deny")).toBeTruthy();
    expect(
      screen.queryByText(
        "The transcript read stopped short, so later decisions are missing here.",
      ),
    ).toBeNull();
  });

  it("says the list is a prefix when another page lies past it (negative)", () => {
    renderPolicy(
      readOk(runTranscript({ entries: [policyEntry("4")], cursor: "dDo0MQ" })),
    );
    expect(
      screen.getByText(
        "The transcript read stopped short, so later decisions are missing here.",
      ),
    ).toBeTruthy();
  });

  it("says there is nothing to list when the run recorded no decision", () => {
    renderPolicy(readOk(runTranscript({ entries: [transcriptEntry()] })));
    expect(
      screen.getByText("No policy decision was recorded on this run."),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("lists a policy entry with no decision folded in by its own frame and type, and says the call and outcome were not recorded (negative)", () => {
    const bare = (seq: string, chainRef?: string) =>
      transcriptEntry({
        seq,
        endSeq: seq,
        type: "policy_decision",
        kind: "frame",
        kinds: ["policy"],
        // `policy deny` names a decision and no call.
        label: "policy deny",
        decision: null,
        ...(chainRef === undefined
          ? {}
          : { subagent: { chainRef, type: "Explore" } }),
      });
    renderPolicy(
      readOk(runTranscript({ entries: [bare("9"), bare("9", CHAIN)] })),
    );
    const [own, subagent] = screen.getAllByTestId("run-policy-decision");
    if (own === undefined || subagent === undefined)
      throw new Error("two rows");
    expect(within(own).getByRole("link", { name: "9" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=9",
    );
    // The entry's own chain decides the link when no decision names one.
    expect(within(subagent).getByRole("link", { name: "9" })).toHaveAttribute(
      "href",
      `/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=${CHAIN}%3A9`,
    );
    for (const row of [own, subagent]) {
      const cells = within(row).getAllByRole("cell");
      expect(cells[1]).toHaveTextContent("not recordedpolicy_decision");
      expect(cells[2]).toHaveTextContent(/^not recorded$/);
    }
  });

  it.each<[string, string]>([
    ["approval", "text-info"],
    ["approve", "text-info"],
    ["ask", "text-info"],
    ["allow", "text-success"],
    ["deny", "text-warning"],
    ["route", "text-muted-foreground"],
  ])(
    "draws a %s decision in its state's hue, and a word it does not know as a quiet fact",
    (word, hue) => {
      renderPolicy(
        readOk(
          runTranscript({
            entries: [
              transcriptEntry({
                seq: "4",
                endSeq: "4",
                type: "policy_decision",
                kind: "frame",
                kinds: ["policy"],
                label: `${word} Bash`,
                decision: {
                  seq: "4",
                  decision: word,
                  type: "policy_decision",
                  harness: false,
                  at: AT,
                },
              }),
            ],
          }),
        ),
      );
      const [row] = screen.getAllByTestId("run-policy-decision");
      if (row === undefined) throw new Error("a row");
      expect(within(row).getByText(word).className).toContain(hue);
    },
  );

  it("shows the read failure instead of a list (negative)", () => {
    renderPolicy(readError("frame_store_unreachable", 502));
    expect(
      screen.queryByText("No policy decision was recorded on this run."),
    ).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      within(
        screen.getByRole("region", { name: "Policy decisions" }),
      ).getByText(/frame_store_unreachable|could not|failed/i),
    ).toBeTruthy();
  });
});

describe("entriesOf", () => {
  it("narrows the whole-run read to one chip, and answers null for a failed read rather than an empty list", () => {
    const read = readOk(evidenceTranscript());
    expect(entriesOf(read, "policy")?.map((entry) => entry.seq)).toEqual([
      "7",
      "10",
    ]);
    expect(entriesOf(read, "recall")?.map((entry) => entry.seq)).toEqual([
      "1",
      "2",
    ]);
    expect(entriesOf(readError("frame_store_unreachable", 502), "policy")).toBe(
      null,
    );
  });
});

describe("PolicyDecisions by who decided", () => {
  const decided = (
    seq: string,
    decision: string,
    source: string | null,
    label = "Bash",
    harness = false,
  ) =>
    transcriptEntry({
      seq,
      endSeq: seq,
      type: source === "human" ? "oxagen:command_applied" : "policy_decision",
      kind: "frame",
      kinds: ["policy"],
      label: `${decision} ${label}`,
      decision: {
        seq,
        decision,
        type: source === "human" ? "command" : "policy_decision",
        at: AT,
        harness,
        ...(source === null ? {} : { source }),
      },
    });
  /** A decision the server read as the harness checking itself. */
  const checked = (seq: string, source: string) =>
    decided(seq, "allow", source, "Bash", true);

  it("lists Oxagen policy and operator decisions with who decided, and folds the harness's own checks below", async () => {
    const { container } = renderPolicy(
      readOk(
        runTranscript({
          entries: [
            decided("3", "deny", "bundle"),
            checked("5", "harness"),
            checked("6", "managed_settings"),
            decided("8", "pause", "human", "run"),
          ],
        }),
      ),
    );
    const table = screen.getByRole("table", { name: "Policy decisions" });
    const rows = within(table).getAllByTestId("run-policy-decision");
    expect(rows).toHaveLength(2);
    expect(
      rows.map(
        (row) => within(row).getByTestId("policy-decided-by").textContent,
      ),
    ).toEqual(["decided by Oxagen policy", "decided by an operator"]);
    const checks = screen.getByTestId("harness-checks");
    expect(checks).not.toHaveAttribute("open");
    expect(within(checks).getByText("2 harness checks")).toBeTruthy();
    const folded = within(checks).getAllByTestId("run-policy-decision");
    expect(
      folded.map(
        (row) => within(row).getByTestId("policy-decided-by").textContent,
      ),
    ).toEqual(["decided by the agent harness", "decided by managed settings"]);
    await expectNoAxe(container);
  });

  it("says only the harness decided when neither Oxagen nor an operator did (negative)", () => {
    renderPolicy(readOk(runTranscript({ entries: [checked("5", "harness")] })));
    expect(
      screen.getByText(
        "Neither Oxagen policy nor an operator made a decision on this run. The agent harness's own checks are listed below.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("table", { name: "Policy decisions" }),
    ).toBeNull();
    expect(screen.getByText("1 harness check")).toBeTruthy();
  });

  it("says who decided is not recorded, and prints a source word it has no name for as recorded (negative)", () => {
    renderPolicy(
      readOk(
        runTranscript({
          entries: [
            decided("3", "deny", null),
            decided("4", "deny", "sandbox"),
          ],
        }),
      ),
    );
    expect(
      screen
        .getAllByTestId("policy-decided-by")
        .map((line) => line.textContent),
    ).toEqual(["who decided is not recorded", "decided by sandbox"]);
    expect(screen.queryByTestId("harness-checks")).toBeNull();
  });

  it("folds away only what the server said is the harness, whatever the source word reads (negative)", () => {
    renderPolicy(
      readOk(
        runTranscript({
          entries: [
            // The server owns which sources are the harness (ADR-182). A
            // source word the page happens to recognise does not fold a
            // decision the server did not mark.
            decided("3", "allow", "harness"),
            decided("4", "allow", "sandbox", "Bash", true),
          ],
        }),
      ),
    );
    const table = screen.getByRole("table", { name: "Policy decisions" });
    expect(
      within(table)
        .getAllByTestId("policy-decided-by")
        .map((line) => line.textContent),
    ).toEqual(["decided by the agent harness"]);
    const checks = screen.getByTestId("harness-checks");
    expect(within(checks).getByText("1 harness check")).toBeTruthy();
    expect(within(checks).getByTestId("policy-decided-by").textContent).toBe(
      "decided by sandbox",
    );
  });
});
