/**
 * `oxagen steering` — is this checkout running on the records that are in
 * force, and what should happen when it is not.
 *
 * A Context PR merges a record onto the repository's production branch
 * (ADR-061; `docs/specs/steering/README.md`). A developer on a feature
 * branch keeps whatever `.oxagen/` their branch point had, so the longer the
 * branch lives the more likely their agent is steering on records nobody
 * uses any more.
 *
 * Four verbs, three audiences:
 *
 *   status  a person, asking
 *   sync    a person, fixing
 *   gate    an agent harness, on every prompt (this is the one that matters)
 *   hooks   a person, installing `gate` into their harness
 *
 * `gate` is the whole reason the rest exists. Oxagen governs whatever agent a
 * team already runs, and the harnesses do not agree on how a prompt is
 * intercepted, so the durable shape is one command with a stable contract
 * that every harness can call:
 *
 *   exit 0  the prompt may run (a warning still exits 0)
 *   exit 2  the prompt is refused, with the reason on stderr
 *   stdout  the harness's own JSON, chosen by `--harness`
 *
 * A harness Oxagen has never heard of gets the exit-code contract, which is
 * the one every shell already understands. Adding first-class support for a
 * new agent is a renderer in `@oxagen/steering-freshness`, never a change
 * here.
 *
 * Output discipline (ADR-023 §4): `--json` puts the contract payload on
 * stdout as one line, progress and banners go to stderr, and a usage error
 * exits 2 while an API failure exits 1. `gate` is the deliberate exception,
 * because its exit code is a decision rather than a diagnosis, and its
 * stdout belongs to the harness.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import {
  checkSteeringFreshness,
  evaluateGate,
  hookStatus,
  installHook,
  loadSteeringSettings,
  readEmergencyOverride,
  removeHook,
  renderGate,
  resolveSteeringPolicy,
  syncSteering,
  HARNESSES,
  INSTALLABLE,
  PROJECT_DIR_NAME,
  type FreshnessVerdict,
  type InstallableHarness,
  type PlatformSignal,
  type SteeringPolicy,
  type SteeringPolicyFile,
} from "@oxagen/steering-freshness";
import { ApiError, apiPostOrThrow } from "../lib/api.js";
import { readWorkspaceLink, writeWorkspaceLink } from "./workspace-link.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

// ── Where the project is ─────────────────────────────────────────────────────

/**
 * Walk up from `start` looking for a `.oxagen/` directory.
 *
 * The same search `@oxagen/mcp-config` does, and for the same reason: a
 * prompt is submitted from wherever the developer happens to be, which is
 * usually not the repository root. Falls back to `start`, where the check
 * will answer `unknown` and say why, rather than silently examining some
 * ancestor directory that happens to have a `.oxagen/` in it.
 */
export function findProjectRoot(start: string): string {
  const { root } = parsePath(start);
  // The search never crosses the repository root. Inside a nested repository
  // or a submodule with no `.oxagen/`, an unbounded walk found the OUTER
  // checkout's, and the gate then read that workspace, compared that
  // repository, and could block or sync it while the agent was working in the
  // inner one. The outer checkout is a different repository, full stop.
  const gitRoot = gitRootOr(start);
  // git answers with the real path; `start` may reach the same directory
  // through a symlink (`/tmp` on macOS), and the two must compare equal.
  const from = realpathOr(start);
  // Outside a repository there is no root to stop at, and the old behaviour
  // (walk to the filesystem root, fall back to where we started) stands.
  const inRepo = gitRoot !== null;
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, PROJECT_DIR_NAME))) return dir;
    if (inRepo && dir === gitRoot) return gitRoot;
    if (dir === root) return inRepo ? gitRoot : from;
    const parent = dirname(dir);
    if (parent === dir) return inRepo ? gitRoot : from;
    dir = parent;
  }
}

