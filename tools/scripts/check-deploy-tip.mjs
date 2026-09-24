#!/usr/bin/env node
/**
 * A deploy job ships its commit unless a newer commit is already live for
 * that service. It never moves production backwards, and it never needs its
 * commit to still be the tip of main.
 *
 * ## Why not "only the tip deploys"
 *
 * The first version of this guard (#2874) deployed a commit only while it
 * was still the tip of main. That stopped production moving backwards: on
 * 2026-09-11 `9fa5382`'s deployment was created 29 minutes after its
 * descendant `ebcbcb8` had deployed. But a full run takes 60 to 70 minutes,
 * so during a burst of merges every run found a newer tip and skipped. On
 * 2026-09-24 main went green at e111db5 and still did not deploy, because
 * three merges landed while its staging jobs ran. A rule that deploys
 * nothing while people keep merging blocks releasing whenever you want.
 *
 * ## The rule now
 *
 * After a real deploy, `--record` records the commit it shipped as a GitHub
 * deployment in the `production` environment with task `deploy:<service>`.
 * Before a deploy, this script reads the newest such record for the service
 * and asks the compare API how this commit relates to it:
 *
 * - `ahead` (descends from what is live): deploy. Production moves forward
 *   even when main has moved past this commit too.
 * - `identical`: deploy. This is a re-run of the live commit, and it is
 *   harmless.
 * - `behind` (what is live descends from this commit): skip. This is the
 *   #2874 case.
 * - `diverged` (main was reset or force-pushed): deploy only if this commit
 *   is main's tip now.
 * - No record for the service yet (its first deploy under this rule): deploy.
 *
 * Every deploy job holds a per-service concurrency group,
 * `production-<service>`, with `cancel-in-progress: false`. A running deploy
 * always finishes. Two runs never ship the same service at once, so the
 * record never races. When several runs wait, GitHub keeps the newest
 * pending one, which is the one worth shipping.
 *
 * An API that cannot answer fails open: the job deploys, with a warning.
 * Blocking every deploy on an API blip is the outage #2730 already was once.
 *
 * ## Modes
 *
 * 1. `node check-deploy-tip.mjs` (the `order` step, first after checkout)
 *    writes `ship=true|false` to $GITHUB_OUTPUT. Every later step carries
 *    `if: steps.order.outputs.ship == 'true'`, so a skipped run stays green.
 * 2. `node check-deploy-tip.mjs --record` (the `record` step, last) records
 *    what shipped. A failed record only warns: the next run compares against
 *    an older record, sees itself ahead, and deploys, which is safe.
 * 3. `node check-deploy-tip.mjs --guard` (from `check:contracts`) asserts
 *    the shape of every deploy job, the installer publish included: the
 *    order step, the gate on every later step, the record step and the
 *    per-service concurrency group. Dropping any of them would look like a
 *    tidy-up in review and would let a deploy move production backwards.
 *
 * The file keeps its #2874 name so `check:contracts` and the history still
 * point at it.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pipelinePath = join(repoRoot, ".github", "workflows", "pipeline.yml");

export const ORDER_STEP_ID = "order";
export const RECORD_STEP_ID = "record";
export const SHIP_GATE = `steps.${ORDER_STEP_ID}.outputs.ship == 'true'`;
export const DEPLOY_JOBS = ["deploy-web", "deploy-node", "publish-installers"];
export const DEPLOY_ENVIRONMENT = "production";

/** The deployment task that records `service` as live. */
export function taskFor(service) {
  return `deploy:${service}`;
}

const short = (sha) => (sha ? sha.slice(0, 9) : "none");

/**
 * The deploy decision, separated from I/O so each ordering case is testable.
 *
 * @param {{
 *   sha: string,
 *   live: string | null,
 *   relation?: string,
 *   tip?: string | null,
 *   error?: string,
 * }} input
 *   `live` is the commit last recorded as deployed for this service, or null
 *   when none is. `relation` is the compare API's status for live...sha:
 *   `ahead`, `behind`, `identical` or `diverged`.
 *   `tip` is main's head, read only for `diverged`. `error` says an API call
 *   could not answer.
 * @returns {{ deploy: boolean, reason: string, warning?: string }}
 */
