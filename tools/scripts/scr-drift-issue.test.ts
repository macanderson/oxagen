/**
 * The negative control is the whole point: an issue that merely *mentions* the
 * marker's words must not be treated as the drift issue. That is exactly what
 * happened in #2666, where a phrase search matched an unrelated issue and the
 * job overwrote its body.
 */
import { describe, expect, it } from "vitest";
import { dodStatus } from "./scr-dod-check.mjs";
import {
  DRIFT_DOD_ITEMS,
  MARKER,
  confirmMarkedIssues,
  decideCloseAction,
  decideDriftAction,
  driftDodSection,
  prepareDriftClose,
} from "./scr-drift-issue.mjs";

/** Bodies keyed by issue number, standing in for the issues API. */
function reader(bodies: Record<number, string | null>) {
  return async (n: number) => bodies[n] ?? null;
}

describe("confirmMarkedIssues", () => {
  it("keeps an issue whose body carries the marker", async () => {
    const got = await confirmMarkedIssues(
      [{ number: 1328 }],
      reader({ 1328: `${MARKER}\nThe corpus has drifted.` }),
    );
    expect(got).toEqual([1328]);
  });

  it("drops an issue that only mentions the marker's words", async () => {
    // The #2666 case. Search tokenises the marker, so prose like this matched
    // and the job replaced the issue's entire body.
    const got = await confirmMarkedIssues(
      [{ number: 1336 }],
      reader({
        1336: "Three repos call the DoD workflows on @main. See scr corpus drift.",
      }),
    );
    expect(got).toEqual([]);
  });

  it("keeps only the marked issue when search returns both", async () => {
    const got = await confirmMarkedIssues(
      [{ number: 1336 }, { number: 1328 }],
      reader({
        1336: "prose about scr corpus drift, no marker",
        1328: `${MARKER} real report`,
      }),
    );
    expect(got).toEqual([1328]);
  });

  it("drops an issue that quotes the marker in a code span", async () => {
    // The #2699 case, verbatim in shape: an issue asking for the close-on-green
    // behaviour has to say which marker to match, and says it in backticks.
    // Counting it made two issues carry the marker, which aborted the job and
    // left main red (run 34172143469).
    const got = await confirmMarkedIssues(
      [{ number: 2699 }],
      reader({
        2699: [
          "## What to do",
          "",
          "1. Look for an open issue that has the `" +
            MARKER +
            "` marker in its body.",
          "2. Close that issue.",
        ].join("\n"),
      }),
    );
    expect(got).toEqual([]);
  });

  it("drops an issue that quotes the marker in a fenced block", async () => {
    const got = await confirmMarkedIssues(
      [{ number: 2699 }],
      reader({
        2699: ["The body starts with:", "", "```html", MARKER, "```"].join(
          "\n",
        ),
      }),
    );
    expect(got).toEqual([]);
  });

  it("keeps the real report and drops the issue documenting it", async () => {
    // Both are open at once today: #2673 reports a drift, #2699 describes the
    // check. Exactly one carries the marker as a claim.
    const got = await confirmMarkedIssues(
      [{ number: 2673 }, { number: 2699 }],
      reader({
        2673: `${MARKER}\n### Context\n\nThe SCR corpus has drifted.`,
        2699: "Look for an issue with the `" + MARKER + "` marker.",
      }),
    );
    expect(got).toEqual([2673]);
  });

  it("still keeps a marker that follows a code span in the same body", async () => {
    // Stripping must not swallow the rest of the body: a real report that also
    // quotes something in backticks is still a real report.
    const got = await confirmMarkedIssues(
      [{ number: 1328 }],
      reader({
        1328: `${MARKER}\n\ndiffers: \`docs/scr/README.md\` (\`b8d610cb\` vs \`129f01bb\`)`,
      }),
    );
    expect(got).toEqual([1328]);
  });

  it("survives an issue with no body at all", async () => {
    const got = await confirmMarkedIssues([{ number: 7 }], reader({ 7: null }));
    expect(got).toEqual([]);
  });

  it("treats no candidates as nothing confirmed", async () => {
    expect(await confirmMarkedIssues([], reader({}))).toEqual([]);
    expect(await confirmMarkedIssues(undefined, reader({}))).toEqual([]);
  });
});

