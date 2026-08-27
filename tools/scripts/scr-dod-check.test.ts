import { describe, expect, it } from "vitest";
import {
  dodStatus,
  ESCAPE_HATCH_LABEL,
  formatVerdict,
  linkedIssues,
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

  it("fails a PR that links no issue and explains both remedies", () => {
    const result = verdict({ body: "Small tidy-up.", labels: [] }, []);
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain("links no issue");
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
      reasons: ["#1321 has 1 unchecked DoD item(s)"],
    });
    expect(text).toContain("SCR-003");
    expect(text).toContain("SCR-004");
    expect(text).toContain("#1321");
  });
});
