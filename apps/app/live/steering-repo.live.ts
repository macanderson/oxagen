/**
 * The steering repo live test (lane S11, #4723).
 *
 * It runs against production Oxagen and a GitHub test organization, from
 * `.github/workflows/steering-live.yml` only. `playwright.live.config.ts`
 * holds its settings, and no unit, integration, or e2e lane picks it up.
 *
 * The three tests run in order in one worker and share the run's workspace.
 * Playwright starts a new worker after a failure, so no test keeps state in
 * the module: each one reads what it needs back from Oxagen. A test after a
 * failed one still runs, and its error says what it could not find.
 */
import { expect, test } from "@playwright/test";
import {
  createWorkspace,
  describeChecks,
  describeRepo,
  findProposal,
  githubRig,
  HEALTH_CHECK_ID,
  MINUTE,
  mergeSteeringPr,
  newestRun,
  MERGE_COMMIT_SETTING,
  openSteeringPr,
  type Oxagen,
  poll,
  proposeRecord,
  readSettings,
  readSteeringRepo,
  reached,
  repairSteeringRepo,
  runRepoFullName,
  SECOND,
  type Settings,
  signIn,
  type GithubRig,
  waitForChecks,
  waitForHealth,
  waitForProvisioned,
  waiting,
} from "./steering-rig";

/** The lineage of the steering record the merge test publishes. */
const MERGE_LINEAGE = "live-test.merge";
/** The lineage of the steering PR that stays open while the drift test runs. */
const DRIFT_LINEAGE = "live-test.drift";

interface Rig {
  settings: Settings;
  ox: Oxagen;
  gh: GithubRig;
}

let current: Promise<Rig> | undefined;

/** Signs in once per worker. A new worker signs in again. */
function rig(): Promise<Rig> {
  current ??= (async () => {
    const settings = readSettings();
    return { settings, ox: await signIn(settings), gh: githubRig(settings.githubToken) };
  })();
  return current;
}

/** The steering repo's full name, once provisioning has created it. */
async function steeringRepoName(r: Rig): Promise<string> {
  const view = await readSteeringRepo(r.ox, r.settings);
  if (view.repository === null) {
    throw new Error(`Workspace ${r.settings.runSlug} has no steering repo: ${describeRepo(view)}.`);
  }
  return view.repository.fullName;
}

/** The proposal on a lineage, or an error that names the lineage. */
async function proposalOn(r: Rig, lineageId: string): Promise<string> {
  const proposalId = await findProposal(r.ox, r.settings, lineageId);
  if (proposalId === null) {
    throw new Error(
      `Workspace ${r.settings.runSlug} has no proposal on ${lineageId}. The healthy workspace test proposes it, so read that test's error first.`,
    );
  }
  return proposalId;
}

test("a new workspace gets a healthy steering repo", async () => {
  const r = await rig();

  const created = await createWorkspace(r.ox, r.settings);
  expect(created.slug).toBe(r.settings.runSlug);

  const ready = await waitForProvisioned(r.ox, r.settings);
  expect(ready.repository?.fullName ?? "").toMatch(runRepoFullName(r.settings));

  // Opening the first steering PR sends the pull_request webhook that runs
  // the repo's first health read. The merge test merges this steering PR.
  const proposed = await proposeRecord(
    r.ox,
    r.settings,
    MERGE_LINEAGE,
    "Steering live test: the merge test publishes this steering record.",
  );
  expect(proposed.lineageId).toBe(MERGE_LINEAGE);
  const opened = await openSteeringPr(r.ox, r.settings, proposed.proposalId);
  expect(opened.pr).not.toBeNull();

  await waitForHealth(r.ox, r.settings, "healthy", 3 * MINUTE);
});

