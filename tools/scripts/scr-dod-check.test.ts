import { describe, expect, it } from "vitest";
import {
  closeExemptFromDod,
  CLOSES_NOTHING_LABEL,
  dodStatus,
  ESCAPE_HATCH_LABEL,
  formatVerdict,
  linkedIssues,
  referencedIssues,
  referencesIssue,
  verdict,
} from "./scr-dod-check.mjs";

/** The DoD block the task issue template ships, all items still open. */
const TASK_TEMPLATE_BODY = `### Context

Why this exists.

### Definition of done

- [ ] Implementation complete
- [ ] Scoped tests added/updated and passing
- [ ] Full CI green
- [ ] Code comments and docs updated
- [ ] Residue filed as new issues (triage label only)`;

const allChecked = TASK_TEMPLATE_BODY.replace(/- \[ \]/g, "- [x]");

describe("linkedIssues", () => {
  it("finds a same-repo closing reference", () => {
    expect(linkedIssues("Closes #1321")).toEqual([
      { owner: null, repo: null, number: 1321 },
    ]);
  });

  it("accepts every closing keyword GitHub honours, case-insensitively", () => {
    for (const keyword of ["Closes", "fixes", "RESOLVED", "Fix", "close"]) {
      expect(linkedIssues(`${keyword} #7`)).toHaveLength(1);
    }
  });

  it("finds cross-repo closing references with their owner and repo", () => {
    expect(linkedIssues("Fixes macanderson/stella#5128")).toEqual([
      { owner: "macanderson", repo: "stella", number: 5128 },
    ]);
  });

  it("ignores a bare mention that claims no close", () => {
    // "Related to #99" is context, not a claim to close; judging that PR
    // against #99's DoD would block merges on somebody else's checklist.
    expect(linkedIssues("Related to #99. See also #100.")).toEqual([]);
  });

  it("ignores closing keywords inside fenced code and HTML comments", () => {
    const body = [
      "```",
      "git commit -m 'closes #123'",
      "```",
      "<!-- Closes #456 -->",
    ].join("\n");
    expect(linkedIssues(body)).toEqual([]);
  });

  it("deduplicates a repeated reference to one issue", () => {
    expect(linkedIssues("Closes #12 and also closes #12")).toHaveLength(1);
  });

  it("returns nothing for an empty or missing body", () => {
    expect(linkedIssues("")).toEqual([]);
    expect(linkedIssues(null)).toEqual([]);
  });

  // oxagen#2636: a PR that explicitly *disclaims* closing an issue is not
  // claiming to close it, the same principle already applied above to a bare
  // "Related to #99" mention.
  it("ignores a closing keyword the sentence explicitly negates (the oxagen#2636 repro)", () => {
    // The exact repro from the issue body. Fails on the old parser (returns
    // a match for #2412); must return [] once negation is honoured.
    expect(linkedIssues("(this PR does not close #2412 — see below)")).toEqual(
      [],
    );
  });

  it("ignores several other negated phrasings", () => {
    for (const body of [
      "This never closes #5.",
      "Won't fix #5 in this PR.",
      "doesn't resolve #5 yet.",
      "cannot close #5 without a follow-up.",
      "This PR doesn't fix #5.",
    ]) {
      expect(linkedIssues(body)).toEqual([]);
    }
  });

  it("still finds a real close in the same sentence as an unrelated negation", () => {
    // The negation window is clause-scoped so an earlier "not" cannot
    // swallow a later, real closing reference.
    expect(linkedIssues("This PR does not close #1, but closes #2.")).toEqual([
      { owner: null, repo: null, number: 2 },
    ]);
  });

  it("does not treat a negation from an unrelated leading clause as applying to the close", () => {
    expect(linkedIssues("Not now, but this closes #100.")).toEqual([
      { owner: null, repo: null, number: 100 },
    ]);
  });
});

