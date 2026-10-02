/**
 * The rig for the steering repo live test (lane S11, #4723).
 *
 * It signs in to production Oxagen as the test user, calls the API over HTTP,
 * and calls GitHub over REST with the rig app's installation token. It opens
 * no browser and imports nothing from Playwright, so the cleanup script runs
 * it under tsx as well.
 *
 * It never prints a secret. An error names the method, the path, the status,
 * and at most 500 characters of the response body. No request header appears
 * in any message.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { SteeringPrGetOutput } from "@oxagen/oxagen/contracts/steering.pr.get";
import type { SteeringPrMergeOutput } from "@oxagen/oxagen/contracts/steering.pr.merge";
import type { SteeringPrOpenOutput } from "@oxagen/oxagen/contracts/steering.pr.open";
import type { SteeringProposalCreateOutput } from "@oxagen/oxagen/contracts/steering.proposal.create";
import type { SteeringProposalListOutput } from "@oxagen/oxagen/contracts/steering.proposal.list";
import type { SteeringRepoGetOutput } from "@oxagen/oxagen/contracts/steering_repo.get";
import type { SteeringRepoRepairOutput } from "@oxagen/oxagen/contracts/steering_repo.repair";
import type { WorkspaceArchiveOutput } from "@oxagen/oxagen/contracts/workspace.archive";
import type { WorkspaceCreateOutput } from "@oxagen/oxagen/contracts/workspace.create";
import type { WorkspaceListOutput } from "@oxagen/oxagen/contracts/workspace.list";

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** The check Oxagen posts on steering PRs and fails on every open PR when health drifts. */
export const STEERING_CHECK = "Oxagen steering";
/** The `external_id` of a check run a health read posted. */
export const HEALTH_CHECK_ID = "oxagen-steering-health";
/** The merge setting changed by the health drift exercise. */
export const MERGE_COMMIT_SETTING = "merge.allow_merge_commit";

// ── Suites ───────────────────────────────────────────────────────────────────

/**
 * A live suite that runs on this rig. Each suite names its workspaces with its
 * own prefix, and its sweep matches only that prefix, so one suite never
 * archives another's workspace or deletes another's repository.
 */
export interface LiveSuite {
  /** The first part of each run's workspace slug. */
  prefix: string;
  /** The suite's name, as its runbook section and its workspace names spell it. */
  label: string;
}

/** The steering repo live test (S11). Its workspaces are `live-<run id>-<attempt>`. */
export const STEERING_SUITE: LiveSuite = { prefix: "live", label: "Steering live test" };

/** The MCP Studio live test (M17). Its workspaces are `mcp-live-<run id>-<attempt>`. */
export const MCP_STUDIO_SUITE: LiveSuite = { prefix: "mcp-live", label: "MCP Studio live test" };

// ── Settings ─────────────────────────────────────────────────────────────────

/** Each value the rig reads from the environment. The workflow's first step checks the same names. */
const REQUIRED = [
  "STEERING_LIVE_OXAGEN_EMAIL",
  "STEERING_LIVE_OXAGEN_PASSWORD",
  "STEERING_LIVE_OXAGEN_ORG",
  "STEERING_LIVE_GITHUB_ORG",
  "STEERING_LIVE_GITHUB_TOKEN",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
] as const;

export interface Settings {
  email: string;
  password: string;
  /** The test Oxagen organization's slug. */
  oxagenOrg: string;
  /** The GitHub test organization's login. */
  githubOrg: string;
  githubToken: string;
  apiUrl: string;
  appUrl: string;
  /** The suite this run belongs to. */
  suite: LiveSuite;
  /** This run's workspace slug, `<suite prefix>-<run id>-<attempt>`. Its steering repo is `oxagen-<slug>`. */
  runSlug: string;
}

