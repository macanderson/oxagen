// @vitest-environment jsdom
// The Policy and Context tabs: each lists the entries of its own chip, links a
// frame on the run's own chain, names a subagent's frame without a link (the
// Frames tab reads the run's chain, where that seq is a different frame), and
// says the list is a prefix whenever another page lies past it. Policy leads
// with Oxagen and operator decisions and folds the harness's checks away.
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runTranscript, transcriptEntry } from "./run.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const { ContextSection, PolicySection } = await import("./sections");

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
    label: `deny Bash`,
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

/** A decision with a recorded source and outcome, on the run's own chain. */
const sourcedEntry = (
  seq: string,
  source: string | null,
  decision: string,
  type = "policy_decision",
) =>
  transcriptEntry({
    seq,
    endSeq: seq,
    type,
    kind: "frame",
    kinds: ["policy"],
    label: `${decision} Bash`,
    decision: { seq, decision, type, source, at: AT },
  });

const recallEntry = (seq: string, chainRef?: string) =>
  transcriptEntry({
    seq,
    endSeq: seq,
    type: "context.assembled",
    kind: "frame",
    kinds: ["recall"],
    label: "rows=3",
    decision: null,
    ...(chainRef === undefined
      ? {}
      : { subagent: { chainRef, type: "Explore" } }),
  });

describe("PolicySection", () => {
  it("links the run's own decision, names a subagent's without a link, and says nothing is cut when the read is whole", async () => {
    const { container } = render(
      <IntlProvider>
        <PolicySection
          read={readOk(
            runTranscript({
              entries: [policyEntry("4"), policyEntry("4", CHAIN)],
              cursor: null,
              complete: true,
            }),
          )}
          place={PLACE}
        />
      </IntlProvider>,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const [own, subagent] = rows;
    if (own === undefined || subagent === undefined)
      throw new Error("expected two rows");
    expect(within(own).queryByRole("link")).not.toBeNull();
    expect(within(subagent).queryByRole("link")).toBeNull();
    expect(rows[1]?.textContent).toContain("4");
    expect(screen.queryByText(/prefix|first|cut/i)).toBeNull();
    await expectNoAxe(container);
  });

  it("says the list is a prefix when another page lies past it", () => {
    const { container } = render(
      <IntlProvider>
        <PolicySection
          read={readOk(
            runTranscript({
              entries: [policyEntry("4")],
              cursor: "t:4",
              complete: true,
            }),
          )}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(container.querySelector("p.pt-3")).not.toBeNull();
  });

  it("shows the read failure instead of a list", () => {
    const { container } = render(
      <IntlProvider>
        <PolicySection
          read={readError("frame_store_unreachable", 502)}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(container.querySelector("table")).toBeNull();
  });
});

// Oxagen policy and operator decisions lead, and the harness's own
// permission checks fold below them (#4023).
describe("PolicySection by who decided", () => {
  it("lists Oxagen and operator decisions and folds harness checks away", async () => {
    const { container } = render(
      <IntlProvider>
        <PolicySection
          read={readOk(
            runTranscript({
              entries: [
                sourcedEntry("2", "harness", "allow"),
                sourcedEntry("3", "bundle", "deny"),
                sourcedEntry("4", "managed_settings", "allow"),
                sourcedEntry("5", "human", "pause", "oxagen:command_applied"),
              ],
              cursor: null,
              complete: true,
            }),
          )}
          place={PLACE}
        />
      </IntlProvider>,
    );
    const lead = screen.getByRole("table", { name: "Policy decisions" });
    const rows = within(lead).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Oxagen policy"),
      expect.stringContaining("Operator"),
    ]);
    expect(rows[1]?.textContent).toContain("pause");
    expect(rows[1]?.textContent).toContain("oxagen:command_applied");
    const checks = screen.getByTestId("harness-checks");
    expect(checks).not.toHaveAttribute("open");
    expect(checks.querySelector("summary")?.textContent).toBe(
      "2 harness checks",
    );
    expect(
      within(checks).getAllByRole("row", { hidden: true }).slice(1),
    ).toHaveLength(2);
    await expectNoAxe(container);
  });

  it("says only harness checks were recorded when nothing else decided", () => {
    const { container } = render(
      <IntlProvider>
        <PolicySection
          read={readOk(
            runTranscript({
              entries: [sourcedEntry("2", "harness", "allow")],
              cursor: null,
              complete: true,
            }),
          )}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(container.textContent).toContain(
      "Neither Oxagen policy nor an operator made a decision on this run.",
    );
    expect(screen.getByTestId("harness-checks")).toBeInTheDocument();
  });

  it("keeps a decision with no recorded source in the lead list", () => {
    render(
      <IntlProvider>
        <PolicySection
          read={readOk(
            runTranscript({
              entries: [sourcedEntry("2", null, "allow")],
              cursor: null,
              complete: true,
            }),
          )}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(screen.getAllByRole("row").slice(1)[0]?.textContent).toContain(
      "Not recorded",
    );
    expect(screen.queryByTestId("harness-checks")).toBeNull();
  });
});

describe("ContextSection", () => {
  it("links the run's own recall, names a subagent's without a link, and marks a cut list", async () => {
    const { container } = render(
      <IntlProvider>
        <ContextSection
          read={readOk(
            runTranscript({
              entries: [recallEntry("7"), recallEntry("2", CHAIN)],
              cursor: null,
              complete: false,
            }),
          )}
          place={PLACE}
        />
      </IntlProvider>,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const [own, subagent] = rows;
    if (own === undefined || subagent === undefined)
      throw new Error("expected two rows");
    expect(within(own).queryByRole("link")).not.toBeNull();
    expect(within(subagent).queryByRole("link")).toBeNull();
    expect(container.querySelector("p.pt-3")).not.toBeNull();
    await expectNoAxe(container);
  });

  it("says there is nothing to list, and shows a failed read instead of a list", () => {
    const empty = render(
      <IntlProvider>
        <ContextSection
          read={readOk(runTranscript({ entries: [], cursor: null }))}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(empty.container.querySelector("table")).toBeNull();
    cleanup();
    const failed = render(
      <IntlProvider>
        <ContextSection
          read={readError("frame_store_unreachable", 502)}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(failed.container.querySelector("table")).toBeNull();
  });
});

describe("PolicySection with no decisions", () => {
  it("says there is nothing to list", () => {
    const { container } = render(
      <IntlProvider>
        <PolicySection
          read={readOk(runTranscript({ entries: [], cursor: null }))}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent.length).toBeGreaterThan(0);
  });
});