describe("decideDriftAction", () => {
  it("updates the one marked issue", () => {
    expect(decideDriftAction([1328])).toEqual({
      action: "update",
      number: 1328,
    });
  });

  it("files a new issue when none is marked", () => {
    expect(decideDriftAction([])).toEqual({ action: "create" });
  });

  it("aborts rather than choosing between two marked issues", () => {
    // Picking one silently orphans the other — the same class of mistake as
    // acting on an unverified search hit.
    const got = decideDriftAction([1328, 1400]);
    expect(got.action).toBe("abort");
    expect(got.reason).toContain("1328");
    expect(got.reason).toContain("1400");
  });

  it("never tells the reader to just close one", () => {
    // The old message's whole instruction was "Close all but one", and one of
    // the two is often a live issue that only quotes the marker. Naming the
    // destructive remedy alone is what invites it (#2706, same shape).
    const { reason } = decideDriftAction([2673, 2699]);
    expect(reason).toMatch(/backticks/);
    expect(reason).toMatch(/genuine duplicate/);
    expect(reason).not.toMatch(/Close all but one/);
  });
});

describe("decideCloseAction", () => {
  it("closes the one marked issue once the corpus is clean", () => {
    expect(decideCloseAction([2673])).toEqual({
      action: "close",
      number: 2673,
    });
  });

  it("does nothing when no issue is marked", () => {
    expect(decideCloseAction([])).toEqual({ action: "noop" });
  });

  it("aborts rather than closing two marked issues", () => {
    // Closing both could close a live issue that carries the marker by
    // mistake. The reader gets the same instructions as the filing step.
    const got = decideCloseAction([2673, 2699]);
    expect(got.action).toBe("abort");
    expect(got.reason).toContain("2673");
    expect(got.reason).toContain("2699");
    expect(got.reason).toMatch(/backticks/);
  });

  it("never closes an issue that only quotes the marker in backticks", async () => {
    // The #2699 shape on the close path: the report is gone and the issue
    // documenting the check is still open. It must survive a green run.
    const confirmed = await confirmMarkedIssues(
      [{ number: 2699 }],
      reader({
        2699: "Look for an open issue with the `" + MARKER + "` marker.",
      }),
    );
    expect(decideCloseAction(confirmed)).toEqual({ action: "noop" });
  });

  it("closes the real report and leaves the documenting issue open", async () => {
    const confirmed = await confirmMarkedIssues(
      [{ number: 2673 }, { number: 2699 }],
      reader({
        2673: `${MARKER}\n### Context\n\nThe SCR corpus has drifted.`,
        2699: "Look for an issue with the `" + MARKER + "` marker.",
      }),
    );
    expect(decideCloseAction(confirmed)).toEqual({
      action: "close",
      number: 2673,
    });
  });
});

describe("prepareDriftClose", () => {
  const filed = [
    MARKER,
    "### Context",
    "",
    "Drift.",
    "",
    driftDodSection(),
  ].join("\n");

  it("files a DoD the gate can read, every box unticked", () => {
    const status = dodStatus(filed);
    expect(status.present).toBe(true);
    // dodStatus reads prose only, so the item text loses its code spans.
    expect(status.unchecked).toHaveLength(DRIFT_DOD_ITEMS.length);
  });

  it("ticks every item a green run verifies and allows the close", () => {
    const got = prepareDriftClose(filed);
    expect(got.changed).toBe(true);
    expect(got.close).toBe(true);
    expect(got.unchecked).toEqual([]);
    for (const item of DRIFT_DOD_ITEMS)
      expect(got.body).toContain(`- [x] ${item}`);
    expect(got.body).not.toContain("- [ ]");
  });

  it("keeps open an older issue whose DoD holds an item no run verifies", () => {
    // The residue item the filing step used to write. Closing this as
    // completed with the box empty is what SCR-003 forbids.
    const older = `${filed}\n- [ ] Residue filed as new issues (triage label only)`;
    const got = prepareDriftClose(older);
    expect(got.close).toBe(false);
    expect(got.unchecked).toEqual([
      "Residue filed as new issues (triage label only)",
    ]);
    for (const item of DRIFT_DOD_ITEMS)
      expect(got.body).toContain(`- [x] ${item}`);
  });

  it("closes once a person has ticked the item no run verifies", () => {
    const done = `${filed}\n- [x] Residue filed as new issues (triage label only)`;
    expect(prepareDriftClose(done).close).toBe(true);
  });

  it("ticks a CRLF body without dropping its line endings", () => {
    const crlf = filed.replaceAll("\n", "\r\n");
    const got = prepareDriftClose(crlf);
    expect(got.body).toBe(crlf.replaceAll("- [ ]", "- [x]"));
  });

  it("never closes an issue with no definition of done", () => {
    const got = prepareDriftClose(`${MARKER}\nDrift.`);
    expect(got.changed).toBe(false);
    expect(got.close).toBe(false);
    expect(prepareDriftClose(null).close).toBe(false);
  });
});
