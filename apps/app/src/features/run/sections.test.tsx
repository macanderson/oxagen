// @vitest-environment jsdom
// The Policy and Context tabs: each lists the entries of its own chip, links a
// frame on the run's own chain, names a subagent's frame without a link (the
// Frames tab reads the run's chain, where that seq is a different frame), and
// says the list is a prefix whenever another page lies past it.
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runRow, runTranscript, transcriptEntry } from "./run.builders";

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
    expect(screen.queryByText(/later decisions are missing/)).toBeNull();
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
    expect(
      within(container).getByText(
        "The transcript read stopped short, so later decisions are missing here.",
      ),
    ).toBeTruthy();
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

describe("ContextSection", () => {
  it("links the run's own recall, names a subagent's without a link, and marks a cut list", async () => {
    const { container } = render(
      <IntlProvider>
        <ContextSection
          run={runRow()}
          manifest={null}
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
    expect(
      within(container).getByText(
        "The transcript read stopped short, so later recalls are missing here.",
      ),
    ).toBeTruthy();
    await expectNoAxe(container);
  });

  it("says there is nothing to list, and shows a failed read instead of a list", () => {
    const empty = render(
      <IntlProvider>
        <ContextSection
          run={runRow()}
          manifest={null}
          read={readOk(runTranscript({ entries: [], cursor: null }))}
          place={PLACE}
        />
      </IntlProvider>,
    );
    expect(empty.container.querySelector("table")).toBeNull();
    expect(
      within(empty.container).getByText("This run recorded no recall."),
    ).toBeTruthy();
    cleanup();
    const failed = render(
      <IntlProvider>
        <ContextSection
          run={runRow()}
          manifest={null}
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