/**
 * The repository root containing `start`, or null outside a repository.
 *
 * With no `.oxagen/` anywhere above (a branch cut before the repository's
 * first records), falling back to the starting directory anchored the sync
 * in a subdirectory while the check compared from the repository root. The
 * missing paths it reported are root-relative, so `git restore` from the
 * subdirectory matched none of them and threw, and the gate caught that and
 * allowed the prompt: `blockStaleRuns` bypassed, silently.
 */
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function gitRootOr(start: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// ── The platform half of "both, git first" ───────────────────────────────────

/** What `get_steering_freshness` answers. */
interface PlatformFreshness {
  steeringVersion: number;
  headCommit: string | null;
  /** `owner/repo` of the workspace's main repository, or null if none is bound. */
  repository: string | null;
  defaultBranch: string | null;
  policy: SteeringPolicyFile | null;
}

/**
 * Ask Oxagen what is in force, and never let the answer stop anything.
 *
 * Git is the primary signal and this is the check on it: it catches the
 * case git cannot see, where the remote-tracking ref on disk predates a
 * promotion because the fetch failed or never ran. It is also the only way
 * the workspace's own policy reaches a developer's machine.
 *
 * Every failure is swallowed to null. This runs on the path of a prompt, on
 * machines that are offline, unauthenticated, or pointed at a workspace that
 * has not bound a repository yet, and in none of those is "stop working" the
 * right answer.
 *
 * `apiPostOrThrow`, never `apiPost`: the latter calls `process.exit(1)` on
 * any failure, which inside a prompt-submission hook would kill the prompt
 * every time the API was unreachable. The whole point of this call is that
 * it is optional.
 */
/**
 * How long the optional platform read may take on the path of a prompt.
 *
 * The hook has 20 seconds. A connection that hangs rather than failing (a
 * blackholed API, a half-up VPN) spent all of it here, before the git check
 * had run; both harnesses read the timeout as a hook failure and allowed the
 * prompt, so every prompt during such an outage paused for 20 seconds and
 * then ran without the workspace's gates. Three seconds is longer than the
 * call takes and short enough that the git check, which is the primary
 * signal, still runs inside the budget.
 */
const PLATFORM_READ_TIMEOUT_MS = 3_000;

async function readPlatform(
  projectRoot: string,
  link: CheckoutLink | undefined,
): Promise<PlatformFreshness | null> {
  const ask = (scope: { org: string; ws: string } | undefined) =>
    apiPostOrThrow<PlatformFreshness>(
      "context/steering/freshness",
      {},
      scope,
      { timeoutMs: PLATFORM_READ_TIMEOUT_MS },
    );
  try {
    return await ask(link?.scope);
  } catch (error) {
    // The link names the workspace by SLUG, and the API resolves slugs. An
    // org or a workspace renamed after `oxagen init` therefore answered 404
    // for every linked checkout, and swallowing that here dropped the
    // workspace's gates until somebody relinked. The link also carries the
    // ids, which do not change. On a 404 they are resolved to today's slugs
    // through the same lists `oxagen init` reads, the read is retried once,
    // and the link is rewritten so the next prompt is direct.
    if (!link || !(error instanceof ApiError) || error.status !== 404)
      return null;
    try {
      const current = await currentSlugsFor(link);
      if (!current) return null;
      const answer = await ask(current);
      rewriteLinkSlugs(projectRoot, current);
      return answer;
    } catch {
      return null;
    }
  }
}

/** What `.oxagen/workspace.json` says, as the platform read needs it. */
interface CheckoutLink {
  scope: { org: string; ws: string };
  orgId: string;
  workspaceId: string;
}

/**
 * Today's slugs for the ids a link was written with, or null when either is
 * no longer reachable by this user.
 */
async function currentSlugsFor(
  link: CheckoutLink,
): Promise<{ org: string; ws: string } | null> {
  const { userApiPostOrThrow } = await import("../lib/api.js");
  const { organizations } = await userApiPostOrThrow<{
    organizations: { id: string; slug: string }[];
  }>("organizations", {});
  const org = organizations.find((o) => o.id === link.orgId);
  if (!org) return null;
  const { workspaces } = await userApiPostOrThrow<{
    workspaces: { id: string; slug: string }[];
  }>("workspaces", { orgSlug: org.slug });
  const ws = workspaces.find((w) => w.id === link.workspaceId);
  if (!ws) return null;
  return { org: org.slug, ws: ws.slug };
}

function rewriteLinkSlugs(
  projectRoot: string,
  current: { org: string; ws: string },
): void {
  const stored = readWorkspaceLink(projectRoot);
  if (!stored) return;
  try {
    writeWorkspaceLink(projectRoot, {
      ...stored,
      orgSlug: current.org,
      workspaceSlug: current.ws,
    });
  } catch {
    // A read-only checkout keeps working; it just resolves again next time.
  }
}

/**
 * The org and workspace this checkout is linked to, from its own
 * `.oxagen/workspace.json`, or undefined when it is not linked.
 *
 * The link is the checkout's identity. Without it the platform read used the
 * CLI's GLOBALLY selected workspace — which, for a developer with several
 * checkouts, is routinely another one — and a repository-name check cannot
 * catch that when two workspaces bind the same repository: both answers name
 * it, and the wrong workspace's gates silently replaced the right one's.
 */
function checkoutLink(projectRoot: string): CheckoutLink | undefined {
  const link = readWorkspaceLink(projectRoot);
  if (!link?.orgSlug || !link.workspaceSlug) return undefined;
  return {
    scope: { org: link.orgSlug, ws: link.workspaceSlug },
    orgId: link.orgId,
    workspaceId: link.workspaceId,
  };
}

/**
 * The name of the remote whose URL is `repository`, or null when none is.
 *
 * The check has to run against the remote the gate will actually FETCH and
 * SYNC from. Validating a hard-coded `origin` while a settings file pointed
 * `remote` at a fork verified one repository and then pulled `.oxagen/` from
 * another. Instead the bound repository chooses the remote.
 */
async function remoteFor(
  projectRoot: string,
  repository: string,
): Promise<string | null> {
  const { execGit } = await import("@oxagen/steering-freshness");
  let names: string[];
  try {
    names = (await execGit(["remote"], { cwd: projectRoot, timeoutMs: 5_000 }))
      .split("\n")
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
  } catch {
    return null;
  }
  const wanted = `${BOUND_REPOSITORY_HOST}/${repository}`.toLowerCase();
  for (const name of names) {
    // A remote name git could read as an option is never passed to it.
    if (name.startsWith("-")) continue;
    if ((await checkoutRepository(projectRoot, name)) === wanted) return name;
  }
  return null;
}

/**
 * `host/owner/repo` for a remote URL, or null when it is not a hosted
 * repository address.
 *
 * The host is part of the identity. Keeping only `owner/repo` accepted
 * `git@gitlab.com:acme/app.git`, or a local path like `/tmp/acme/app`, as the
 * workspace's GitHub repository, and the gate then fetched and auto-synced
 * `.oxagen/` from that other host. Two address shapes are understood:
 *
 *   - the scp form, `git@github.com:acme/app.git`
 *   - URLs, `https://github.com/acme/app.git`, `ssh://git@github.com/acme/app`
 *
 * Anything else, including a filesystem path or `file://`, is not a hosted
 * repository and answers null. The path must be exactly `owner/repo`. Case is
 * folded, because GitHub treats `Acme/App` and `acme/app` as one repository.
 */
export function parseRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  let host: string;
  let path: string;
  const scp = /^[^@\s/]+@([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol))
      return null;
    host = parsed.hostname;
    path = parsed.pathname;
  }
  const parts = path
    .replace(/\.git$/, "")
    .split("/")
    .filter((part) => part.length > 0);
  if (host.length === 0 || parts.length !== 2) return null;
  return `${host}/${parts[0]}/${parts[1]}`.toLowerCase();
}