describe("referencedIssues", () => {
  it("finds a same-repo Refs reference", () => {
    expect(referencedIssues("Refs #4151")).toEqual([
      { owner: null, repo: null, number: 4151 },
    ]);
  });

  it("accepts the singular Ref spelling, case-insensitively", () => {
    expect(referencedIssues("ref #7")).toHaveLength(1);
    expect(referencedIssues("REF #7")).toHaveLength(1);
  });

  it("finds a cross-repo Refs reference with its owner and repo", () => {
    expect(referencedIssues("Refs macanderson/stella#4151")).toEqual([
      { owner: "macanderson", repo: "stella", number: 4151 },
    ]);
  });

  it("does not match a closing keyword", () => {
    expect(referencedIssues("Closes #1321")).toEqual([]);
  });

  it("does not match the word 'references' as a bare mention", () => {
    // "references" is a different word than "ref"/"refs"; a word-boundary
    // match must not fire inside it.
    expect(referencedIssues("See the references section for #99.")).toEqual([]);
  });

  it("returns nothing for an empty or missing body", () => {
    expect(referencedIssues("")).toEqual([]);
    expect(referencedIssues(null)).toEqual([]);
  });
});

describe("dodStatus", () => {
  it("reports every unchecked item from the task template", () => {
    const status = dodStatus(TASK_TEMPLATE_BODY);
    expect(status.present).toBe(true);
    expect(status.checked).toBe(0);
    expect(status.unchecked).toHaveLength(5);
    expect(status.unchecked[0]).toBe("Implementation complete");
  });

  it("reports a fully ticked DoD as having nothing outstanding", () => {
    const status = dodStatus(allChecked);
    expect(status.present).toBe(true);
    expect(status.checked).toBe(5);
    expect(status.unchecked).toEqual([]);
  });

  it("accepts an uppercase [X] as checked", () => {
    expect(dodStatus("### Definition of done\n- [X] done").unchecked).toEqual(
      [],
    );
  });

  it("marks a body with no DoD section as absent rather than satisfied", () => {
    // The distinction matters: "no DoD" must fail the check, so an issue filed
    // outside the template cannot be closed by merging past an empty checklist.
    expect(dodStatus("### Context\n\nJust prose.").present).toBe(false);
  });

  it("counts only the DoD section, not task lists elsewhere in the body", () => {
    const body = [
      "### Context",
      "- [ ] an option we considered and rejected",
      "",
      "### Definition of done",
      "- [x] the only item that counts",
      "",
      "### Notes",
      "- [ ] a stray box in a later section",
    ].join("\n");
    const status = dodStatus(body);
    expect(status.checked).toBe(1);
    expect(status.unchecked).toEqual([]);
  });

  it("finds the DoD when it is a bold label rather than a heading", () => {
    const status = dodStatus("**Definition of done**\n- [ ] something");
    expect(status.present).toBe(true);
    expect(status.unchecked).toEqual(["something"]);
  });

  // oxagen#1407. The witness: against the single-heading regex every spelling
  // below except the first returns `present: false`, which is what failed PRs
  // whose linked issue does state its done conditions.
  describe("the done-condition headings this corpus actually uses (oxagen#1407)", () => {
    const spellings = [
      "Definition of done",
      "Done means",
      "Done when",
      "What done looks like",
      'What "done" looks like',
      "what 'done' looks like",
      "DONE WHEN",
    ];

    for (const spelling of spellings) {
      it(`reads a section headed "${spelling}"`, () => {
        const status = dodStatus(`## ${spelling}\n\n- [ ] the one item`);
        expect(status.present).toBe(true);
        expect(status.unchecked).toEqual(["the one item"]);
      });
    }

    // The recorded decision (oxagen#1407 asks for it explicitly): bare `Done`
    // is short enough to head a section written for some other purpose, and
    // reading the wrong checklist as the DoD is the failure direction this
    // gate exists to prevent. Those issues fail loudly and get told what to
    // edit, which costs their closer one edit.
    it("does not accept a bare `Done` heading", () => {
      expect(dodStatus("## Done\n- [ ] shipped").present).toBe(false);
    });

    it("does not treat a mention of the phrase in prose as a section", () => {
      const status = dodStatus(
        "We never agreed the definition of done here.\n\n- [ ] a stray box",
      );
      expect(status.present).toBe(false);
      expect(status.heading).toBeNull();
    });
  });

  // The half that makes widening the headings safe. `verdict` passes on
  // `unchecked.length === 0`, so a recognised section holding no checkboxes
  // would be a gate that cannot fail — and the `Done when` cohort writes its
  // conditions as plain bullets. The hole predates the widening: a canonical
  // heading over prose already passed verifying nothing.
  describe("a section with no checkboxes is not a checklist", () => {
    it("rejects a recognised heading whose items are plain bullets", () => {
      const status = dodStatus(
        "## Done when\n\n- the parser is fixed\n- a test covers it",
      );
      expect(status.present).toBe(false);
    });

    it("rejects the canonical heading over prose, which passed before", () => {
      expect(dodStatus("## Definition of done\n\nIt works.").present).toBe(
        false,
      );
    });

    it("still reports which heading it found, so the fix can be named", () => {
      const status = dodStatus("## Done when\n\n- the parser is fixed");
      expect(status.heading).toBe("Done when");
    });

    it("reports no heading at all when none is recognised", () => {
      expect(dodStatus("### Context\n\nJust prose.").heading).toBeNull();
    });
  });

  // Widening the heading set lets one issue carry two of them, and a hand
  // migration is what produces that (stella#5193 moved 60 issues onto the
  // canonical heading). Reading only the first match fails the migrated issue
  // on its leftover prose section while its ticked checklist sits below.
  describe("an issue carrying more than one recognised section", () => {
    const migrated = [
      "## Done when",
      "",
      "- the parser is fixed",
      "- a test covers it",
      "",
      "## Definition of done",
      "",
      "- [x] the parser is fixed",
      "- [x] a test covers it",
    ].join("\n");

    it("reads the checklist below a leftover prose section", () => {
      const status = dodStatus(migrated);
      expect(status.present).toBe(true);
      expect(status.checked).toBe(2);
      expect(status.unchecked).toEqual([]);
      expect(status.heading).toBe("Definition of done");
    });

    it("does not block a PR closing a half-migrated issue", () => {
      const result = verdict({ body: "Closes #1321", labels: [] }, [
        { ref: "#1321", body: migrated },
      ]);
      expect(result.ok).toBe(true);
      expect(result.reasons).toEqual([]);
    });

    it("holds every recognised checklist against the close", () => {
      // The conservative direction: a ticked canonical section cannot excuse
      // an unticked legacy one, so aggregating never passes what a
      // single-section read would have failed.
      const status = dodStatus(
        "## Done when\n\n- [ ] the legacy item\n\n" +
          "## Definition of done\n\n- [x] the new item",
      );
      expect(status.present).toBe(true);
      expect(status.unchecked).toEqual(["the legacy item"]);
    });

    it("counts a checkbox once when a bold label sits inside a section", () => {
      // A bold label does not close the `##` section holding it, so the same
      // physical line is inside two matched sections.
      const status = dodStatus(
        "## Definition of done\n\n**Done when**\n\n- [ ] the only item",
      );
      expect(status.unchecked).toEqual(["the only item"]);
    });

    it("still reports the first heading when no section holds a box", () => {
      const status = dodStatus(
        "## Done when\n\n- prose\n\n## Done means\n\n- more prose",
      );
      expect(status.present).toBe(false);
      expect(status.heading).toBe("Done when");
    });
  });
});

