// @vitest-environment jsdom
// The Policy tab (mockup `pRun`, the policy branch) and `entriesOf`, which the
// tab strip counts with: one row per decision frame, Frame, Call and Outcome
// from the record, and the rules, taint and latency the transcript does not
// carry said to be not recorded rather than guessed. A frame on a subagent's
// chain is named and not linked, a list read short says it is a prefix, and a
// failed read says it failed.
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
const { entriesOf } = await import("./sections");

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
    decision: {
      seq,
      ...(chainRef === undefined ? {} : { chainRef }),
      decision: "deny",
      type: "policy_decision",
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

  it("links the run's own decision and names a subagent's without a link, because the player reads the run's chain", () => {
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
    expect(within(own).getByRole("link", { name: "4" })).toBeTruthy();
    expect(within(subagent).queryByRole("link", { name: "4" })).toBeNull();
    expect(within(subagent).getByText("4")).toBeTruthy();
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