test("a steering PR merged through Oxagen raises the published version", async () => {
  const r = await rig();
  const proposalId = await proposalOn(r, MERGE_LINEAGE);

  const checked = await waitForChecks(r.ox, r.settings, proposalId);
  if (checked.status !== "checks_passed" || checked.pr === null) {
    throw new Error(
      `The steering PR on ${MERGE_LINEAGE} settled at ${checked.status}, not checks_passed. Checks: ${describeChecks(checked)}.`,
    );
  }

  const before = await readSteeringRepo(r.ox, r.settings);
  if (before.publishedVersion === null) {
    throw new Error(`The steering repo reads no published version before the merge: ${describeRepo(before)}.`);
  }
  const fullName = await steeringRepoName(r);
  const beforeVersion = before.publishedVersion;

  await r.gh.approvePr(fullName, checked.pr.number);
  const merged = await mergeSteeringPr(r.ox, r.settings, proposalId);
  if (!("record" in merged)) {
    throw new Error(`The merge of ${MERGE_LINEAGE} answered a governance change, not a record.`);
  }
  expect(merged.record.lineageId).toBe(MERGE_LINEAGE);
  expect(merged.bundleVersion.after).toBe(merged.bundleVersion.before + 1);
  // The merge answers the steering version it published. Provisioning
  // published the first commit, so this merge takes the next number (#4732).
  expect(merged.publishedVersion).toBe(beforeVersion + 1);

  const pull = await r.gh.getPr(fullName, checked.pr.number);
  expect(pull.merged).toBe(true);

  const after = await poll(
    `published version above ${String(beforeVersion)}`,
    { timeoutMs: 3 * MINUTE, intervalMs: 5 * SECOND },
    async () => {
      const view = await readSteeringRepo(r.ox, r.settings);
      return view.publishedVersion !== null && view.publishedVersion > beforeVersion
        ? reached(view)
        : waiting(describeRepo(view));
    },
  );
  expect(after.publishedVersion).toBe(beforeVersion + 1);
});

test("allowing merge commits drifts health and fails the steering check until repair", async () => {
  const r = await rig();
  await waitForHealth(r.ox, r.settings, "healthy", 3 * MINUTE);
  const fullName = await steeringRepoName(r);

  const proposed = await proposeRecord(
    r.ox,
    r.settings,
    DRIFT_LINEAGE,
    "Steering live test: this steering PR stays open while merge settings differ.",
  );
  await openSteeringPr(r.ox, r.settings, proposed.proposalId);
  await waitForChecks(r.ox, r.settings, proposed.proposalId);

  await r.gh.setMergeCommits(fullName, true);
  const brokeAt = Date.now();

  await poll(
    `drifted health and a failed steering check on every open PR in ${fullName}`,
    { timeoutMs: 60 * SECOND, intervalMs: 5 * SECOND, since: brokeAt },
    async () => {
      const view = await readSteeringRepo(r.ox, r.settings);
      if (view.health !== "drifted") return waiting(describeRepo(view));
      if (!view.differences.some((d) => d.setting === MERGE_COMMIT_SETTING)) {
        return waiting(`drifted without a ${MERGE_COMMIT_SETTING} difference: ${describeRepo(view)}`);
      }
      const pulls = await r.gh.openPulls(fullName);
      if (pulls.length === 0) return waiting("drifted, with no open pull request");
      const unfailed: string[] = [];
      for (const pull of pulls) {
        const run = newestRun(await r.gh.steeringCheckRuns(fullName, pull.headSha));
        if (run?.external_id !== HEALTH_CHECK_ID || run.conclusion !== "failure") {
          unfailed.push(
            `#${String(pull.number)} ${run === null ? "no check run" : `${run.status}/${run.conclusion ?? "none"}`}`,
          );
        }
      }
      return unfailed.length === 0
        ? reached(view)
        : waiting(`drifted, with no failed health check on ${unfailed.join(", ")}`);
    },
  );

  const repaired = await repairSteeringRepo(r.ox, r.settings);
  expect(repaired.health).toBe("healthy");
  await waitForHealth(r.ox, r.settings, "healthy", 60 * SECOND);
  expect(await r.gh.allowsMergeCommits(fullName)).toBe(false);
});