/** Reads the settings and names every missing one in a single error. */
export function readSettings(
  env: NodeJS.ProcessEnv = process.env,
  suite: LiveSuite = STEERING_SUITE,
): Settings {
  const missing = REQUIRED.filter((name) => (env[name] ?? "") === "");
  if (missing.length > 0) {
    throw new Error(
      `The ${suite.label} is missing ${missing.join(", ")}. The "${suite.label}" section of docs/specs/github-app/github-app-setup.md says where each one comes from.`,
    );
  }
  const value = (name: (typeof REQUIRED)[number]): string => env[name] ?? "";
  const runId = value("GITHUB_RUN_ID");
  const attempt = value("GITHUB_RUN_ATTEMPT");
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(attempt)) {
    throw new Error("GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must be digits.");
  }
  return {
    email: value("STEERING_LIVE_OXAGEN_EMAIL"),
    password: value("STEERING_LIVE_OXAGEN_PASSWORD"),
    oxagenOrg: value("STEERING_LIVE_OXAGEN_ORG"),
    githubOrg: value("STEERING_LIVE_GITHUB_ORG"),
    githubToken: value("STEERING_LIVE_GITHUB_TOKEN"),
    apiUrl: optional(env, "STEERING_LIVE_API_URL", "https://api.oxagen.sh"),
    appUrl: optional(env, "STEERING_LIVE_APP_URL", "https://app.oxagen.sh"),
    suite,
    runSlug: `${suite.prefix}-${runId}-${attempt}`,
  };
}

/** An optional URL: unset or empty means the production default. */
function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const url = env[name];
  return (url === undefined || url === "" ? fallback : url).replace(/\/+$/, "");
}

/** A workspace some run of the suite created. */
function suiteSlug(suite: LiveSuite): RegExp {
  return new RegExp(`^${suite.prefix}-\\d+-\\d+$`);
}

/** A steering repo some run of the suite created, with the `-2` suffix a name collision adds. */
function suiteRepo(suite: LiveSuite): RegExp {
  return new RegExp(`^oxagen-${suite.prefix}-\\d+-\\d+(?:-\\d+)?$`);
}

/** Matches this run's steering repo name, with or without a collision suffix. */
export function runRepoName(settings: Settings): RegExp {
  return new RegExp(`^oxagen-${settings.runSlug}(?:-\\d+)?$`);
}

/** Matches this run's steering repo full name, `<github org>/oxagen-<slug>`. */
export function runRepoFullName(settings: Settings): RegExp {
  return new RegExp(`^${settings.githubOrg}/oxagen-${settings.runSlug}(?:-\\d+)?$`, "i");
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** A response outside 2xx. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** At most 500 characters of a response body, on one line. */
export function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 500 ? `${flat.slice(0, 500)}...` : flat;
}

/** Parses a JSON body against a local schema, naming the request in any error. */
export function parseBody<S extends z.ZodType>(
  what: string,
  text: string,
  schema: S,
): z.output<S> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${what} answered a body that is not JSON: ${excerpt(text)}`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${what} answered a body the suite does not recognize: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

// ── Oxagen ───────────────────────────────────────────────────────────────────

export interface Oxagen {
  call<S extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    schema: S,
  ): Promise<z.output<S>>;
}

/** better-auth names the cookie with the `__Secure-` prefix over https. */
const SESSION_COOKIE = /^(?:__Secure-)?oxagen\.session_token=/;

const authError = z.object({ code: z.string() });

/**
 * How long a refused sign-in waits before its one retry. Production allows
 * five sign-ins a minute from one address, and better-auth counts the minute
 * from the last sign-in, so a wait past one minute always clears it.
 */
const SIGN_IN_LIMIT_WAIT_MS = 61 * SECOND;

function postSignIn(settings: Settings): Promise<Response> {
  return fetch(`${settings.appUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: settings.appUrl },
    body: JSON.stringify({ email: settings.email, password: settings.password }),
  });
}

/**
 * Signs in with email and password and keeps the session cookie for the API.
 * A failure names the status and the better-auth error code, never the body.
 *
 * Playwright starts a new worker after each failed test, and each worker
 * signs in again, so a run with several failures can reach the sign-in
 * limit. A sign-in the limit refuses waits a minute and tries once more.
 */
