/**
 * The detector for #3257: a pull request whose CI runs keep getting cancelled
 * by newer pushes before any finishes.
 *
 * The witness is PR #3233's branch on 2026-09-18, rebuilt from the runs the
 * issue recorded: cancelled runs 35291373462, 35291647690 and 35292531366 in a
 * row with nothing finished between, under run 35296075650, still in
 * progress. The detector must fire on that and stay silent on one cancel
 * followed by a finished run. It must also stay silent on three cancelled runs
 * with no run after them, since no push cancelled the newest (#4664 item 23).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MARKER,
  REPORTER_LOGIN,
  RESOLVED_MARKER,
  classify,
  medianGapMinutes,
  ownReport,
  parseThreshold,
  plan,
  readRuns,
  relevantRuns,
  supersededBody,
} from "./check-superseded-runs.mjs";

type Run = {
  id: number;
  head_sha: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at?: string;
  html_url: string;
  event: string;
  head_repository: { full_name: string };
};

const REPO = "oxageninc/product";

function run(id: number, sha: string, created: string, status: string, conclusion: string | null): Run {
  return {
    id,
    head_sha: sha,
    status,
    conclusion,
    created_at: created,
    updated_at: created,
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    event: "pull_request",
    head_repository: { full_name: REPO },
  };
}

// Newest first, as the API returns them.
const THREE_CANCELLED: Run[] = [
  run(35292531366, "f03fe8be6", "2026-09-18T00:43:53Z", "completed", "cancelled"),
  run(35291647690, "d88e732b5", "2026-09-18T00:30:15Z", "completed", "cancelled"),
  run(35291373462, "fd57c16bc", "2026-09-18T00:26:15Z", "completed", "cancelled"),
];

// The run the last push started, which cancelled the newest of the three.
const STILL_GOING = run(35296075650, "332ed50a", "2026-09-18T01:36:00Z", "in_progress", null);

// #3233's branch as the issue recorded it: three cancelled runs, each
// followed by a newer one.
const WITNESS: Run[] = [STILL_GOING, ...THREE_CANCELLED];

const ONE_CANCEL_THEN_GREEN: Run[] = [
  run(35300000002, "bbbbbbbbb", "2026-09-18T02:10:00Z", "completed", "success"),
  run(35300000001, "aaaaaaaaa", "2026-09-18T02:00:00Z", "completed", "cancelled"),
];

describe("classify", () => {
  it("fires while a newer run is still going, as on #3233", () => {
    // The issue's table ended in an in_progress run. It is no answer yet, so
    // it neither extends nor ends the streak, but it is the newer run that
    // makes the newest cancelled run count.
    const verdict = classify(WITNESS);
    expect(verdict.state).toBe("superseded");
    expect(verdict.streak.map((r: Run) => r.id)).toEqual([35292531366, 35291647690, 35291373462]);
  });

  it("fires on three cancelled runs under a fourth that was cancelled too", () => {
    const fourCancelled = [run(35296075650, "332ed50a", "2026-09-18T01:36:00Z", "completed", "cancelled"), ...THREE_CANCELLED];
    const verdict = classify(fourCancelled);
    expect(verdict.state).toBe("superseded");
    expect(verdict.streak.map((r: Run) => r.id)).toEqual([35292531366, 35291647690, 35291373462]);
  });

  it("never reads three cancelled runs with no run after them as superseded (#4664 item 23)", () => {
    // A person who cancels three runs by hand pushed nothing, so no push
    // cancelled the newest. It does not count, which leaves a streak of two.
    const verdict = classify(THREE_CANCELLED);
    expect(verdict.state).not.toBe("superseded");
    expect(verdict.state).toBe("pending");
    expect(verdict.streak.map((r: Run) => r.id)).toEqual([35291647690, 35291373462]);
  });

  it("stays silent on one supersede followed by a finished run", () => {
    expect(classify(ONE_CANCEL_THEN_GREEN).state).toBe("answered");
  });

  it("stays silent when the latest run failed, because a failure is an answer", () => {
    const runs = [
      run(2, "b", "2026-09-18T02:10:00Z", "completed", "failure"),
      run(1, "a", "2026-09-18T02:00:00Z", "completed", "cancelled"),
    ];
    expect(classify(runs).state).toBe("answered");
  });

  it("stays silent on one or two cancels with no answer yet", () => {
    expect(classify([STILL_GOING, ...THREE_CANCELLED.slice(0, 1)]).state).toBe("pending");
    expect(classify([STILL_GOING, ...THREE_CANCELLED.slice(0, 2)]).state).toBe("pending");
  });

  it("reads a first run still in progress as not finished yet, not superseded", () => {
    expect(classify([run(1, "a", "2026-09-18T02:00:00Z", "in_progress", null)]).state).toBe("pending");
    expect(classify([]).state).toBe("pending");
  });

  it("counts only the streak since the last answer", () => {
    // Two cancels after a success: the success ended the older streak.
    const runs = [
      STILL_GOING,
      ...THREE_CANCELLED.slice(0, 2),
      run(3, "c", "2026-09-18T00:10:00Z", "completed", "success"),
      run(2, "b", "2026-09-18T00:05:00Z", "completed", "cancelled"),
      run(1, "a", "2026-09-18T00:00:00Z", "completed", "cancelled"),
    ];
    expect(classify(runs).state).toBe("answered");
  });

  it("honours a different threshold", () => {
    expect(classify([STILL_GOING, ...THREE_CANCELLED.slice(0, 2)], { threshold: 2 }).state).toBe("superseded");
  });

  it("decides across pages the same as on one page", () => {
    // readRuns concatenates pages before classifying. A streak that starts on
    // page 1 and ends on page 2 must read the same as the joined list.
    const page1 = [STILL_GOING, ...THREE_CANCELLED.slice(0, 2)];
    const page2 = [THREE_CANCELLED[2] as Run, run(1, "a", "2026-09-18T00:00:00Z", "completed", "success")];
    expect(classify(page1).state).toBe("pending");
    const joined = classify([...page1, ...page2]);
    expect(joined.state).toBe("superseded");
    expect(joined.answered?.id).toBe(1);
  });
});

describe("parseThreshold", () => {
  it("reads 3 when the variable is unset or empty, never 0", () => {
    // The workflow passes `vars.CI_SUPERSEDED_THRESHOLD`, which is an empty
    // string when the repository variable does not exist. Number("") is 0,
    // and at 0 a branch whose last run succeeded would read as superseded.
    expect(parseThreshold(undefined)).toBe(3);
    expect(parseThreshold("")).toBe(3);
    expect(classify(ONE_CANCEL_THEN_GREEN, { threshold: parseThreshold("") }).state).toBe("answered");
  });

  it("refuses a threshold that would fire on one supersede", () => {
    expect(parseThreshold("1")).toBe(3);
    expect(parseThreshold("0")).toBe(3);
    expect(parseThreshold("two")).toBe(3);
    expect(parseThreshold("2.5")).toBe(3);
  });

  it("accepts a whole number of at least 2", () => {
    expect(parseThreshold("2")).toBe(2);
    expect(parseThreshold("5")).toBe(5);
  });
});

describe("relevantRuns", () => {
  it("drops runs from a fork's branch of the same name, other events, and runs before the PR opened", () => {
    const fork = { ...run(9, "f", "2026-09-18T01:00:00Z", "completed", "cancelled"), head_repository: { full_name: "someone/oxagen" } };
    const push = { ...run(8, "p", "2026-09-18T01:00:00Z", "completed", "cancelled"), event: "push" };
    const old = run(7, "o", "2026-09-17T00:00:00Z", "completed", "cancelled");
    const kept = run(6, "k", "2026-09-18T01:00:00Z", "completed", "cancelled");
    const out = relevantRuns([fork, push, old, kept], { headRepo: REPO, since: "2026-09-18T00:00:00Z" });
    expect(out.map((r: Run) => r.id)).toEqual([6]);
  });
});

describe("medianGapMinutes", () => {
  it("measures the push cadence from run creation times", () => {
    // 00:26:15 → 00:30:15 is 4 minutes, 00:30:15 → 00:43:53 is 13.6.
    expect(medianGapMinutes(THREE_CANCELLED)).toBe(9);
    expect(medianGapMinutes(THREE_CANCELLED.slice(0, 1))).toBeNull();
  });
});

describe("plan", () => {
  it("writes one failing status and one comment for a superseded branch", () => {
    const actions = plan(classify(WITNESS));
    expect(actions.map((a: { kind: string }) => a.kind)).toEqual(["status", "comment-create"]);
    expect(actions[0]).toMatchObject({ state: "failure", targetUrl: THREE_CANCELLED[0]?.html_url });
    expect(actions[1]?.body?.startsWith(MARKER)).toBe(true);
  });

  it("edits the existing comment rather than posting a second", () => {
    const actions = plan(classify(WITNESS), { existingComment: { id: 42, body: `${MARKER}\nolder text` } });
    expect(actions.map((a: { kind: string }) => a.kind)).toEqual(["status", "comment-update"]);
    expect(actions[1]).toMatchObject({ id: 42 });
  });

  it("leaves an unchanged comment alone", () => {
    const body = supersededBody({ streak: classify(WITNESS).streak });
    const actions = plan(classify(WITNESS), { existingComment: { id: 42, body } });
    expect(actions.map((a: { kind: string }) => a.kind)).toEqual(["status"]);
  });

  it("writes nothing for one supersede then green when nothing was reported", () => {
    expect(plan(classify(ONE_CANCEL_THEN_GREEN))).toEqual([]);
  });

  it("writes nothing while the branch is pending", () => {
    expect(plan(classify([STILL_GOING, ...THREE_CANCELLED.slice(0, 2)]), { existingStatus: "failure" })).toEqual([]);
  });

  it("writes nothing for three cancelled runs with no run after them", () => {
    expect(plan(classify(THREE_CANCELLED))).toEqual([]);
  });

  it("clears an earlier report once a run finishes", () => {
    const actions = plan(classify(ONE_CANCEL_THEN_GREEN), {
      existingStatus: "failure",
      existingComment: { id: 42, body: `${MARKER}\nstreak text` },
    });
    expect(actions[0]).toMatchObject({ kind: "status", state: "success" });
    expect(actions[1]).toMatchObject({ kind: "comment-update", id: 42 });
    expect(actions[1]?.body).toContain(RESOLVED_MARKER);
  });

  it("does not rewrite a comment already marked resolved", () => {
    const actions = plan(classify(ONE_CANCEL_THEN_GREEN), {
      existingStatus: "success",
      existingComment: { id: 42, body: `${MARKER}\n${RESOLVED_MARKER}\ndone` },
    });
    expect(actions).toEqual([]);
  });
});

describe("ownReport", () => {
  const bot = { login: REPORTER_LOGIN, type: "Bot" };

  it("adopts the report the workflow's own identity wrote", () => {
    const report = { id: 42, body: `${MARKER}\nstreak text`, user: bot };
    expect(ownReport([report])).toBe(report);
  });

  it("skips a marker comment from another author and finds the workflow's own after it (#4664 item 8)", () => {
    // Anyone who can comment can post the marker first, a fork's author
    // included. Adopting that comment would put the report in it.
    const stranger = { id: 7, body: `${MARKER}\nnot the bot`, user: { login: "someone", type: "User" } };
    const report = { id: 42, body: `${MARKER}\nstreak text`, user: bot };
    expect(ownReport([stranger, report])).toBe(report);
  });

  it("adopts nothing when only another author posted the marker", () => {
    const stranger = { id: 7, body: `${MARKER}\nnot the bot`, user: { login: "someone", type: "User" } };
    expect(ownReport([stranger])).toBeNull();
    // With no report found, plan posts a new comment and edits none.
    const actions = plan(classify(WITNESS), { existingComment: ownReport([stranger]) });
    expect(actions.map((a: { kind: string }) => a.kind)).toEqual(["status", "comment-create"]);
  });

  it("adopts nothing from another bot, or from a user whose login copies the bot's", () => {
    const otherBot = { id: 8, body: `${MARKER}\n`, user: { login: "dependabot[bot]", type: "Bot" } };
    const lookalike = { id: 9, body: `${MARKER}\n`, user: { login: REPORTER_LOGIN, type: "User" } };
    expect(ownReport([otherBot, lookalike])).toBeNull();
  });

  it("skips the workflow's own comments that do not start with the marker", () => {
    expect(ownReport([{ id: 3, body: `hello ${MARKER}`, user: bot }, { id: 4, body: null, user: bot }])).toBeNull();
  });
});

describe("supersededBody", () => {
  it("names every cancelled run and says a cancelled check is not a pass", () => {
    const body = supersededBody({ streak: classify(WITNESS).streak });
    for (const r of THREE_CANCELLED) expect(body).toContain(String(r.id));
    expect(body).toContain("A cancelled required check is not a pass");
    expect(body).toContain("The last 3 CI runs");
  });

  it("says at least when the page cap cut the streak short", () => {
    const body = supersededBody({ streak: classify(WITNESS).streak, capped: true });
    expect(body).toContain("At least the last 3 CI runs");
  });
});

describe("readRuns", () => {
  // 100 cancelled runs fill page 1 exactly, one minute apart, newest first.
  const fullPage: Run[] = Array.from({ length: 100 }, (_, i) =>
    run(1000 - i, `c${i}`, new Date(Date.UTC(2026, 8, 18, 12, 0) - i * 60000).toISOString(), "completed", "cancelled"),
  );

  it("pages past a full page of cancels to find the run that answered", async () => {
    const pages = [
      { workflow_runs: fullPage },
      { workflow_runs: [run(1, "ok", "2026-09-18T09:00:00Z", "completed", "success")] },
    ];
    const asked: string[] = [];
    const get = async (path: string) => {
      asked.push(path);
      return pages[asked.length - 1];
    };
    const { runs, capped } = await readRuns(get, { repo: REPO, branch: "b", headRepo: REPO, since: "2026-09-18T00:00:00Z" });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain("page=2");
    expect(capped).toBe(false);
    const verdict = classify(runs);
    // The newest of the 100 has no newer run, so 99 count.
    expect(verdict.streak).toHaveLength(99);
    expect(verdict.answered?.id).toBe(1);
  });

  it("stops at a short page, which means the history ended", async () => {
    const get = async () => ({ workflow_runs: THREE_CANCELLED });
    const { runs, capped } = await readRuns(get, { repo: REPO, branch: "b", headRepo: REPO });
    expect(runs).toHaveLength(3);
    expect(capped).toBe(false);
  });

  it("says capped when every page it may read is full of cancels", async () => {
    let calls = 0;
    const get = async () => {
      calls++;
      return { workflow_runs: fullPage };
    };
    const { capped } = await readRuns(get, { repo: REPO, branch: "b", headRepo: REPO });
    expect(calls).toBe(5);
    expect(capped).toBe(true);
  });

  it("stops once a page reaches back before the pull request opened", async () => {
    let calls = 0;
    const get = async () => {
      calls++;
      return { workflow_runs: fullPage };
    };
    // fullPage spans 10:21 to 12:00. A PR opened at 11:00 needs no page 2.
    const { runs } = await readRuns(get, { repo: REPO, branch: "b", headRepo: REPO, since: "2026-09-18T11:00:00Z" });
    expect(calls).toBe(1);
    expect(runs).toHaveLength(61);
  });
});

describe(".github/workflows/ci-superseded.yml", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const workflow = readFileSync(join(root, ".github", "workflows", "ci-superseded.yml"), "utf8");
  const pipeline = readFileSync(join(root, ".github", "workflows", "pipeline.yml"), "utf8");

  it("runs after every completed run of the workflow pipeline.yml names", () => {
    // workflow_run matches by workflow name. A rename of pipeline.yml's
    // `name:` would silence the detector without any error.
    const name = pipeline.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    expect(name).toBe("CI");
    expect(workflow).toMatch(/workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]/);
  });

  it("can write the status and the comment it reports with", () => {
    expect(workflow).toMatch(/^\s+statuses: write$/m);
    expect(workflow).toMatch(/^\s+pull-requests: write$/m);
  });

  it("passes the threshold variable the ADR says can change the streak", () => {
    expect(workflow).toMatch(/^\s+CI_SUPERSEDED_THRESHOLD: \$\{\{ vars\.CI_SUPERSEDED_THRESHOLD \}\}$/m);
  });

  it("never expands an event value inside the run script", () => {
    // A branch name is attacker-chosen. It reaches the script through env:.
    const runLines = workflow.split("\n").filter((l) => /^\s+run:/.test(l));
    expect(runLines).toEqual(["        run: node tools/scripts/check-superseded-runs.mjs"]);
  });
});