describe("verdict", () => {
  const issue = (body: string) => [{ ref: "#1321", body }];

  it("fails a PR that links no issue and explains all three remedies", () => {
    const result = verdict({ body: "Small tidy-up.", labels: [] }, []);
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain("links no issue");
    expect(result.reasons[0]).toContain("Closes");
    expect(result.reasons[0]).toContain("Refs");
    expect(result.reasons[0]).toContain(ESCAPE_HATCH_LABEL);
  });

  it("waives the whole check for a labelled trivial change", () => {
    const result = verdict(
      { body: "Bump a pinned digest.", labels: [ESCAPE_HATCH_LABEL] },
      [],
    );
    expect(result.ok).toBe(true);
    expect(result.waived).toBe(true);
  });

  // oxagen#2640: a PR that correctly advances an issue without finishing it
  // (`Refs #N`) must have a real passing state, not just the two escape
  // hatches (a real close, or the trivial-change label).
  it("passes a Refs-only PR without requiring the referenced issue's DoD", () => {
    const result = verdict(
      { body: "Refs #4151", labels: [] },
      // No issues resolved for verdict() to check — a Refs-only PR is never
      // gated on a DoD, so the caller (dod-check.yml) never even fetches one.
      [],
    );
    expect(result.ok).toBe(true);
    expect(result.waived).toBe(false);
    expect(result.refsOnly).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("gates only the closed issue when a PR both closes one and references another", () => {
    // `#1321` closes and must be fully checked; `#4151` is only referenced
    // and is never even looked up by dod-check.yml's caller, so it is not
    // part of the `issues` argument here either.
    const result = verdict(
      { body: "Closes #1321\nRefs #4151", labels: [] },
      issue(allChecked),
    );
    expect(result.ok).toBe(true);
    expect(result.refsOnly).toBe(false);
  });

  it("still fails a Closes-plus-Refs PR when the closed issue's DoD is unchecked", () => {
    const result = verdict(
      { body: "Closes #1321\nRefs #4151", labels: [] },
      issue(TASK_TEMPLATE_BODY),
    );
    expect(result.ok).toBe(false);
    expect(result.refsOnly).toBe(false);
  });

  it("does not treat a negated close as Refs-only when nothing else links the PR", () => {
    // oxagen#2636's fix must not silently create an oxagen#2640 pass: a PR
    // whose only issue mention is a negated close links nothing at all and
    // must still fail with the "links no issue" remedy, not slip through as
    // a Refs-only pass.
    const result = verdict(
      { body: "(this PR does not close #2412 — see below)", labels: [] },
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.refsOnly).toBe(false);
    expect(result.reasons[0]).toContain("links no issue");
  });

  it("fails when the linked issue still has unchecked DoD items", () => {
    const result = verdict(
      { body: "Closes #1321", labels: [] },
      issue(TASK_TEMPLATE_BODY),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain("5 unchecked DoD item(s)");
    // The reviewer should see *which* items, not just a count.
    expect(result.reasons[0]).toContain("Residue filed as new issues");
  });

  it("passes when every linked issue's DoD is fully checked", () => {
    const result = verdict(
      { body: "Closes #1321", labels: [] },
      issue(allChecked),
    );
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails when a linked issue has no DoD section at all", () => {
    const result = verdict(
      { body: "Closes #1321", labels: [] },
      issue("### Context\n\nFiled by hand, no template."),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain("states no done conditions");
  });

  it("passes when the linked issue states its DoD under an older heading", () => {
    // oxagen#1407: this is the PR that used to go red for a reason unrelated
    // to its diff, on an issue that does say what done means.
    const result = verdict(
      { body: "Closes #1321", labels: [] },
      issue(
        "## Done when\n\n- [x] the parser is fixed\n- [x] a test covers it",
      ),
    );
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("still fails an older-heading issue whose boxes are not all ticked", () => {
    const result = verdict(
      { body: "Closes #1321", labels: [] },
      issue(
        "## Done when\n\n- [x] the parser is fixed\n- [ ] a test covers it",
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain("1 unchecked DoD item(s)");
    expect(result.reasons[0]).toContain("a test covers it");
  });

  it("fails a recognised section that holds no checkboxes at all", () => {
    // Without this the widened heading set would hand the whole `Done when`
    // cohort a gate that cannot fail: no boxes means nothing unchecked.
    const result = verdict(
      { body: "Closes #1321", labels: [] },
      issue("## Done when\n\n- the parser is fixed\n- a test covers it"),
    );
    expect(result.ok).toBe(false);
  });

  // oxagen#1400. The old message named the one remedy that must not be taken
  // ("refile it") and omitted the one that should. These pin the replacement,
  // because the message is the entire interface of this gate.
  describe("the failure message names the edit to make (oxagen#1400)", () => {
    const reasonFor = (body: string) =>
      verdict({ body: "Closes #1321", labels: [] }, issue(body)).reasons[0];

    const noSection = () => reasonFor("### Context\n\nFiled by hand.");
    const noBoxes = () => reasonFor("## Done when\n\n- the parser is fixed");

    it("never tells the author to refile the issue", () => {
      expect(noSection()).not.toContain("refile");
      expect(noBoxes()).not.toContain("refile");
    });

    it("says the edit goes on the issue, not on the PR", () => {
      expect(noSection()).toContain("Edit the ISSUE (not this PR)");
      expect(noBoxes()).toContain("Edit the ISSUE (not this PR)");
    });

    it("says explicitly that closing and reopening is not the remedy", () => {
      expect(noSection()).toContain("Do NOT close and reopen");
      expect(noBoxes()).toContain("Do NOT close and reopen");
    });

    it("names the conversion for an issue whose conditions are prose", () => {
      expect(noSection()).toContain("convert that paragraph into boxes");
      expect(noSection()).toContain("Done means");
    });

    it("distinguishes a missing section from one holding no boxes", () => {
      // The second has a mechanical fix — rewrite these bullets — and the
      // first does not, so collapsing them costs the reader the fix.
      expect(noBoxes()).toContain('"Done when" section');
      expect(noBoxes()).toContain("nothing in it is a checkbox");
      expect(noSection()).not.toContain("nothing in it is a checkbox");
    });
  });

  it("reports every failing issue when a PR closes several", () => {
    const result = verdict({ body: "Closes #1 and closes #2", labels: [] }, [
      { ref: "#1", body: TASK_TEMPLATE_BODY },
      { ref: "#2", body: allChecked },
    ]);
    expect(result.ok).toBe(false);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("#1");
  });
});

describe("formatVerdict", () => {
  it("names the waiving label so the waiver is visible in the PR thread", () => {
    expect(formatVerdict({ ok: true, waived: true, reasons: [] })).toContain(
      ESCAPE_HATCH_LABEL,
    );
  });

  it("points a failing PR at the SCR-004 remedy for leftover work", () => {
    const text = formatVerdict({
      ok: false,
      waived: false,
      refsOnly: false,
      reasons: ["#1321 has 1 unchecked DoD item(s)"],
    });
    expect(text).toContain("SCR-003");
    expect(text).toContain("SCR-004");
    expect(text).toContain("#1321");
  });

  // oxagen#2638: the prescribed remedy ("tick the boxes") does nothing on its
  // own, because ticking a box on the linked issue fires no pull-request
  // event and this check only reacts to the PR. The message must say so.
  it("tells a failing PR that ticking the issue alone will not re-run this check", () => {
    const text = formatVerdict({
      ok: false,
      waived: false,
      refsOnly: false,
      reasons: ["#1321 has 1 unchecked DoD item(s)"],
    });
    expect(text).toContain("does not by itself re-run this check");
  });

  // oxagen#2640: a Refs-only pass is a distinct state from an ordinary pass
  // and from the label waiver, and must read as neither.
  it("names the Refs-only state distinctly from a waiver or an ordinary pass", () => {
    const text = formatVerdict({
      ok: true,
      waived: false,
      refsOnly: true,
      reasons: [],
    });
    expect(text).toContain("passed");
    expect(text).not.toContain(ESCAPE_HATCH_LABEL);
  });
});

describe("closeExemptFromDod", () => {
  // The witness. Closing as a duplicate is the semantically correct close for
  // work tracked elsewhere, and the guard reopened it: oxagen#2582 was closed
  // `duplicate` and reopened twelve seconds later, because the exemption named
  // `not_planned` alone. Against that code this expectation is false.
  it("exempts a close marked duplicate", () => {
    expect(closeExemptFromDod("duplicate")).toBe(true);
  });

  it("exempts a close marked not planned", () => {
    expect(closeExemptFromDod("not_planned")).toBe(true);
  });

  // The half that must not move: `completed` is the only reason that claims
  // the work was done, so it is the only one SCR-003 has anything to verify.
  it("verifies a close marked completed", () => {
    expect(closeExemptFromDod("completed")).toBe(false);
  });

  it("verifies a close that names no reason at all", () => {
    expect(closeExemptFromDod(undefined)).toBe(false);
    expect(closeExemptFromDod(null)).toBe(false);
  });
});

describe("referencesIssue (#2638)", () => {
  const HERE = { owner: "macanderson", repo: "oxagen", number: 42 };

  it("matches a same-repo close and a same-repo Refs", () => {
    expect(referencesIssue("Closes #42", HERE)).toBe(true);
    expect(referencesIssue("Refs #42", HERE)).toBe(true);
  });

  it("does not match a different issue number", () => {
    // The regression this exists for: the helpers return
    // `{ owner, repo, number }` records, so a caller comparing the list against
    // a bare number matches nothing at all. A test that only asserted `false`
    // here would pass against that bug too — which is why the `true` cases
    // above come first.
    expect(referencesIssue("Closes #43", HERE)).toBe(false);
    expect(referencesIssue("", HERE)).toBe(false);
  });

  it("does not match the same number in another repository", () => {
    expect(referencesIssue("Closes macanderson/stella#42", HERE)).toBe(false);
    expect(referencesIssue("Refs otherorg/oxagen#42", HERE)).toBe(false);
  });

  it("matches a fully-qualified reference to this repository", () => {
    expect(referencesIssue("Closes macanderson/oxagen#42", HERE)).toBe(true);
  });

  it("ignores a negated close but still sees a Refs for the same issue", () => {
    // `linkedIssues` drops a negated close; `referencedIssues` does not filter
    // negation because there is no claim to disclaim. A body that says both
    // still names the issue, which is what a recheck should act on.
    expect(referencesIssue("This does not close #42.", HERE)).toBe(false);
    expect(referencesIssue("This does not close #42. Refs #42", HERE)).toBe(
      true,
    );
  });
});

describe("closes-nothing (#2551)", () => {
  const bigAudit = {
    labels: [CLOSES_NOTHING_LABEL],
    body: "3,285 files; files ~1,020 issues; closes none",
  };

  it("lets a substantial PR that closes nothing pass", () => {
    // The case that had no honest route: `Closes #N` would be untrue and
    // `no-issue` claims triviality. #1941 sat red on `dod` alone for this.
    const v = verdict(bigAudit, []);
    expect(v.ok).toBe(true);
    expect(v.waived).toBe(true);
  });

  it("reads differently from a trivial waiver", () => {
    // The DoD's third item: a reviewer must still be able to tell a small
    // trivial PR from a large one that closes nothing.
    const big = formatVerdict(verdict(bigAudit, []));
    const trivial = formatVerdict(
      verdict({ labels: [ESCAPE_HATCH_LABEL], body: "typo" }, []),
    );
    expect(big).toContain("closes no issue by design");
    expect(trivial).toContain("this change is trivial");
    expect(big).not.toEqual(trivial);
  });

  it("still fails a PR that links nothing and claims neither", () => {
    // The control. If this passed, the change would have removed the gate
    // rather than given it an honest exit.
    const v = verdict({ labels: [], body: "no reference at all" }, []);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toContain(CLOSES_NOTHING_LABEL);
  });

  it("names both labels in the failure message, so the remedy is findable", () => {
    const v = verdict({ labels: [], body: "" }, []);
    const text = v.reasons.join(" ");
    expect(text).toContain(ESCAPE_HATCH_LABEL);
    expect(text).toContain(CLOSES_NOTHING_LABEL);
  });
});

describe("a waiver label does not waive a PR that closes something (#2742 review)", () => {
  // The hole the first draft shipped: the label short-circuited before the body
  // was parsed, so `closes-nothing` plus `Closes #N` skipped that issue's DoD
  // entirely. That is a way PAST the gate rather than an exit from it, and it
  // would have been worse than the problem the label was added to solve.
  it("refuses closes-nothing on a PR that closes an issue", () => {
    const v = verdict(
      { labels: [CLOSES_NOTHING_LABEL], body: "Closes #9" },
      [],
    );
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toContain(CLOSES_NOTHING_LABEL);
    // The message must name the contradiction, not just refuse.
    expect(v.reasons.join(" ")).toContain("#9");
  });

  it("refuses no-issue on a PR that closes an issue", () => {
    // The same hole was already there for the older label. Fixed with it: no
    // open PR combined the two, so nothing reddens that was not already
    // bypassing verification.
    const v = verdict({ labels: [ESCAPE_HATCH_LABEL], body: "Closes #9" }, []);
    expect(v.ok).toBe(false);
  });

  it("still waives when the PR genuinely closes nothing", () => {
    expect(
      verdict({ labels: [CLOSES_NOTHING_LABEL], body: "an audit" }, []).ok,
    ).toBe(true);
    expect(verdict({ labels: [ESCAPE_HATCH_LABEL], body: "typo" }, []).ok).toBe(
      true,
    );
  });

  it("allows a waiver alongside Refs, which closes nothing", () => {
    // The control that keeps this from over-refusing: `Refs` deliberately does
    // not close, so it does not contradict the label.
    expect(
      verdict({ labels: [CLOSES_NOTHING_LABEL], body: "Refs #9" }, []).ok,
    ).toBe(true);
  });
});

describe("matching GitHub's own reading of a close claim (oxagen#1354)", () => {
  // The gate's answer is only worth anything if it agrees with what GitHub will
  // actually do on merge. Each case below is a spelling where the two disagreed.

  describe("spans GitHub does not read keywords out of", () => {
    it("ignores a keyword inside an inline code span", () => {
      // The case that cost a merge. PR #2844's only close-claim was
      // `## `Closes #2648`` in a heading. GitHub ignored it — #2648 stayed open
      // when that PR merged — and this gate did not, demanding a ticked
      // checklist for an issue the merge was never going to close.
      expect(linkedIssues("## `Closes #2648` — bootstrap the roles")).toEqual(
        [],
      );
      expect(linkedIssues("`fixes #11`")).toEqual([]);
    });

    it("ignores a keyword inside a double-backtick span, but not after it", () => {
      // Double-backtick spans are stripped first, so a literal ` inside one
      // cannot be mistaken for two single-backtick spans with prose between.
      expect(
        linkedIssues("``a ` b`` then Closes #16").map((r) => r.number),
      ).toEqual([16]);
    });

    it("still ignores fenced code and HTML comments", () => {
      expect(linkedIssues("```\nCloses #9\n```")).toEqual([]);
      expect(linkedIssues("<!-- Closes #15 -->")).toEqual([]);
    });
  });

  describe("spellings GitHub does honour", () => {
    it("reads a full issue URL as a close", () => {
      // The serious direction of the same defect: GitHub closes on this form,
      // and until the URL arm existed the gate saw nothing to verify and
      // passed. A control a supported spelling walks past is not a control —
      // and this is the spelling GitHub's UI produces when someone pastes a
      // link.
      expect(
        linkedIssues(
          "Closes https://github.com/macanderson/oxagen/issues/7",
        ).map((r) => ({ owner: r.owner, repo: r.repo, number: r.number })),
      ).toEqual([{ owner: "macanderson", repo: "oxagen", number: 7 }]);
    });

    it("reads a URL carrying www", () => {
      expect(
        linkedIssues("Fixes https://www.github.com/o/r/issues/70").map(
          (r) => r.number,
        ),
      ).toEqual([70]);
    });

    it("still reads the short and cross-repo forms", () => {
      expect(linkedIssues("Closes #1").map((r) => r.number)).toEqual([1]);
      expect(
        linkedIssues("Closes owner/repo#12").map((r) => ({
          owner: r.owner,
          repo: r.repo,
          number: r.number,
        })),
      ).toEqual([{ owner: "owner", repo: "repo", number: 12 }]);
    });
  });

  describe("negation, which was this issue's original report", () => {
    it("does not read a disclaimed keyword as a claim", () => {
      expect(linkedIssues("This does not close #2")).toEqual([]);
      expect(linkedIssues("this PR doesn't close #3")).toEqual([]);
      expect(linkedIssues("We will not fix #8 here")).toEqual([]);
      expect(linkedIssues("Do NOT close #10 with this")).toEqual([]);
    });
  });

  it("leaves Refs alone — it never closes anything", () => {
    expect(linkedIssues("Refs #4")).toEqual([]);
    expect(referencedIssues("Refs #4").map((r) => r.number)).toEqual([4]);
  });
});
