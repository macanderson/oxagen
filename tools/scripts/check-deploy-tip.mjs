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
 * ## Never older than the schema (#5247)
 *
 * Code can be newer than what is live and still older than the schema. On
 * 2026-10-02 the run for `976b3f9` applied a migration that renamed the
 * context tables, and the run for the older `ddc1684` then shipped its API,
 * which queried the old names. Every steering call failed for six minutes.
 * Push runs now finish in commit order (ADR-287), but a re-run of an older
 * run's deploy job, or `manual-app-deploy` naming an older commit, can still
 * do it.
 *
 * So `migration-gate` records its commit as the `schema` service once every
 * store carries that commit's migrations. That record is the ledger a deploy
 * job can read: the order step runs before any credential, and Aurora's own
 * revision table is reachable only over SSM. A service that reads the
 * database skips when the recorded commit holds a migration file this commit
 * lacks, and the log names each one. `--schema` asks the same question for
 * `manual-app-deploy` and fails the job instead. The record never moves to a
 * commit that lacks a migration the current one holds, so a re-run of an
 * older gate cannot lower it.
 *
 * ## Modes
 *
 * 1. `node check-deploy-tip.mjs` (the `order` step, first after checkout)
 *    writes `ship=true|false` to $GITHUB_OUTPUT. Every later step carries
 *    `if: steps.order.outputs.ship == 'true'`, so a skipped run stays green.
 *    It also writes `live`, the commit last recorded for the service, or an
 *    empty string. `publish-installers` diffs from it, because one main run
 *    covers every merge since the run before it (ADR-287).
 * 2. `node check-deploy-tip.mjs --record` (the `record` step, last) records
 *    what shipped. A failed record only warns: the next run compares against
 *    an older record, sees itself ahead, and deploys, which is safe.
 *    `migration-gate` runs it with `DEPLOY_SERVICE=schema`.
 * 3. `node check-deploy-tip.mjs --schema` (`manual-app-deploy`) exits 1 when
 *    production's schema holds a migration `SOURCE_COMMIT` lacks.
 * 4. `node check-deploy-tip.mjs --guard` (from `check:contracts`) asserts
 *    the shape of every deploy job, the installer publish included: the
 *    order step, the gate on every later step, the record step and the
 *    per-service concurrency group. It also asserts that `migration-gate`
 *    records the schema and `manual-app-deploy` checks it. Dropping any of
 *    them would look like a tidy-up in review and would let a deploy move
 *    production backwards.
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

/**
 * The service `migration-gate` records once every store carries a commit's
 * migrations.
 */
export const SCHEMA_SERVICE = "schema";

/**
 * The directories whose files a store's ledger lists once applied: Atlas's
 * revision table for Postgres and the ClickHouse migrator's ledger. Neo4j
 * re-applies one idempotent schema.cypher and keeps no ledger.
 */
export const MIGRATION_DIRS = [
  "packages/database/atlas/migrations",
  "packages/telemetry/src/migrations",
];

/**
 * Services that open no database connection, so the schema never holds
 * their deploy back: deploy-web publishes static files (its header says why
 * it is not gated on migration-gate), and `desktop` dispatches a build.
 */
export const SCHEMA_FREE_SERVICES = ["web", "desktop"];

const short = (sha) => (sha ? sha.slice(0, 9) : "none");

/**
 * The order step's $GITHUB_OUTPUT lines. `live` is written only when it is a
 * full commit id, so nothing the API returns can add a line of its own.
 */
export function orderOutputs(live, deploy) {
  const id =
    typeof live === "string" && /^[0-9a-f]{40}$/.test(live) ? live : "";
  return `ship=${deploy}\nlive=${id}\n`;
}

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

/** Every file in `applied` that `contained` lacks, sorted. */
export function missingMigrations(applied, contained) {
  const have = new Set(contained);
  return [...new Set(applied)].filter((file) => !have.has(file)).sort();
}

/**
 * Whether `sha`'s code may run against production's schema, separated from
 * I/O like `decide`.
 *
 * @param {{
 *   sha: string,
 *   mark: string | null,
 *   missing?: string[],
 *   error?: string,
 * }} input
 *   `mark` is the commit last recorded as production's schema, or null when
 *   none is. `missing` lists the migration files it holds that `sha` lacks.
 *   `error` says an API call could not answer.
 * @returns {{ deploy: boolean, reason: string, warning?: string }}
 */
