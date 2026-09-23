#!/usr/bin/env node
/**
 * A deploy job must not ship a commit that is no longer the tip of main.
 *
 * ADR-046 gives every push to main its own concurrency group, so every merge
 * gets its own run. Under a saturated runner queue those runs finish in an
 * order unrelated to commit order, and an older commit's `deploy-web` /
 * `deploy-node` can run after a newer descendant already deployed. Production
 * then moves backwards and nothing reports it. On 2026-09-11 `9fa5382`'s
 * deployment was created 29 minutes after its descendant `ebcbcb8` had
 * deployed successfully (#2874).
 *
 * Two parts:
 *
 * 1. Run as a step (`node tools/scripts/check-deploy-tip.mjs`) at the start
 *    of each deploy job, it asks the API for the tip of `main` at that moment
 *    and writes `at_tip=true|false` to $GITHUB_OUTPUT. Every later step in the
 *    job carries `if: steps.tip.outputs.at_tip == 'true'`, so a superseded
 *    run skips its publish and stays green — a skip, not a failure.
 *
 *    An unreachable API fails open (deploys, with a warning): blocking every
 *    deploy on an API blip is the outage #2730 already was once.
 *
 * 2. Run as `node tools/scripts/check-deploy-tip.mjs --guard` from
 *    `check:contracts`, it reads pipeline.yml and asserts the shape: both
 *    deploy jobs start with the tip step, and every step after it is gated
 *    on its output. Removing the gate from one step would look like a
 *    tidy-up in review and would ship that step from a stale commit.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pipelinePath = join(repoRoot, ".github", "workflows", "pipeline.yml");

export const TIP_STEP_ID = "tip";
export const TIP_GATE = `steps.${TIP_STEP_ID}.outputs.at_tip == 'true'`;
export const DEPLOY_JOBS = ["deploy-web", "deploy-node"];

/**
 * The deploy decision, separated from I/O so the ordering case is testable.
 *
 * @param {{ sha: string, tip: string | null, error?: string }} input
 *   `sha` is the commit this run carries; `tip` is main's head at the moment
 *   of asking, or null when the API could not answer (`error` says why).
 * @returns {{ deploy: boolean, reason: string, warning?: string }}
 */
export function decide({ sha, tip, error }) {
  if (tip === null || tip === undefined) {
    return {
      deploy: true,
      reason: `could not read the tip of main (${error ?? "no answer"}); deploying ${sha.slice(0, 9)} rather than blocking on the API`,
      warning: `check-deploy-tip could not read the tip of main: ${error ?? "no answer"}`,
    };
  }
  if (tip === sha) {
    return { deploy: true, reason: `${sha.slice(0, 9)} is the tip of main` };
  }
  return {
    deploy: false,
    reason: `${sha.slice(0, 9)} is no longer the tip of main (${tip.slice(0, 9)} is); a newer run deploys it, so this one skips`,
  };
}

/**
 * How long one GitHub API call may take before it is treated as no answer.
 * The header promises that an unreachable API fails open; a call that never
 * returns is not unreachable to `fetch`, it is a job that sits until the
 * runner's own timeout kills it, and a killed step is a failure, not a skip.
 */
export const API_TIMEOUT_MS = 15_000;

/** Ask the GitHub API for the head sha of `main`. Never throws. */
export async function readMainTip({
  repository,
  token,
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS,
}) {
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${repository}/branches/main`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        // The abort surfaces as a rejection and lands in the catch below,
        // which is the fail-open path.
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) return { tip: null, error: `HTTP ${res.status}` };
    const body = await res.json();
    const sha = body?.commit?.sha;
    if (typeof sha !== "string" || sha.length === 0)
      return { tip: null, error: "response carried no commit sha" };
    return { tip: sha };
  } catch (err) {
    return {
      tip: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The steps of one job, in order, as `{ name, gated }` where `gated` says
 * whether the step carries the tip gate in its `if:`. Comments are dropped.
 * Deliberately a string reader, like check-main-concurrency: GitHub evaluates
 * the workflow server-side and what can be held still locally is the shape.
 */
export function deployJobSteps(yaml, job) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l === `  ${job}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z][\w-]*:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end).filter((l) => !/^\s*#/.test(l));
  const stepsAt = body.findIndex((l) => l === "    steps:");
  if (stepsAt < 0) return null;
  const steps = [];
  let current = null;
  for (const line of body.slice(stepsAt + 1)) {
    const head = line.match(/^      - (name|uses|id):\s*(.*)$/);
    if (head) {
      current = { name: head[2].trim(), gated: false, id: null };
      steps.push(current);
      if (head[1] === "id") current.id = head[2].trim();
      continue;
    }
    if (!current) continue;
    const id = line.match(/^        id:\s*(\S+)/);
    if (id) current.id = id[1];
    const cond = line.match(/^        if:\s*(.*)$/);
    if (cond && cond[1].includes(TIP_GATE)) current.gated = true;
  }
  return steps;
}

/**
 * Every problem with the shape of the deploy jobs, or an empty list. The tip
 * step is the first step after checkout; everything after it is gated.
 */
export function guardProblems(yaml) {
  const problems = [];
  for (const job of DEPLOY_JOBS) {
    const steps = deployJobSteps(yaml, job);
    if (!steps) {
      problems.push(`${job}: job or its steps not found`);
      continue;
    }
    const tipAt = steps.findIndex((s) => s.id === TIP_STEP_ID);
    if (tipAt < 0) {
      problems.push(
        `${job}: no step with id "${TIP_STEP_ID}" runs check-deploy-tip`,
      );
      continue;
    }
    if (tipAt > 1) {
      problems.push(
        `${job}: the tip step is step ${tipAt + 1}; it must run right after checkout, before anything is built or credentials are assumed`,
      );
    }
    for (const step of steps.slice(tipAt + 1)) {
      if (!step.gated) {
        problems.push(
          `${job}: step "${step.name}" runs whether or not this commit is still the tip of main; add \`if: ${TIP_GATE}\``,
        );
      }
    }
  }
  return problems;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  if (process.argv.includes("--guard")) {
    const problems = guardProblems(readFileSync(pipelinePath, "utf8"));
    if (problems.length > 0) {
      console.error(
        "check-deploy-tip: a deploy job can ship a commit that is no longer the tip of main.\n\n" +
          problems.map((p) => `  ${p}`).join("\n") +
          "\n\nAn older commit's run finishing after a newer one moves production backwards (#2874).",
      );
      process.exit(1);
    }
    console.log("check-deploy-tip: both deploy jobs skip when superseded.");
  } else {
    const sha = process.env.GITHUB_SHA;
    const repository = process.env.GITHUB_REPOSITORY;
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (!sha || !repository || !token) {
      console.error(
        "check-deploy-tip: GITHUB_SHA, GITHUB_REPOSITORY and GH_TOKEN must be set",
      );
      process.exit(1);
    }
    const { tip, error } = await readMainTip({ repository, token });
    const verdict = decide({ sha, tip, error });
    if (verdict.warning) console.log(`::warning::${verdict.warning}`);
    console.log(
      `${verdict.deploy ? "deploying" : "::notice::skipping the deploy"}: ${verdict.reason}`,
    );
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `at_tip=${verdict.deploy}\n`);
    }
  }
}