export function decide({ sha, live, relation, tip, error }) {
  if (error) {
    return {
      deploy: true,
      reason: `could not tell what is live (${error}); deploying ${short(sha)} rather than blocking on the API`,
      warning: `check-deploy-tip could not read the live deployment: ${error}`,
    };
  }
  if (!live) {
    return {
      deploy: true,
      reason: `nothing is recorded as live for this service yet; deploying ${short(sha)}`,
    };
  }
  switch (relation) {
    case "ahead":
      return {
        deploy: true,
        reason: `${short(sha)} descends from the live ${short(live)}; deploying moves production forward`,
      };
    case "identical":
      return {
        deploy: true,
        reason: `${short(sha)} is already live; re-deploying the same commit`,
      };
    case "behind":
      return {
        deploy: false,
        reason: `${short(live)} is already live and descends from ${short(sha)}; deploying would move production backwards (#2874), so this run skips`,
      };
    case "diverged":
      if (tip === sha) {
        return {
          deploy: true,
          reason: `${short(sha)} and the live ${short(live)} have diverged (main was reset); ${short(sha)} is main's tip, so it deploys`,
          warning: `live ${short(live)} is not an ancestor of main's tip ${short(sha)}`,
        };
      }
      if (tip === null || tip === undefined) {
        return {
          deploy: true,
          reason: `${short(sha)} and the live ${short(live)} have diverged and main's tip could not be read; deploying rather than blocking`,
          warning: `diverged from live ${short(live)} and main's tip is unknown`,
        };
      }
      return {
        deploy: false,
        reason: `${short(sha)} and the live ${short(live)} have diverged, and ${short(tip)} is main's tip; that run deploys, so this one skips`,
      };
    default:
      return {
        deploy: true,
        reason: `the compare API answered "${relation}"; deploying ${short(sha)} rather than guessing`,
        warning: `unexpected compare status "${relation}"`,
      };
  }
}

/**
 * How long one GitHub API call may take before it is treated as no answer.
 * An unreachable API fails open. A call that never returns is not
 * unreachable to `fetch`: it holds the job until the runner's own timeout
 * kills it, and a killed step is a failure, not a skip.
 */
export const API_TIMEOUT_MS = 15_000;

/** One GitHub API call. Never throws: `{ body }` or `{ error }`. */
async function github({
  path,
  token,
  method = "GET",
  body,
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS,
}) {
  try {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // The abort surfaces as a rejection and lands in the catch below.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { body: await res.json() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The head sha of `main`. Never throws. */
export async function readMainTip({
  repository,
  token,
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS,
}) {
  const { body, error } = await github({
    path: `/repos/${repository}/branches/main`,
    token,
    fetchImpl,
    timeoutMs,
  });
  if (error) return { tip: null, error };
  const sha = body?.commit?.sha;
  if (typeof sha !== "string" || sha.length === 0)
    return { tip: null, error: "response carried no commit sha" };
  return { tip: sha };
}

/** The commit last recorded as live for `service`, or null. Never throws. */
export async function readLive({
  repository,
  token,
  service,
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS,
}) {
  const query = new URLSearchParams({
    environment: DEPLOY_ENVIRONMENT,
    task: taskFor(service),
    per_page: "1",
  });
  const { body, error } = await github({
    path: `/repos/${repository}/deployments?${query}`,
    token,
    fetchImpl,
    timeoutMs,
  });
  if (error) return { live: null, error };
  if (!Array.isArray(body))
    return { live: null, error: "deployments response was not a list" };
  const sha = body[0]?.sha;
  return { live: typeof sha === "string" && sha.length > 0 ? sha : null };
}

/** The compare API's status for base...head. Never throws. */
export async function readRelation({
  repository,
  token,
  base,
  head,
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS,
}) {
  const { body, error } = await github({
    path: `/repos/${repository}/compare/${base}...${head}`,
    token,
    fetchImpl,
    timeoutMs,
  });
  if (error) return { error };
  const status = body?.status;
  if (typeof status !== "string")
    return { error: "compare response carried no status" };
  return { relation: status };
}

/** Everything `decide` needs, read from the API. Never throws. */
export async function readOrder({
  repository,
  token,
  sha,
  service,
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS,
}) {
  const io = { repository, token, fetchImpl, timeoutMs };
  const { live, error } = await readLive({ ...io, service });
  if (error) return { sha, live: null, error };
  if (!live) return { sha, live: null };
  const compared = await readRelation({ ...io, base: live, head: sha });
  if (compared.error) return { sha, live, error: compared.error };
  if (compared.relation !== "diverged")
    return { sha, live, relation: compared.relation };
  const { tip } = await readMainTip(io);
  return { sha, live, relation: "diverged", tip };
}

/**
 * Record `sha` as live for `service`: a deployment with a success status.
 * `auto_merge: false` because the ref is a commit, not a branch to update,
 * and `required_contexts: []` because CI already passed. Never throws.
 */
export async function recordDeploy({
  repository,
  token,
  sha,
  service,
  runUrl = "",
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS,
}) {
  const io = { token, fetchImpl, timeoutMs };
  const created = await github({
    ...io,
    method: "POST",
    path: `/repos/${repository}/deployments`,
    body: {
      ref: sha,
      task: taskFor(service),
      environment: DEPLOY_ENVIRONMENT,
      auto_merge: false,
      required_contexts: [],
      production_environment: true,
      description: `${service} shipped by the main pipeline`,
    },
  });
  if (created.error)
    return { error: `creating the deployment: ${created.error}` };
  const id = created.body?.id;
  if (typeof id !== "number")
    return { error: "the deployment response carried no id" };
  const status = await github({
    ...io,
    method: "POST",
    path: `/repos/${repository}/deployments/${id}/statuses`,
    body: {
      state: "success",
      ...(runUrl ? { log_url: runUrl } : {}),
      description: `${service} is live at ${short(sha)}`,
    },
  });
  if (status.error)
    return { id, error: `marking it successful: ${status.error}` };
  return { id };
}

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
    if (cond && cond[1].includes(SHIP_GATE)) current.gated = true;
  }
  return steps;
}

