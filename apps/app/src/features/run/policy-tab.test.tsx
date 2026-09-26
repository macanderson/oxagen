// @vitest-environment jsdom
// Rules that fired, on the Policy tab (#3971, ADR-194): each decision prints
// the rules its record names, in the order they were evaluated, and says
// "none" when it names none. Taint has no producer yet, so a decision's null
// taint reads not recorded, while a list a producer did assess prints as
// recorded, "none" included.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "@/data/contracts/run";
import { readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runTranscript, transcriptEntry } from "./run.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { PolicyDecisions } = await import("./policy-tab");

afterEach(cleanup);

const PLACE = { org: "acme", ws: "core-platform", runId: "tse_7k2m9q" };
const AT = "2026-09-23T12:00:00.000Z";

/** One Oxagen decision on the run's own chain, with the rules and taint given. */
function decided(
  seq: string,
  source: string,
  rules: string[],
  taint: string[] | null,
): TranscriptEntry {
  return transcriptEntry({
    seq,
    endSeq: seq,
    type: "policy_decision",
    kind: "frame",
    kinds: ["policy"],
    label: "allow Bash",
    node: "policy",
    subject: "Bash",
    outcome: null,
    decision: {
      seq,
      decision: "allow",
      type: "policy_decision",
      source,
      harness: false,
      rules,
      taint,
      at: AT,
    },
  });
}

function renderRows(entries: TranscriptEntry[]) {
  const view = render(
    <IntlProvider>
      <PolicyDecisions
        read={readOk(runTranscript({ entries }))}
        place={PLACE}
      />
    </IntlProvider>,
  );
  return { ...view, rows: screen.getAllByTestId("run-policy-decision") };
}

describe("Rules that fired", () => {
  it("prints each rule a decision names, in the order they were evaluated", async () => {
    const { container, rows } = renderRows([
      // A compound shell line granted by two permission patterns.
      decided("3", "bundle", ["Bash(git add:*)", "Bash(git commit:*)"], null),
      // A kernel decision rule, by the id its rule set gives it.
      decided("5", "kernel", ["refund-cap"], null),
    ]);
    const [shell, kernel] = rows;
    if (shell === undefined || kernel === undefined)
      throw new Error("two rows");
    const listed = within(shell).getByTestId("policy-rules");
    expect(Array.from(listed.children, (line) => line.textContent)).toEqual([
      "Bash(git add:*)",
      "Bash(git commit:*)",
    ]);
    expect(within(kernel).getByTestId("policy-rules")).toHaveTextContent(
      "refund-cap",
    );
    // A rule lives in a bundle or in the workspace's settings, not as a record
    // with a page, so nothing links to one.
    expect(within(listed).queryByRole("link")).toBeNull();
    await expectNoAxe(container);
  });

  it("says none for a decision that named no rule (negative)", () => {
    const { rows } = renderRows([decided("2", "bundle", [], null)]);
    const [row] = rows;
    if (row === undefined) throw new Error("a row");
    expect(within(row).getByTestId("policy-rules")).toHaveTextContent("none");
  });
});

describe("Taint", () => {
  it("reads not recorded where no producer assessed the inputs (negative)", () => {
    const { rows } = renderRows([decided("2", "bundle", ["Read"], null)]);
    const [row] = rows;
    if (row === undefined) throw new Error("a row");
    expect(within(row).queryByTestId("policy-taint")).toBeNull();
    const cells = within(row).getAllByRole("cell");
    expect(cells[4]?.textContent).toBe("not recorded");
  });

  it("prints the labels a producer assessed, and none when it found none", async () => {
    const { container, rows } = renderRows([
      decided("2", "kernel", ["refund-cap"], ["web_fetch"]),
      decided("4", "kernel", ["refund-cap"], []),
    ]);
    const [tainted, clean] = rows;
    if (tainted === undefined || clean === undefined)
      throw new Error("two rows");
    expect(within(tainted).getByTestId("policy-taint")).toHaveTextContent(
      "web_fetch",
    );
    expect(within(clean).getByTestId("policy-taint")).toHaveTextContent(
      "none",
    );
    await expectNoAxe(container);
  });
});