/**
 * The host a workspace's main repository lives on.
 *
 * `bind_main_repository` binds GitHub repositories only, through the GitHub
 * App, so the platform's `owner/repo` always means one on github.com. When a
 * second provider can be bound, the answer has to carry its host and this
 * constant goes.
 */
const BOUND_REPOSITORY_HOST = "github.com";

/** `host/owner/repo` for one of this checkout's remotes, or null. */
async function checkoutRepository(
  projectRoot: string,
  remote: string,
): Promise<string | null> {
  const { execGit } = await import("@oxagen/steering-freshness");
  try {
    return parseRemoteUrl(
      await execGit(["remote", "get-url", "--", remote], {
        cwd: projectRoot,
        timeoutMs: 5_000,
      }),
    );
  } catch {
    return null;
  }
}

/**
 * Turn the platform's answer into the signal the check consumes.
 *
 * `aheadOfCheckout` is computed locally with `merge-base --is-ancestor`: the
 * platform knows which commit published the newest promotion, and only this
 * machine can say whether its HEAD can reach it.
 */
async function toSignal(
  platform: PlatformFreshness | null,
  projectRoot: string,
): Promise<PlatformSignal | null> {
  if (!platform) return null;
  let aheadOfCheckout = false;
  if (platform.headCommit) {
    const { execGit } = await import("@oxagen/steering-freshness");
    try {
      await execGit(
        ["merge-base", "--is-ancestor", platform.headCommit, "HEAD"],
        { cwd: projectRoot, timeoutMs: 5_000 },
      );
    } catch {
      // A non-zero exit means "not an ancestor", which is the answer we
      // want. It also means "that commit is not in this clone", which is
      // the same answer for this purpose: the checkout cannot reach it.
      aheadOfCheckout = true;
    }
  }
  return {
    steeringVersion: platform.steeringVersion,
    headCommit: platform.headCommit,
    aheadOfCheckout,
  };
}