/** The raw text of one job's block, comments dropped, or null. */
function jobBlock(yaml, job) {
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
  return lines
    .slice(start, end)
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/**
 * Every problem with the shape of the deploy jobs, or an empty list. The
 * order step is the first step after checkout, everything after it is gated,
 * a record step exists, and the job holds its per-service concurrency group
 * without cancelling a deploy in flight.
 */
export function guardProblems(yaml) {
  const problems = [];
  for (const job of DEPLOY_JOBS) {
    const steps = deployJobSteps(yaml, job);
    if (!steps) {
      problems.push(`${job}: job or its steps not found`);
      continue;
    }
    const orderAt = steps.findIndex((s) => s.id === ORDER_STEP_ID);
    if (orderAt < 0) {
      problems.push(
        `${job}: no step with id "${ORDER_STEP_ID}" runs check-deploy-tip`,
      );
      continue;
    }
    if (orderAt > 1) {
      problems.push(
        `${job}: the order step is step ${orderAt + 1}; it must run right after checkout, before anything is built or credentials are assumed`,
      );
    }
    for (const step of steps.slice(orderAt + 1)) {
      if (!step.gated) {
        problems.push(
          `${job}: step "${step.name}" runs whether or not a newer commit is already live; add \`if: ${SHIP_GATE}\``,
        );
      }
    }
    if (!steps.some((s) => s.id === RECORD_STEP_ID)) {
      problems.push(
        `${job}: no step with id "${RECORD_STEP_ID}" records what shipped, so the next run cannot tell what is live`,
      );
    }
    const block = jobBlock(yaml, job) ?? "";
    if (
      !/\n    concurrency:\n      group: production-[^\n]+\n      cancel-in-progress: false\b/.test(
        block,
      )
    ) {
      problems.push(
        `${job}: missing the per-service lock (\`concurrency: { group: production-<service>, cancel-in-progress: false }\`); two runs could ship one service at once`,
      );
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
        "check-deploy-tip: a deploy job could move production backwards or ship one service twice at once.\n\n" +
          problems.map((p) => `  ${p}`).join("\n") +
          "\n\nAn older commit shipping after a newer one moves production backwards (#2874).",
      );
      process.exit(1);
    }
    console.log(
      "check-deploy-tip: every deploy job ships forward only, holds a per-service lock and records what shipped.",
    );
  } else {
    const sha = process.env.GITHUB_SHA;
    const repository = process.env.GITHUB_REPOSITORY;
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    const service = process.env.DEPLOY_SERVICE;
    if (!sha || !repository || !token || !service) {
      console.error(
        "check-deploy-tip: GITHUB_SHA, GITHUB_REPOSITORY, GH_TOKEN and DEPLOY_SERVICE must be set",
      );
      process.exit(1);
    }
    if (process.argv.includes("--record")) {
      const runUrl =
        process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : undefined;
      const recorded = await recordDeploy({
        repository,
        token,
        sha,
        service,
        runUrl,
      });
      if (recorded.error) {
        // A missing record is safe: the next run compares against an older
        // one, finds itself ahead, and deploys.
        console.log(
          `::warning::check-deploy-tip could not record ${service} at ${short(sha)} as live: ${recorded.error}`,
        );
      } else {
        console.log(
          `recorded ${service} live at ${short(sha)} (deployment ${recorded.id})`,
        );
      }
    } else {
      const verdict = decide(
        await readOrder({ repository, token, sha, service }),
      );
      if (verdict.warning) console.log(`::warning::${verdict.warning}`);
      console.log(
        `${verdict.deploy ? "deploying" : "::notice::skipping the deploy"} ${service}: ${verdict.reason}`,
      );
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `ship=${verdict.deploy}\n`);
      }
    }
  }
}