export async function signIn(settings: Settings): Promise<Oxagen> {
  let res = await postSignIn(settings);
  if (res.status === 429) {
    await sleep(SIGN_IN_LIMIT_WAIT_MS);
    res = await postSignIn(settings);
  }
  if (!res.ok) {
    // An error body that is not JSON names no code.
    const json: unknown = await res.json().catch(() => null);
    const parsed = authError.safeParse(json);
    const code = parsed.success ? parsed.data.code : null;
    const check =
      res.status === 429
        ? "Production limits sign-ins to five a minute from one address, so wait a minute before the next run."
        : "Check STEERING_LIVE_OXAGEN_EMAIL and STEERING_LIVE_OXAGEN_PASSWORD.";
    throw new Error(
      `Sign-in as the test Oxagen user answered ${String(res.status)}${code === null ? "" : ` (${code})`}. ${check}`,
    );
  }
  const cookie = res.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .find((pair) => SESSION_COOKIE.test(pair));
  if (cookie === undefined) {
    throw new Error(
      "Sign-in answered 200 with no session cookie. Turn off two-factor sign-in for the test Oxagen user.",
    );
  }

  return {
    async call<S extends z.ZodType>(
      method: "GET" | "POST",
      path: string,
      body: unknown,
      schema: S,
    ): Promise<z.output<S>> {
      const res = await fetch(`${settings.apiUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          cookie,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const what = `${method} ${path}`;
      if (!res.ok) {
        throw new HttpError(res.status, `${what} answered ${String(res.status)}: ${excerpt(text)}`);
      }
      return parseBody(what, text, schema);
    },
  };
}

/** Signs in, or reports why not, so cleanup can still delete repositories. */
export async function trySignIn(
  settings: Settings,
): Promise<{ ox: Oxagen | null; problem: string | null }> {
  try {
    return { ox: await signIn(settings), problem: null };
  } catch (error) {
    return { ox: null, problem: messageOf(error) };
  }
}

// Local schemas for the fields the suite reads. Each Fits line below fails
// the typecheck when a shared contract stops fitting its local schema, so a
// contract change breaks CI on the pull request instead of the live run.

const provisionStatus = z.enum(["provisioning", "ready", "failed", "blocked"]);
/** The read adds `not_started` for a workspace that never recorded a setup (#4875). */
const readStatus = z.enum([
  "not_started",
  "provisioning",
  "ready",
  "failed",
  "blocked",
]);
const healthState = z.enum(["healthy", "drifted", "disconnected", "diverged"]);
export type HealthState = z.infer<typeof healthState>;

export const steeringRepoView = z.object({
  status: readStatus,
  failedStep: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  repository: z.object({ fullName: z.string(), url: z.string() }).nullable(),
  publishedVersion: z.number().int().nullable(),
  health: healthState.nullable(),
  differences: z.array(
    z.object({ setting: z.string(), expected: z.string(), actual: z.string() }),
  ),
});
export type SteeringRepoView = z.output<typeof steeringRepoView>;

const repairResult = z.object({ health: healthState });

const steeringPrView = z.object({
  proposalId: z.string(),
  lineageId: z.string(),
  status: z.enum([
    "proposed",
    "pr_open",
    "checks_running",
    "checks_passed",
    "checks_failed",
    "merged",
    "rejected",
  ]),
  pr: z
    .object({
      number: z.number().int(),
      url: z.string(),
      repository: z.string(),
      branch: z.string(),
      headSha: z.string().nullable(),
      path: z.string(),
    })
    .nullable(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(["pending", "running", "passed", "failed"]),
      summary: z.string(),
    }),
  ),
});
export type SteeringPrView = z.output<typeof steeringPrView>;

const mergeFacts = {
  proposalId: z.string(),
  status: z.literal("merged"),
  mergedCommit: z.string(),
  bundleVersion: z.object({ before: z.number().int(), after: z.number().int() }),
  publishedVersion: z.number().int().nullable(),
};

// The merge answers a union on `kind`: a governance proposal carries the mode
// it landed, every record kind carries its record (#4795, ADR-232), and a
// steering PR proposal carries its pull request (#5122, ADR-265).
const mergeResult = z.union([
  z.object({
    ...mergeFacts,
    kind: z.literal("governance"),
    governance: z.object({ mode: z.string(), path: z.string() }),
  }),
  z.object({
    ...mergeFacts,
    kind: z.string(),
    record: z.object({ lineageId: z.string(), version: z.number().int(), path: z.string() }),
  }),
  z.object({
    ...mergeFacts,
    kind: z.string(),
    pullRequest: z.object({ number: z.number().int(), branch: z.string() }),
    retired: z.array(z.string()),
  }),
]);

const proposalCreated = z.object({
  proposalId: z.string(),
  lineageId: z.string(),
  status: z.literal("proposed"),
});

const proposalList = z.object({
  proposals: z.array(z.object({ id: z.string(), lineageId: z.string() })),
});

const workspaceCreated = z.object({
  publicId: z.string(),
  slug: z.string(),
  steering_repo: z.object({ status: provisionStatus }),
});

const workspaceList = z.object({
  workspaces: z.array(z.object({ publicId: z.string(), slug: z.string() })),
});

const workspaceArchived = z.object({ id: z.string(), slug: z.string(), archivedAt: z.string() });

type Fits<Contract, Local> = [Contract] extends [Local] ? true : false;
type Assert<T extends true> = T;

/** One entry per route the suite calls. An entry that stops fitting fails the typecheck. */
export type ContractFit = [
  Assert<Fits<SteeringRepoGetOutput, SteeringRepoView>>,
  Assert<Fits<SteeringRepoRepairOutput, z.output<typeof repairResult>>>,
  Assert<Fits<SteeringPrOpenOutput, SteeringPrView>>,
  Assert<Fits<SteeringPrGetOutput, SteeringPrView>>,
  Assert<Fits<SteeringPrMergeOutput, z.output<typeof mergeResult>>>,
  Assert<Fits<SteeringProposalCreateOutput, z.output<typeof proposalCreated>>>,
  Assert<Fits<SteeringProposalListOutput, z.output<typeof proposalList>>>,
  Assert<Fits<WorkspaceCreateOutput, z.output<typeof workspaceCreated>>>,
  Assert<Fits<WorkspaceListOutput, z.output<typeof workspaceList>>>,
  Assert<Fits<WorkspaceArchiveOutput, z.output<typeof workspaceArchived>>>,
];

function orgPath(settings: Settings): string {
  return `/v1/${encodeURIComponent(settings.oxagenOrg)}`;
}

/** A workspace-scoped API path: `/v1/<org>/<workspace><rest>`. */
export function workspacePath(settings: Settings, slug: string, rest: string): string {
  return `${orgPath(settings)}/${encodeURIComponent(slug)}${rest}`;
}

export function createWorkspace(ox: Oxagen, settings: Settings) {
  return ox.call(
    "POST",
    `${orgPath(settings)}/workspaces`,
    { name: `${settings.suite.label} ${settings.runSlug}`, slug: settings.runSlug },
    workspaceCreated,
  );
}

export function readSteeringRepo(ox: Oxagen, settings: Settings): Promise<SteeringRepoView> {
  return ox.call(
    "GET",
    workspacePath(settings, settings.runSlug, "/context/steering/repo"),
    undefined,
    steeringRepoView,
  );
}

export function repairSteeringRepo(ox: Oxagen, settings: Settings) {
  return ox.call(
    "POST",
    workspacePath(settings, settings.runSlug, "/context/steering/repo/repair"),
    {},
    repairResult,
  );
}

/** Proposes one steering record, a workspace rule, on a lineage this run owns. */
export function proposeRecord(
  ox: Oxagen,
  settings: Settings,
  lineageId: string,
  statement: string,
) {
  return ox.call(
    "POST",
    workspacePath(settings, settings.runSlug, "/steering/proposals/create"),
    {
      record: {
        lineageId,
        kind: "rule",
        force: "should",
        sharingScope: "workspace",
        statement,
      },
      rationale: `The ${settings.suite.label} run ${settings.runSlug} proposes this steering record. The run deletes its repository when it ends.`,
      source: "steering-live-test",
      createOnly: true,
    },
    proposalCreated,
  );
}

/** Finds the newest proposal on a lineage, or null when there is none. */
export async function findProposal(
  ox: Oxagen,
  settings: Settings,
  lineageId: string,
): Promise<string | null> {
  const listed = await ox.call(
    "POST",
    workspacePath(settings, settings.runSlug, "/steering/proposals"),
    { lineageId, limit: 1 },
    proposalList,
  );
  return listed.proposals[0]?.id ?? null;
}

export function openSteeringPr(ox: Oxagen, settings: Settings, proposalId: string) {
  return ox.call(
    "POST",
    workspacePath(settings, settings.runSlug, "/steering/prs/open"),
    { proposalId },
    steeringPrView,
  );
}

export function readSteeringPr(ox: Oxagen, settings: Settings, proposalId: string) {
  return ox.call(
    "POST",
    workspacePath(settings, settings.runSlug, "/steering/prs/get"),
    { proposalId },
    steeringPrView,
  );
}

export function mergeSteeringPr(ox: Oxagen, settings: Settings, proposalId: string) {
  return ox.call(
    "POST",
    workspacePath(settings, settings.runSlug, "/steering/prs/merge"),
    { proposalId },
    mergeResult,
  );
}

function listWorkspaces(ox: Oxagen, settings: Settings) {
  return ox.call(
    "POST",
    "/v1/user/workspaces",
    { orgSlug: settings.oxagenOrg, includeArchived: false },
    workspaceList,
  );
}

function archiveWorkspace(
  ox: Oxagen,
  settings: Settings,
  workspace: { publicId: string; slug: string },
) {
  return ox.call(
    "POST",
    workspacePath(settings, workspace.slug, "/workspaces/archive"),
    { workspaceId: workspace.publicId },
    workspaceArchived,
  );
}

// ── GitHub ───────────────────────────────────────────────────────────────────

const githubRepo = z.object({ name: z.string(), full_name: z.string(), created_at: z.string() });
export type GithubRepo = z.output<typeof githubRepo>;


const githubPull = z.object({
  number: z.number().int(),
  state: z.string(),
  merged: z.boolean().optional(),
  head: z.object({ sha: z.string() }),
});

const githubCheckRun = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  external_id: z.string().nullable().optional(),
});
export type GithubCheckRun = z.output<typeof githubCheckRun>;

const PAGE = 100;

export interface GithubRig {
  orgRepos(org: string): Promise<GithubRepo[]>;
  allowsMergeCommits(fullName: string): Promise<boolean>;
  setMergeCommits(fullName: string, allowed: boolean): Promise<void>;
  approvePr(fullName: string, number: number): Promise<void>;
  getPr(fullName: string, number: number): Promise<z.output<typeof githubPull>>;
  openPulls(fullName: string): Promise<Array<{ number: number; headSha: string }>>;
  steeringCheckRuns(fullName: string, sha: string): Promise<GithubCheckRun[]>;
  /** Deletes a repository. Answers false when it was already gone. */
  deleteRepo(fullName: string): Promise<boolean>;
}

function repoPath(fullName: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
    throw new Error(`"${fullName}" is not an owner/name repository name.`);
  }
  return `/repos/${fullName}`;
}

export function githubRig(token: string): GithubRig {
  async function send(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }

  async function call<S extends z.ZodType>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    schema: S,
  ): Promise<z.output<S>> {
    const res = await send(method, path, body);
    const what = `GitHub ${method} ${path}`;
    if (res.status < 200 || res.status > 299) {
      throw new HttpError(res.status, `${what} answered ${String(res.status)}: ${excerpt(res.text)}`);
    }
    return parseBody(what, res.text, schema);
  }

  async function noContent(method: "DELETE", path: string): Promise<number> {
    const res = await send(method, path);
    if (res.status !== 204 && res.status !== 404) {
      throw new HttpError(
        res.status,
        `GitHub ${method} ${path} answered ${String(res.status)}: ${excerpt(res.text)}`,
      );
    }
    return res.status;
  }

  return {
    async orgRepos(org) {
      const repos: GithubRepo[] = [];
      for (let page = 1; ; page += 1) {
        const batch = await call(
          "GET",
          `/orgs/${encodeURIComponent(org)}/repos?type=all&per_page=${String(PAGE)}&page=${String(page)}`,
          undefined,
          z.array(githubRepo),
        );
        repos.push(...batch);
        if (batch.length < PAGE) return repos;
      }
    },

    async allowsMergeCommits(fullName) {
      const repo = await call(
        "GET",
        repoPath(fullName),
        undefined,
        z.object({ allow_merge_commit: z.boolean() }),
      );
      return repo.allow_merge_commit;
    },

    async setMergeCommits(fullName, allowed) {
      await call(
        "PATCH",
        repoPath(fullName),
        { allow_merge_commit: allowed },
        z.object({ allow_merge_commit: z.boolean() }),
      );
    },

    async approvePr(fullName, number) {
      await call(
        "POST",
        `${repoPath(fullName)}/pulls/${String(number)}/reviews`,
        { event: "APPROVE", body: "The steering live test approves this steering PR." },
        z.object({ id: z.number().int() }),
      );
    },

    getPr(fullName, number) {
      return call("GET", `${repoPath(fullName)}/pulls/${String(number)}`, undefined, githubPull);
    },

    async openPulls(fullName) {
      const pulls = await call(
        "GET",
        `${repoPath(fullName)}/pulls?state=open&per_page=${String(PAGE)}`,
        undefined,
        z.array(githubPull),
      );
      return pulls.map((p) => ({ number: p.number, headSha: p.head.sha }));
    },

    async steeringCheckRuns(fullName, sha) {
      const runs = await call(
        "GET",
        `${repoPath(fullName)}/commits/${encodeURIComponent(sha)}/check-runs?check_name=${encodeURIComponent(STEERING_CHECK)}&filter=all&per_page=${String(PAGE)}`,
        undefined,
        z.object({ check_runs: z.array(githubCheckRun) }),
      );
      return runs.check_runs;
    },

    async deleteRepo(fullName) {
      return (await noContent("DELETE", repoPath(fullName))) === 204;
    },
  };
}

// ── Polling ──────────────────────────────────────────────────────────────────

export type Probe<T> = { done: true; value: T } | { done: false; state: string };

/** A probe that reached its goal. */
export function reached<T>(value: T): Probe<T> {
  return { done: true, value };
}

/** A probe that has not, with the state it saw. */
export function waiting(state: string): Probe<never> {
  return { done: false, state };
}

/**
 * Probes until the probe answers done or the time runs out. The last probe
 * runs at the deadline, and the error names the last state it saw. A probe
 * that throws fails the poll at once.
 */
export async function poll<T>(
  what: string,
  options: { timeoutMs: number; intervalMs: number; since?: number },
  probe: () => Promise<Probe<T>>,
): Promise<T> {
  const start = options.since ?? Date.now();
  const deadline = start + options.timeoutMs;
  for (;;) {
    const result = await probe();
    if (result.done) return result.value;
    const left = deadline - Date.now();
    if (left <= 0) {
      const waited = Math.round((Date.now() - start) / SECOND);
      throw new Error(`${what}: not reached after ${String(waited)} s. Last state: ${result.state}`);
    }
    await sleep(Math.min(options.intervalMs, left));
  }
}

export function describeRepo(view: SteeringRepoView): string {
  return [
    `status ${view.status}`,
    `health ${view.health ?? "unread"}`,
    `published version ${view.publishedVersion === null ? "none" : String(view.publishedVersion)}`,
    `differences [${view.differences.map((d) => d.setting).join(", ")}]`,
  ].join(", ");
}

/** Waits for the steering repo to read a health state. */
export function waitForHealth(
  ox: Oxagen,
  settings: Settings,
  health: HealthState,
  timeoutMs: number,
): Promise<SteeringRepoView> {
  return poll(`steering repo health ${health}`, { timeoutMs, intervalMs: 5 * SECOND }, async () => {
    const view = await readSteeringRepo(ox, settings);
    return view.health === health ? reached(view) : waiting(describeRepo(view));
  });
}

/**
 * Waits up to five minutes for the run's steering repo to finish provisioning.
 * A failed or blocked provisioning fails at once, with its step and error.
 */
export function waitForProvisioned(ox: Oxagen, settings: Settings): Promise<SteeringRepoView> {
  return poll(
    `workspace ${settings.runSlug} steering repo provisioned`,
    { timeoutMs: 5 * MINUTE, intervalMs: 5 * SECOND },
    async () => {
      const view = await readSteeringRepo(ox, settings);
      if (view.status === "failed" || view.status === "blocked") {
        const why = view.error === null ? "no error" : `${view.error.code}: ${view.error.message}`;
        throw new Error(
          `Provisioning stopped with status ${view.status} at step ${view.failedStep ?? "unknown"} (${why}).`,
        );
      }
      return view.status === "ready" ? reached(view) : waiting(describeRepo(view));
    },
  );
}

const SETTLED = new Set(["checks_passed", "checks_failed", "merged", "rejected"]);

/** Waits for a steering PR's checks to finish. Answers the PR whatever the outcome. */
export function waitForChecks(
  ox: Oxagen,
  settings: Settings,
  proposalId: string,
): Promise<SteeringPrView> {
  return poll(
    `steering PR ${proposalId} checks finished`,
    { timeoutMs: 5 * MINUTE, intervalMs: 5 * SECOND },
    async () => {
      const pr = await readSteeringPr(ox, settings, proposalId);
      return SETTLED.has(pr.status) ? reached(pr) : waiting(`status ${pr.status}`);
    },
  );
}

export function describeChecks(pr: SteeringPrView): string {
  return pr.checks
    .map((c) => `${c.name} ${c.status}${c.summary === "" ? "" : `: ${c.summary}`}`)
    .join("; ");
}

/** The newest "Oxagen steering" check run on a commit, or null when it has none. */
export function newestRun(runs: GithubCheckRun[]): GithubCheckRun | null {
  return runs.reduce<GithubCheckRun | null>(
    (newest, run) => (newest === null || run.id > newest.id ? run : newest),
    null,
  );
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/** How old a leftover test repository is before the sweep deletes it. */
const SWEEP_AGE_MS = 24 * 60 * MINUTE;

function summarize(problems: string[]): Error {
  return new Error(`Cleanup left work behind:\n- ${problems.join("\n- ")}`);
}

/**
 * Archives this run's workspace and deletes its steering repo. It runs twice
 * on every run, in the suite teardown and in the workflow's always() step,
 * so a second pass finds nothing and succeeds.
 */
export async function cleanupRun(
  ox: Oxagen | null,
  gh: GithubRig,
  settings: Settings,
): Promise<string[]> {
  const done: string[] = [];
  const problems: string[] = [];

  if (ox !== null) {
    try {
      const listed = await listWorkspaces(ox, settings);
      const mine = listed.workspaces.find((w) => w.slug === settings.runSlug);
      if (mine !== undefined) {
        await archiveWorkspace(ox, settings, mine);
        done.push(`Archived workspace ${mine.slug}.`);
      }
    } catch (error) {
      problems.push(`Archive workspace ${settings.runSlug}: ${messageOf(error)}`);
    }
  }

  try {
    const pattern = runRepoName(settings);
    const repos = await gh.orgRepos(settings.githubOrg);
    for (const repo of repos.filter((r) => pattern.test(r.name))) {
      try {
        if (await gh.deleteRepo(repo.full_name)) done.push(`Deleted repository ${repo.full_name}.`);
      } catch (error) {
        problems.push(`Delete repository ${repo.full_name}: ${messageOf(error)}`);
      }
    }
  } catch (error) {
    problems.push(`List repositories in ${settings.githubOrg}: ${messageOf(error)}`);
  }

  if (problems.length > 0) throw summarize(problems);
  return done;
}

/**
 * Clears what earlier runs of this run's suite left behind. It archives every
 * other active workspace the suite created, since the live workflows share one
 * concurrency group and run one job at a time. It deletes the suite's test
 * repositories older than one day.
 */
export async function sweepOld(
  ox: Oxagen | null,
  gh: GithubRig,
  settings: Settings,
): Promise<string[]> {
  const done: string[] = [];
  const problems: string[] = [];

  if (ox !== null) {
    try {
      const listed = await listWorkspaces(ox, settings);
      const mine = suiteSlug(settings.suite);
      const leftovers = listed.workspaces.filter(
        (w) => mine.test(w.slug) && w.slug !== settings.runSlug,
      );
      for (const workspace of leftovers) {
        try {
          await archiveWorkspace(ox, settings, workspace);
          done.push(`Archived leftover workspace ${workspace.slug}.`);
        } catch (error) {
          problems.push(`Archive workspace ${workspace.slug}: ${messageOf(error)}`);
        }
      }
    } catch (error) {
      problems.push(`List workspaces in ${settings.oxagenOrg}: ${messageOf(error)}`);
    }
  }

  try {
    const cutoff = Date.now() - SWEEP_AGE_MS;
    const repos = await gh.orgRepos(settings.githubOrg);
    const pattern = suiteRepo(settings.suite);
    const old = repos.filter((r) => pattern.test(r.name) && Date.parse(r.created_at) < cutoff);
    for (const repo of old) {
      try {
        if (await gh.deleteRepo(repo.full_name)) {
          done.push(`Deleted leftover repository ${repo.full_name}.`);
        }
      } catch (error) {
        problems.push(`Delete repository ${repo.full_name}: ${messageOf(error)}`);
      }
    }
  } catch (error) {
    problems.push(`List repositories in ${settings.githubOrg}: ${messageOf(error)}`);
  }

  if (problems.length > 0) throw summarize(problems);
  return done;
}

/**
 * A suite's Playwright global teardown. It archives the run's workspace and
 * deletes its steering repo, pass or fail. The workflow's always() step runs
 * the same cleanup again, which covers a teardown that never ran, such as a
 * job cancelled mid-suite.
 */
export async function teardownSuite(suite: LiveSuite): Promise<void> {
  const settings = readSettings(process.env, suite);
  const { ox, problem } = await trySignIn(settings);
  if (problem !== null) {
    console.error(`Teardown could not sign in, so the workspace stays active: ${problem}`);
  }
  const done = await cleanupRun(ox, githubRig(settings.githubToken), settings);
  for (const line of done) console.log(line);
}