// ── Policy ───────────────────────────────────────────────────────────────────

export interface ResolvedContext {
  projectRoot: string;
  policy: SteeringPolicy;
  platform: PlatformSignal | null;
  warnings: string[];
}

/**
 * Read every scope, fold them, and note anything that could not be read.
 *
 * `offline` skips the platform entirely, which `gate --no-network` uses to
 * guarantee no HTTP call sits in front of a prompt.
 */
export async function resolveContext(
  cwd: string,
  { offline = false }: { offline?: boolean } = {},
): Promise<ResolvedContext> {
  const projectRoot = findProjectRoot(cwd);
  const link = checkoutLink(projectRoot);
  const scope = link?.scope;
  const fromPlatform = offline ? null : await readPlatform(projectRoot, link);
  const mismatch: string[] = [];

  // ── Is the platform answering about THIS checkout? ──────────────────────
  //
  // Two checks, because each catches what the other cannot.
  //
  // 1. The request is scoped by the checkout's own `.oxagen/workspace.json`
  //    when it has one (see `checkoutLink`), so a linked checkout asks its
  //    own workspace however the CLI is globally configured. That is the
  //    only thing that separates two workspaces binding the same repository.
  //
  // 2. The answer names the repository it is about, and that repository must
  //    be reachable through one of this checkout's remotes — and the check
  //    then runs against THAT remote. An unlinked checkout still falls back
  //    to the global selection, and this is what stops a workspace's gates
  //    being applied to an unrelated repository. Pinning the remote here is
  //    what stops a `remote` setting pointing the fetch and the sync at a
  //    fork after the identity was verified against a different remote.
  //
  // On a mismatch the whole answer is discarded — policy and signal together,
  // since neither half is about this repository — and the developer is told.
  // Discarding is safe in the direction that matters: git remains the primary
  // signal.
  let boundRemote: string | null = null;
  let belongsHere = fromPlatform !== null;
  // No repository bound means steering is off for that workspace — the
  // contract says so — and it also means there is no identity to match this
  // checkout against. Accepting the answer anyway applied a workspace's gates
  // (set through the API or MCP) to whatever unlinked checkout happened to ask,
  // blocking or auto-syncing a repository that workspace has nothing to do
  // with. Discarded, with nothing to report: this is the ordinary state of a
  // workspace that has not bound a repository yet.
  if (fromPlatform !== null && fromPlatform.repository == null) {
    belongsHere = false;
    // Said out loud, not dropped quietly. A checkout's link and the global
    // selection are both things the developer can change, so pointing either
    // at a workspace with no repository is a way to leave the workspace's
    // gates behind. It has to be visible the way OXAGEN_STEERING_FRESHNESS=off
    // is. (Pointing at a workspace that binds a DIFFERENT repository is
    // already reported below as a mismatch, and no two workspaces can bind
    // the same main repository.)
    mismatch.push(
      `the ${scope ? "linked" : "selected"} workspace has no repository bound, so its steering gates were not applied to this checkout`,
    );
  }
  if (fromPlatform?.repository) {
    boundRemote = await remoteFor(projectRoot, fromPlatform.repository);
    if (boundRemote === null) {
      belongsHere = false;
      mismatch.push(
        `Oxagen's answer is about ${fromPlatform.repository}, which no remote of this checkout points at, so it was ignored — ${
          scope
            ? `check the workspace named in .oxagen/workspace.json`
            : `run \`oxagen init\` in this repository to link it to its workspace`
        }`,
      );
    }
  }
  const platformFreshness = belongsHere ? fromPlatform : null;

  const { layers, warnings } = await loadSteeringSettings({
    projectRoot,
    // The workspace's APPROVED production branch travels with its policy.
    //
    // The gates were imported and `defaultBranch` was dropped, so the checker
    // fell back to resolving the remote's own default — and a workspace that
    // approved `release` while `origin/HEAD` still says `main` was compared
    // against the wrong branch entirely. A Context PR merged into `release`
    // left an enforced checkout reported as `current`, which is the failure
    // this feature exists to prevent, arriving silently.
    //
    // It rides in the `workspace` layer, which is last in POLICY_SCOPES, so it
    // also outranks a `branch` or `remote` a lower scope set — exactly the
    // redirection a personal settings file could otherwise perform.
    workspacePolicy:
      platformFreshness?.policy == null
        ? null
        : {
            ...platformFreshness.policy,
            ...(platformFreshness.defaultBranch === null
              ? {}
              : { branch: platformFreshness.defaultBranch }),
            // The remote that actually points at the bound repository, so a
            // lower scope's `remote` cannot redirect the fetch and the sync.
            ...(boundRemote === null ? {} : { remote: boundRemote }),
          },
  });
  const policy = resolveSteeringPolicy(
    layers,
    readEmergencyOverride(process.env),
  );
  return {
    projectRoot,
    policy,
    platform: await toSignal(platformFreshness, projectRoot),
    warnings: [
      ...warnings.map((w) => `${w.path} ${w.message}`),
      ...mismatch,
      // A personal exclusion that was refused did nothing; say so, rather than
      // letting the developer discover it by being blocked over a record they
      // believe they excluded.
      ...policy.refusedExcludes.map(
        (path) =>
          `\`${path}\` is excluded in a settings file and was ignored: only the workspace can remove records from the freshness check`,
      ),
    ],
  };
}

