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
    expect(result.reasons[0]).toContain('no "Definition of done" section');
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
