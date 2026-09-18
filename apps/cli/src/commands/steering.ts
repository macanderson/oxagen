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
import { existsSync } from "node:fs";
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
import { apiPostOrThrow } from "../lib/api.js";
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
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, PROJECT_DIR_NAME))) return dir;
    if (dir === root) return start;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
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
async function readPlatform(): Promise<PlatformFreshness | null> {
  try {
    return await apiPostOrThrow<PlatformFreshness>(
      "context/steering/freshness",
      {},
    );
  } catch {
    return null;
  }
}

/**
 * `owner/repo` for a checkout's remote, or null when it cannot be read.
 *
 * Normalised across the three shapes a remote URL takes — `git@host:o/r.git`,
 * `https://host/o/r.git`, `ssh://git@host/o/r` — because the comparison below
 * is against a platform value that is always the bare `owner/repo`. Case is
 * folded: GitHub treats `Acme/App` and `acme/app` as the same repository and a
 * false mismatch would discard a perfectly good platform answer.
 */
async function checkoutRepository(
  projectRoot: string,
  remote: string,
): Promise<string | null> {
  const { execGit } = await import("@oxagen/steering-freshness");
  let url: string;
  try {
    url = (
      await execGit(["remote", "get-url", remote], {
        cwd: projectRoot,
        timeoutMs: 5_000,
      })
    ).trim();
  } catch {
    return null;
  }
  if (url.length === 0) return null;
  const withoutSuffix = url.replace(/\.git$/, "");
  // Everything after the host: the last two path segments are owner and repo.
  const parts = withoutSuffix
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(":", "/")
    .split("/")
    .filter((part) => part.length > 0);
  if (parts.length < 3) return null;
  return parts.slice(-2).join("/").toLowerCase();
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
  const fromPlatform = offline ? null : await readPlatform();
  const mismatch: string[] = [];

  // ── Is the platform answering about THIS checkout? ──────────────────────
  //
  // The call is scoped by the CLI's globally selected org and workspace, not
  // by the directory the prompt came from, and a developer with several
  // checkouts routinely has one selected while working in another. Nothing
  // reconciled the two: the answer's policy became this checkout's policy and
  // its publication commit became the thing this checkout was compared
  // against, so a workspace's blocking gate applied to an unrelated
  // repository and refused prompts over records that had nothing to do with
  // it.
  //
  // The platform names the repository it is answering about, so the check is
  // simply to ask. On a mismatch the whole answer is discarded — policy and
  // signal together, since neither half is about this repository — and the
  // developer is told which workspace they have selected. Discarding is safe
  // in the direction that matters: git remains the primary signal, and the
  // worst case is the local gates rather than the workspace's.
  //
  // A platform with no repository bound (`repository: null`) is not a
  // mismatch: steering is simply off for that workspace, and its policy still
  // legitimately applies.
  const localRepo = await checkoutRepository(
    projectRoot,
    // Before the policy is resolved, so the default remote. A workspace that
    // renames its remote is the rare case, and it only loses the check.
    "origin",
  );
  const platformRepo = fromPlatform?.repository?.toLowerCase() ?? null;
  const belongsHere =
    fromPlatform !== null &&
    (platformRepo === null || localRepo === null || platformRepo === localRepo);
  if (fromPlatform !== null && !belongsHere) {
    mismatch.push(
      `the selected workspace steers ${String(fromPlatform.repository)} and this checkout is ${String(localRepo)}, so Oxagen's answer was ignored — run \`oxagen workspace use\` to select the workspace this repository belongs to`,
    );
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
          `\`${path}\` is excluded in .oxagen/settings.local.json and was ignored: a personal file cannot remove records from the freshness check`,
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