// ── status ───────────────────────────────────────────────────────────────────

function describe(verdict: FreshnessVerdict, policy: SteeringPolicy): string {
  const target = verdict.branch
    ? `${verdict.remote}/${verdict.branch}`
    : verdict.remote;
  const lines: string[] = [];
  switch (verdict.status) {
    case "current":
      lines.push(`Steering is current with ${target}.`);
      break;
    case "ahead":
      lines.push(
        `Steering is current with ${target}, plus this branch's own changes.`,
      );
      break;
    case "behind":
      lines.push(
        `Steering is ${verdict.missing.length} record(s) behind ${target}.`,
      );
      break;
    case "diverged":
      lines.push(
        `Steering is ${verdict.missing.length} record(s) behind ${target}, and this branch changed .oxagen/ too.`,
      );
      break;
    default:
      lines.push("Steering freshness is unknown.");
  }

  for (const change of verdict.missing) {
    lines.push(`  behind   ${change.status.padEnd(8)} ${change.path}`);
  }
  for (const change of verdict.local) {
    lines.push(`  here     ${change.status.padEnd(8)} ${change.path}`);
  }
  for (const path of verdict.dirty) {
    lines.push(`  unsaved  ${path}`);
  }

  lines.push("");
  lines.push(
    `Auto-sync: ${policy.autoSync ? "on" : "off"}. Block stale runs: ${
      policy.blockStaleRuns ? "on" : "off"
    }.`,
  );
  if (policy.suspended) {
    lines.push(`Both are suspended. ${policy.suspendedReason ?? ""}`.trim());
  }
  if (verdict.platform) {
    lines.push(`Oxagen steering version: ${verdict.platform.steeringVersion}.`);
  }
  for (const note of verdict.notes) lines.push(note);
  return lines.join("\n");
}