export function decideSchema({ sha, mark, missing = [], error }) {
  if (error) {
    return {
      deploy: true,
      reason: `could not read production's schema (${error}); deploying ${short(sha)} rather than blocking on the API`,
      warning: `check-deploy-tip could not read production's schema: ${error}`,
    };
  }
  if (!mark) {
    return {
      deploy: true,
      reason: `nothing is recorded as production's schema yet; deploying ${short(sha)}`,
    };
  }
  if (missing.length === 0) {
    return {
      deploy: true,
      reason: `${short(sha)} carries every migration production's schema holds (recorded at ${short(mark)})`,
    };
  }
  return {
    deploy: false,
    reason: `production's schema, recorded at ${short(mark)}, holds ${missing.length} migration(s) that ${short(sha)} lacks, so its code would query a schema it does not know (#5247): ${missing.join(", ")}`,
    warning: `production's schema is ahead of ${short(sha)}; ship a commit that carries its migrations instead (docs/runbooks/deploy-order.md)`,
  };
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
 * The contents API lists at most this many entries of a directory, so a
 * listing this long may be cut short.
 */
const CONTENTS_LIMIT = 1000;

/** The `.sql` files under MIGRATION_DIRS at `ref`, as paths. Never throws. */
export async function readMigrations({
  repository,
  token,
  ref,
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS,
}) {
  const files = [];
  for (const dir of MIGRATION_DIRS) {
    const { body, error } = await github({
      path: `/repos/${repository}/contents/${dir}?ref=${encodeURIComponent(ref)}`,
      token,
      fetchImpl,
      timeoutMs,
    });
    const at = `listing ${dir} at ${short(ref)}`;
    if (error) return { error: `${at}: ${error}` };
    if (!Array.isArray(body)) return { error: `${at}: not a directory` };
    if (body.length >= CONTENTS_LIMIT)
      return { error: `${at}: ${body.length} entries may be a cut-short list` };
    for (const entry of body) {
      if (entry?.type === "file" && /\.sql$/.test(entry?.name ?? ""))
        files.push(`${dir}/${entry.name}`);
    }
  }
  return { files };
}

/**
 * Everything `decideSchema` needs, read from the API. Never throws. When the
 * schema is recorded at `sha` itself, as it is in every push run whose own
 * gate just passed, nothing is listed.
 */
export async function readSchema({
  repository,
  token,
  sha,
  fetchImpl = fetch,
  timeoutMs = API_TIMEOUT_MS,
}) {
  const io = { repository, token, fetchImpl, timeoutMs };
  const { live: mark, error } = await readLive({
    ...io,
    service: SCHEMA_SERVICE,
  });
  if (error) return { sha, mark: null, error };
  if (!mark || mark === sha) return { sha, mark, missing: [] };
  const applied = await readMigrations({ ...io, ref: mark });
  if (applied.error) return { sha, mark, error: applied.error };
  const contained = await readMigrations({ ...io, ref: sha });
  if (contained.error) return { sha, mark, error: contained.error };
  return {
    sha,
    mark,
    missing: missingMigrations(applied.files, contained.files),
  };
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
  const gate = jobBlock(yaml, "migration-gate") ?? "";
  if (
    !/\n {10}DEPLOY_SERVICE: schema\n {8}run: node tools\/scripts\/check-deploy-tip\.mjs --record\n/.test(
      gate,
    ) ||
    !/\n {6}deployments: write\n/.test(gate)
  ) {
    problems.push(
      "migration-gate: no step records production's schema (`DEPLOY_SERVICE: schema`, `check-deploy-tip.mjs --record`, `deployments: write`); a deploy could then ship code older than the schema (#5247)",
    );
  }
  const manual = jobBlock(yaml, "manual-app-deploy") ?? "";
  if (
    !manual.includes('check-deploy-tip.mjs" --schema') ||
    !/\n {6}deployments: read\n/.test(manual)
  ) {
    problems.push(
      "manual-app-deploy: no step runs `check-deploy-tip.mjs --schema` with `deployments: read`; a dispatch could then ship code older than the schema (#5247)",
    );
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
  } else if (process.argv.includes("--schema")) {
    // manual-app-deploy ships the dispatch's input. GITHUB_SHA is main's head
    // there, and a workflow cannot override it.
    const sha = process.env.SOURCE_COMMIT || process.env.GITHUB_SHA;
    const repository = process.env.GITHUB_REPOSITORY;
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (!sha || !repository || !token) {
      console.error(
        "check-deploy-tip --schema: SOURCE_COMMIT, GITHUB_REPOSITORY and GH_TOKEN must be set",
      );
      process.exit(1);
    }
    const verdict = decideSchema(await readSchema({ repository, token, sha }));
    if (verdict.warning) console.log(`::warning::${verdict.warning}`);
    if (!verdict.deploy) {
      console.log(
        `::error::refusing to deploy ${short(sha)}: ${verdict.reason}`,
      );
      process.exit(1);
    }
    console.log(verdict.reason);
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
      // The schema record never drops a migration: a re-run of an older gate
      // records nothing when a newer gate's commit holds a file it lacks. An
      // API that cannot answer records, like every other failure here.
      const held =
        service === SCHEMA_SERVICE
          ? decideSchema(await readSchema({ repository, token, sha }))
          : null;
      if (held && !held.deploy) {
        console.log(
          `::warning::not recording production's schema at ${short(sha)}: ${held.reason}`,
        );
        process.exit(0);
      }
      if (held?.warning) console.log(`::warning::${held.warning}`);
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
        // one, finds itself ahead, and deploys. A missing schema record
        // leaves the older one in place until the next gate records.
        console.log(
          `::warning::check-deploy-tip could not record ${service} at ${short(sha)} as live: ${recorded.error}`,
        );
      } else {
        console.log(
          `recorded ${service} live at ${short(sha)} (deployment ${recorded.id})`,
        );
      }
    } else {
      const order = await readOrder({ repository, token, sha, service });
      let verdict = decide(order);
      if (verdict.warning) console.log(`::warning::${verdict.warning}`);
      if (verdict.deploy && !SCHEMA_FREE_SERVICES.includes(service)) {
        const schema = decideSchema(
          await readSchema({ repository, token, sha }),
        );
        if (schema.warning) console.log(`::warning::${schema.warning}`);
        if (schema.deploy) {
          console.log(`schema: ${schema.reason}`);
        } else {
          verdict = schema;
          if (process.env.GITHUB_STEP_SUMMARY) {
            appendFileSync(
              process.env.GITHUB_STEP_SUMMARY,
              `### ${service} did not deploy\n\n${schema.reason}\n\n`,
            );
          }
        }
      }
      console.log(
        `${verdict.deploy ? "deploying" : "::notice::skipping the deploy"} ${service}: ${verdict.reason}`,
      );
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          orderOutputs(order.live, verdict.deploy),
        );
      }
    }
  }
}