export async function steeringStatus(
  opts: { json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
  cwd: string = process.cwd(),
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const ctx = await resolveContext(cwd);
  for (const warning of ctx.warnings) out.warn(warning);

  const verdict = await checkSteeringFreshness({
    cwd: ctx.projectRoot,
    policy: ctx.policy,
    platform: ctx.platform,
  });

  if (out.isJson) {
    out.data({
      status: verdict.status,
      remote: verdict.remote,
      branch: verdict.branch,
      behindByRecords: verdict.missing.length,
      behindByCommits: verdict.behindByCommits,
      missing: verdict.missing,
      localChanges: verdict.local,
      dirty: verdict.dirty,
      fingerprint: verdict.fingerprint,
      fetch: verdict.fetch,
      notes: verdict.notes,
      platform: verdict.platform,
      policy: {
        autoSync: ctx.policy.autoSync,
        blockStaleRuns: ctx.policy.blockStaleRuns,
        suspended: ctx.policy.suspended,
        sources: ctx.policy.sources,
      },
    });
    return;
  }
  writer.write(describe(verdict, ctx.policy));
}

// ── sync ─────────────────────────────────────────────────────────────────────

export async function steeringSync(
  opts: {
    json?: boolean;
    force?: boolean;
    commit?: boolean;
    dryRun?: boolean;
  } = {},
  writer: CommandWriter = stdoutWriter,
  cwd: string = process.cwd(),
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const ctx = await resolveContext(cwd);
  for (const warning of ctx.warnings) out.warn(warning);

  const verdict = await checkSteeringFreshness({
    cwd: ctx.projectRoot,
    policy: ctx.policy,
    platform: ctx.platform,
  });
  const result = await syncSteering({
    cwd: ctx.projectRoot,
    verdict,
    force: opts.force,
    commit: opts.commit,
    dryRun: opts.dryRun,
  });

  if (out.isJson) {
    out.data(result);
  } else {
    writer.write(result.message);
  }
  // A refusal is the command failing to do what it was asked, so it must not
  // exit 0: a script that runs `oxagen steering sync && …` has to be able to
  // tell a sync that happened from one that was declined. `not_behind` is the
  // exception, because nothing to do is success.
  if (result.refusal !== null && result.refusal !== "not_behind") {
    process.exitCode = 1;
  }
}

// ── gate ─────────────────────────────────────────────────────────────────────

/**
 * The hook entry point. Everything about it is shaped by running on the path
 * of every prompt:
 *
 *   - It never throws. An exception inside a hook is a broken prompt, so any
 *     failure here resolves to "allow" and stays quiet about the plumbing.
 *   - Its stdout belongs to the harness, so nothing else may write there.
 *   - It sets an exit code rather than printing a verdict, because that is
 *     the one signal every harness reads.
 */
export async function steeringGate(
  opts: { harness?: string; network?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
  cwd: string = process.cwd(),
): Promise<void> {
  // `--no-network` is Commander's negation of `--network`, so an absent
  // value means the network is allowed.
  const allowNetwork = opts.network !== false;
  try {
    const ctx = await resolveContext(cwd, { offline: !allowNetwork });
    const decision = await evaluateGate({
      cwd: ctx.projectRoot,
      policy: ctx.policy,
      platform: ctx.platform,
      allowNetwork,
    });
    const rendered = renderGate(decision, opts.harness ?? "text");
    if (rendered.stdout) writer.write(rendered.stdout.trimEnd());
    if (rendered.stderr) writer.writeErr(rendered.stderr.trimEnd());
    // The settings diagnostics travel with the gate too, on stderr.
    //
    // `resolveContext` drops a layer it cannot read and says so in
    // `warnings`, and the gate is the path that actually runs before every
    // prompt — so discarding them here meant a malformed `.oxagen/settings.json`
    // quietly lost a project-level `blockStaleRuns` and the prompt went ahead
    // with no word of why. stderr, never stdout: stdout carries the harness's
    // own JSON, and one stray line there would break the hook outright. The
    // gate still fails open; it just no longer fails silently.
    for (const warning of ctx.warnings) {
      writer.writeErr(`oxagen steering: ${warning}`);
    }
    process.exitCode = rendered.exitCode;
  } catch {
    // A gate that crashes must not take the prompt with it.
    process.exitCode = 0;
  }
}

// ── hooks ────────────────────────────────────────────────────────────────────

function parseHarnesses(raw: string | undefined): InstallableHarness[] | null {
  if (!raw || raw === "all") return [...INSTALLABLE];
  const names = raw.split(",").map((s) => s.trim());
  const bad = names.filter(
    (n) => !INSTALLABLE.includes(n as InstallableHarness),
  );
  if (bad.length > 0) return null;
  return names as InstallableHarness[];
}

export async function steeringHooks(
  action: string,
  opts: { harness?: string; json?: boolean } = {},
  writer: CommandWriter = stdoutWriter,
  cwd: string = process.cwd(),
): Promise<void> {
  const out = createOutput({ json: opts.json }, writer);
  const harnesses = parseHarnesses(opts.harness);
  if (!harnesses) {
    writer.writeErr(
      `error: --harness is one of ${INSTALLABLE.join(", ")}, a comma-separated list of them, or "all"`,
    );
    process.exitCode = 2;
    return;
  }
  const projectRoot = findProjectRoot(cwd);

  if (action === "status") {
    const rows = await Promise.all(
      harnesses.map((h) => hookStatus(projectRoot, h)),
    );
    if (out.isJson) {
      out.data({ hooks: rows });
      return;
    }
    for (const row of rows) {
      writer.write(
        `${row.harness.padEnd(12)} ${row.installed ? "installed" : "not installed"}  ${row.path}`,
      );
    }
    writer.write("");
    writer.write(
      `Any other agent: run \`oxagen steering gate --harness <name>\` before each prompt. Exit 2 means refuse it, and the reason is on stderr. Supported --harness values: ${HARNESSES.join(", ")}.`,
    );
    return;
  }

  if (action !== "install" && action !== "remove") {
    writer.writeErr("error: oxagen steering hooks install | remove | status");
    process.exitCode = 2;
    return;
  }

  const results = await Promise.all(
    harnesses.map((h) =>
      action === "install"
        ? installHook(projectRoot, h)
        : removeHook(projectRoot, h),
    ),
  );
  if (out.isJson) {
    out.data({ results });
  } else {
    for (const r of results) writer.write(r.message);
  }
  if (results.some((r) => r.outcome === "refused")) process.exitCode = 1;
}
