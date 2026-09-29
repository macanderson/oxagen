// import-run.ts: import_workspace_steering, the run that moves an existing
// workspace onto a steering repo (steering spec, Workspace migration; lane
// S10, #4620, ADR-219).
//
// A workspace made before steering repos existed is steered by a repository
// it bound, whose `.oxagen/` holds its steering. The run takes it through
// five steps and records each one in the workspace's `steering_import`
// setting, so a second call resumes where the first one stopped:
//
//   record_source  read the steering head and pin the commit `.oxagen/` is
//                  read at. Nothing changes until the conversion succeeds and
//                  every v0.1 rule has a kind.
//   demote         turn the old steering head into a linked head.
//   provision      create and bind the steering repo. A failure puts the old
//                  head back, so the workspace is never left with no steering.
//   import         open the import steering PRs on the steering repo, each
//                  from the steering repo's default branch as the run first
//                  read it.
//   cleanup        open one PR on the old repository that removes the
//                  `.oxagen/` files the steering repo now holds. A file the
//                  old repository changed after the run read it stays.
//
// The run merges nothing. A person merges the import steering PRs in order,
// then the cleanup PR last. Everything that touches the database or a host is
// a dependency, so the tests run the whole flow against fakes.
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import {
  GOVERNANCE_TOML_PATH,
  LEGACY_OXAGEN_DIR,
  WORKSPACE_TOML_PATH,
} from "@oxagen/oxagen/steering-repo/paths";
import type { RecordEffect } from "@oxagen/oxagen/steering-repo/record";
import {
  githubRefused,
  type SteeringChangedFile,
  type SteeringHost,
  type SteeringRepository,
} from "../context.steering.github";
import { githubRepoRef } from "../repository.workspace-toml";
import {
  convertOxagenTree,
  droppedFieldLines,
  IMPORT_WORKSPACE_BRANCH,
  importPullRequestBody,
  type ImportAgent,
  type ImportBranch,
  type OxagenTreeConversion,
  type RuleKind,
} from "./convert";
import { isImportBranch, STEERING_PR_MAX_FILES } from "./stamp";

// ── Shapes ───────────────────────────────────────────────────────────────────

/** The workspace settings key that holds the run's state. */
export const STEERING_IMPORT_SETTING = "steering_import";

/** The branch of the cleanup PR on the old repository. */
export const IMPORT_CLEANUP_BRANCH = "oxagen/import-cleanup";

/**
 * How long a running import holds the workspace. Every step saves the state,
 * which renews the lease, so only a run that stopped without saving loses it.
 */
export const IMPORT_LEASE_MS = 10 * 60 * 1000;

export const IMPORT_STEPS = [
  "record_source",
  "demote",
  "provision",
  "import",
  "cleanup",
] as const;
export type ImportStep = (typeof IMPORT_STEPS)[number];

export type ImportStatus = "running" | "waiting" | "done" | "failed";

/**
 * What the run did:
 *   imported           the old repository's `.oxagen/` went to the steering repo
 *   provisioned        the workspace had no steering head, so the run only
 *                      created the steering repo
 *   nothing_to_import  the workspace already has a steering repo
 *   needs_choices      rules or constraints need a person's choice first, and
 *                      nothing changed
 */
export type ImportOutcome =
  | "imported"
  | "provisioned"
  | "nothing_to_import"
  | "needs_choices";

/** The old repository as its steering head bound it. */
export interface ImportSourceRepository {
  /** The steering head's id. */
  head_id: string;
  connection_id: string;
  owner: string;
  name: string;
  full_name: string;
  /** The binding's approved production branch. */
  default_branch: string;
}

export interface ImportSource extends ImportSourceRepository {
  /** The commit `.oxagen/` is read at, pinned when the run first read it. */
  commit: string;
  /** The old repository as workspace.toml lists it, such as github.com/a-intel/platform. */
  relinked: string;
}

export interface ImportPullRequest {
  branch: string;
  number: number;
  url: string;
}

/** What the `steering_import` setting holds. */
export interface SteeringImportState {
  status: ImportStatus;
  /** The last step that finished, or null before the first. */
  step: ImportStep | null;
  error: { code: string; message: string } | null;
  outcome: ImportOutcome | null;
  /** The old repository, or null when the workspace had no steering head. */
  source: ImportSource | null;
  /** The kind of each v0.1 rule, by its old lineage. Fixed once `step` is set. */
  rule_kinds: Record<string, RuleKind>;
  /** The effect of each v0.1 constraint, by its old lineage. Fixed once `step` is set. */
  constraint_effects: Record<string, RecordEffect>;
  /** `owner/name` of the steering repo, once the run has one. */
  steering_repository: string | null;
  /**
   * The steering repo's default-branch commit the import steering PRs start
   * from, pinned when the import step first reads it. A resumed run converts
   * against the same workspace.toml and governance.toml.
   */
  steering_base: string | null;
  pull_requests: ImportPullRequest[];
  /** The old repository's commit the cleanup PR starts from. */
  cleanup_base: string | null;
  /**
   * Converted files the cleanup PR keeps, because the old repository changed
   * them between `source.commit` and `cleanup_base`.
   */
  cleanup_kept: string[];
  cleanup: { number: number; url: string } | null;
  /** Files, records, and agents the import leaves for a person. */
  left_for_a_person: number;
  rules_needing_kind: string[];
  constraints_needing_effect: string[];
  updated_at: string;
}

export function initialImportState(now: Date): SteeringImportState {
  return {
    status: "running",
    step: null,
    error: null,
    outcome: null,
    source: null,
    rule_kinds: {},
    constraint_effects: {},
    steering_repository: null,
    steering_base: null,
    pull_requests: [],
    cleanup_base: null,
    cleanup_kept: [],
    cleanup: null,
    left_for_a_person: 0,
    rules_needing_kind: [],
    constraints_needing_effect: [],
    updated_at: now.toISOString(),
  };
}

/** Read the state a settings bag holds, or null when it holds none. */
export function readImportState(settings: unknown): SteeringImportState | null {
  if (settings === null || typeof settings !== "object") return null;
  const value = (settings as Record<string, unknown>)[STEERING_IMPORT_SETTING];
  if (value === null || typeof value !== "object") return null;
  const state = value as Partial<SteeringImportState>;
  if (typeof state.status !== "string") return null;
  return { ...initialImportState(new Date(0)), ...state };
}

export type ImportScope = { orgId: string; workspaceId: string };

export interface ImportInput {
  ruleKinds?: Readonly<Record<string, RuleKind>>;
  constraintEffects?: Readonly<Record<string, RecordEffect>>;
}

export interface ImportResult {
  outcome: ImportOutcome;
  steeringRepository: string | null;
  pullRequests: ImportPullRequest[];
  cleanup: { number: number; url: string } | null;
  leftForAPerson: number;
  rulesNeedingKind: string[];
  constraintsNeedingEffect: string[];
}

/** The workspace's steering head, as the run needs to tell its cases apart. */
export type SteeringHeadRead =
  /** No steering head and no legacy connection. */
  | { kind: "none" }
  /** The head hangs from an Oxagen Steering connection: the steering repo exists. */
  | { kind: "provisioned"; fullName: string }
  /** A host the import does not read, such as GitLab. */
  | { kind: "unsupported"; provider: string; fullName: string }
  /** The head's connection is retired or gone. */
  | { kind: "unreachable"; fullName: string }
  /** No head, but a sources connection that names a repository in its delivery config. */
  | { kind: "legacy"; fullName: string }
  /** A bound GitHub repository: the one the import reads. */
  | ({ kind: "repository" } & ImportSourceRepository);

/** The host calls the run makes. */
export type ImportHost = Pick<
  SteeringHost,
  | "readFile"
  | "listFiles"
  | "branchHead"
  | "ensureBranch"
  | "commitFiles"
  | "changedFiles"
  | "holdsCommit"
  | "findOpenPullRequest"
  | "openPullRequest"
>;

export interface OpenedRepository {
  host: ImportHost;
  repo: SteeringRepository;
}

export interface SteeringImportDeps {
  now(): Date;
  readState(scope: ImportScope): Promise<SteeringImportState | null>;
  saveState(scope: ImportScope, state: SteeringImportState): Promise<void>;
  /**
   * Write `state` unless another run holds the lease: its status is running
   * and it saved after `staleBefore`. One statement, so two calls cannot both
   * win. Returns whether this call wrote.
   */
  claim(
    scope: ImportScope,
    state: SteeringImportState,
    staleBefore: Date,
  ): Promise<boolean>;
  readSteeringHead(scope: ImportScope): Promise<SteeringHeadRead>;
  /** Make the head linked. Returns false when the head is gone. */
  demote(scope: ImportScope, headId: string): Promise<boolean>;
  /**
   * Make the linked head the steering head again, only while the workspace
   * has no steering head. Returns whether it did.
   */
  restore(scope: ImportScope, headId: string): Promise<boolean>;
  /** Create and bind the steering repo. Throws a HandlerError when it cannot. */
  provision(scope: ImportScope): Promise<void>;
  /** The old repository, reached with the workspace's own token. */
  openSource(
    scope: ImportScope,
    source: ImportSourceRepository,
  ): Promise<OpenedRepository>;
  /** The steering repo. Called only once provisioning is ready. */
  openSteering(scope: ImportScope): Promise<OpenedRepository>;
  agents(scope: ImportScope): Promise<ImportAgent[]>;
  /** The organization and workspace slugs, which make the set id. */
  names(scope: ImportScope): Promise<{ organization: string; workspace: string }>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function conflict(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

function reached(state: SteeringImportState, step: ImportStep): boolean {
  return (
    state.step !== null &&
    IMPORT_STEPS.indexOf(state.step) >= IMPORT_STEPS.indexOf(step)
  );
}

function resultOf(state: SteeringImportState): ImportResult {
  return {
    outcome: state.outcome ?? "imported",
    steeringRepository: state.steering_repository,
    pullRequests: state.pull_requests,
    cleanup: state.cleanup,
    leftForAPerson: state.left_for_a_person,
    rulesNeedingKind: state.rules_needing_kind,
    constraintsNeedingEffect: state.constraints_needing_effect,
  };
}

/** Run `work` over `items`, at most `limit` at a time, keeping the order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await work(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/** Every file under `.oxagen/` at `commit`, by path. */
async function readOxagenTree(
  source: OpenedRepository,
  commit: string,
): Promise<Map<string, string>> {
  const paths = await source.host.listFiles(source.repo, commit, LEGACY_OXAGEN_DIR);
  const contents = await mapLimit(paths, 8, (path) =>
    source.host.readFile(source.repo, path, commit),
  );
  const files = new Map<string, string>();
  paths.forEach((path, index) => {
    const content = contents[index];
    if (content !== null && content !== undefined) files.set(path, content);
  });
  return files;
}

/** Files, records, and agents the conversion leaves for a person. */
function leftForAPerson(conversion: OxagenTreeConversion): number {
  return (
    conversion.unconverted.length +
    conversion.agentsByHand.length +
    conversion.rulesNeedingKind.length +
    conversion.constraintsNeedingEffect.length
  );
}

/**
 * The paths among `paths` whose content at `base` differs from what the run
 * read at `commit`. The cleanup keeps each one, so it never deletes an edit
 * the import did not carry.
 */
async function changedSince(
  source: OpenedRepository,
  base: string,
  commit: string,
  paths: readonly string[],
  read: ReadonlyMap<string, string>,
): Promise<string[]> {
  if (base === commit) return [];
  const now = await mapLimit(paths, 8, (path) =>
    source.host.readFile(source.repo, path, base),
  );
  return paths.filter((path, index) => now[index] !== read.get(path));
}

/**
 * What a branch the run finds already made holds: only the run's commit
 * (`held`), anything else (`other`), or more changed files than the host
 * lists (`too_long`).
 */
type BranchProof = "held" | "other" | "too_long";

/**
 * Prove whether the branch at `head` holds only the commit this run writes on
 * `base`. The head descends from `base`, changes no path outside `files`, and
 * holds each file as the run writes it. The host lists fewer than
 * `STEERING_PR_MAX_FILES + 1` changed files, so a longer list proves nothing.
 */
async function proveRunCommit(
  host: ImportHost,
  repo: SteeringRepository,
  base: string,
  head: string,
  files: readonly { path: string; content: string | null }[],
): Promise<BranchProof> {
  if (!(await host.holdsCommit(repo, head, base))) return "other";
  let changed: SteeringChangedFile[];
  try {
    changed = await host.changedFiles(repo, base, head);
  } catch (err) {
    if (isHandlerError(err) && err.reason === "too_many_files")
      return "too_long";
    throw err;
  }
  const expected = new Set(files.map((file) => file.path));
  if (changed.some((file) => !expected.has(file.path))) return "other";
  const held = await mapLimit(files, 8, (file) =>
    host.readFile(repo, file.path, head),
  );
  return files.every((file, index) => (held[index] ?? null) === file.content)
    ? "held"
    : "other";
}

/**
 * Put the run's one commit on `branch`, which starts at `base`. A branch an
 * earlier call of this run committed is proved and kept. The run refuses any
 * other branch, and a branch that changes 300 or more files, because the host
 * cannot list those changes. It opens no PR from a refused branch.
 */
async function commitOnce(
  opened: OpenedRepository,
  base: string,
  branch: string,
  message: string,
  files: readonly { path: string; content: string | null }[],
): Promise<void> {
  const { host, repo } = opened;
  await host.ensureBranch(repo, branch, repo.defaultBranch, {
    exclusive: false,
    at: base,
  });
  const head = await host.branchHead(repo, branch);
  if (head === base) {
    await host.commitFiles(repo, { branch, parent: base, message, files: [...files] });
    return;
  }
  const proof =
    head === null
      ? "other"
      : await proveRunCommit(host, repo, base, head, files);
  if (proof === "held") return;
  const taken = `The branch ${branch} on ${repo.fullName} already exists`;
  const why =
    proof === "too_long"
      ? `${taken} and changes ${STEERING_PR_MAX_FILES + 1} or more files. The host lists fewer changes than that, so Oxagen cannot confirm the branch holds only this import's commit.`
      : `${taken}, and Oxagen cannot confirm it holds only this import's commit.`;
  throw conflict(
    "steering_import_branch_taken",
    `${why} Delete the branch, then run the import again.`,
  );
}

/** The title of one import steering PR. */
export function importPullRequestTitle(
  conversion: OxagenTreeConversion,
  branch: ImportBranch,
): string {
  if (isImportBranch(branch.branch)) {
    const batches = conversion.branches.filter((b) => isImportBranch(b.branch));
    const index = batches.findIndex((b) => b.branch === branch.branch) + 1;
    return batches.length > 1
      ? `Import steering from .oxagen/ (batch ${index} of ${batches.length})`
      : "Import steering from .oxagen/";
  }
  if (branch.branch === IMPORT_WORKSPACE_BRANCH)
    return "Import workspace.toml from .oxagen/";
  return `Import the agent ${branch.branch.slice(branch.branch.indexOf("/") + 1)}`;
}

/** The body of the cleanup PR on the old repository. */
export function cleanupPullRequestBody(args: {
  steeringRepository: string;
  pullRequests: readonly ImportPullRequest[];
  paths: readonly string[];
  /** The commit the import read `.oxagen/` at. */
  commit: string;
  /** Converted files this PR keeps, because they changed after `commit`. */
  kept: readonly string[];
  /** The fields the conversion dropped, by the file that held them. */
  dropped: Readonly<Record<string, readonly string[]>>;
}): string {
  const removed = new Set(args.paths);
  const dropped = droppedFieldLines(args.dropped, (path) => removed.has(path));
  return [
    `The workspace's steering moved to the steering repo ${args.steeringRepository}. This PR removes the ${args.paths.length === 1 ? "file" : `${args.paths.length} files`} under \`${LEGACY_OXAGEN_DIR}/\` that the steering repo now holds.`,
    "",
    "Merge this PR last, after every import steering PR below has merged. Files the import left for a person stay in place.",
    "",
    "## Import steering PRs",
    "",
    ...args.pullRequests.map((pr) => `- \`${pr.branch}\`: ${pr.url}`),
    "",
    "## Files removed",
    "",
    ...args.paths.map((path) => `- \`${path}\``),
    ...(args.kept.length > 0
      ? [
          "",
          "## Files changed since the import",
          "",
          `The import read these files at \`${args.commit}\`, and they changed after that. The steering repo holds the version the import read, so this PR keeps them. Move each change into the steering repo with a steering PR, then delete the file.`,
          "",
          ...args.kept.map((path) => `- \`${path}\``),
        ]
      : []),
    ...(dropped.length > 0
      ? [
          "",
          "## Dropped fields",
          "",
          "The steering repo has no place for these fields, and this PR deletes the files that hold them. Move any field you still need by hand before you merge.",
          "",
          ...dropped,
        ]
      : []),
  ].join("\n") + "\n";
}

// ── The run ──────────────────────────────────────────────────────────────────

/**
 * Move the workspace's steering from `.oxagen/` in the repository it binds to
 * a steering repo. Safe to call again: a finished run answers what it did,
 * and a stopped run resumes at the step that stopped.
 */
export async function runSteeringImport(
  scope: ImportScope,
  input: ImportInput,
  deps: SteeringImportDeps,
): Promise<ImportResult> {
  const stored = await deps.readState(scope);
  if (stored?.status === "done") return resultOf(stored);

  const started = deps.now();
  const state: SteeringImportState = stored
    ? { ...stored }
    : initialImportState(started);
  // The choices apply only before anything changed. After that, the run
  // converts with the choices it demoted the head with.
  if (state.step === null) {
    state.rule_kinds = { ...state.rule_kinds, ...input.ruleKinds };
    state.constraint_effects = {
      ...state.constraint_effects,
      ...input.constraintEffects,
    };
  }
  state.status = "running";
  state.error = null;
  state.updated_at = started.toISOString();
  const claimed = await deps.claim(
    scope,
    state,
    new Date(started.getTime() - IMPORT_LEASE_MS),
  );
  if (!claimed)
    throw conflict(
      "steering_import_running",
      "Another import of this workspace's steering is running. Try again when it finishes.",
    );

  const save = async () => {
    state.updated_at = deps.now().toISOString();
    await deps.saveState(scope, state);
  };

  try {
    return await advance(scope, state, deps, save);
  } catch (err) {
    state.status = "failed";
    state.error = isHandlerError(err)
      ? { code: err.reason, message: err.message }
      : { code: "step_failed", message: err instanceof Error ? err.message : String(err) };
    await save();
    throw err;
  }
}

async function advance(
  scope: ImportScope,
  state: SteeringImportState,
  deps: SteeringImportDeps,
  save: () => Promise<void>,
): Promise<ImportResult> {
  // One conversion per run. The inputs are pinned, so every call answers the
  // same files.
  let conversion: OxagenTreeConversion | null = null;
  let source: OpenedRepository | null = null;
  // `.oxagen/` at the pinned commit, read once. The cleanup compares each
  // file it would remove against this read.
  let snapshot: Map<string, string> | null = null;
  const openSource = async (from: ImportSourceRepository) => {
    source ??= await deps.openSource(scope, from);
    return source;
  };
  const readSnapshot = async (from: ImportSource) => {
    snapshot ??= await readOxagenTree(await openSource(from), from.commit);
    return snapshot;
  };
  const convert = async (
    from: ImportSource,
    steering: { workspaceToml: string | null; governanceToml: string | null } | null,
  ): Promise<OxagenTreeConversion> => {
    const [files, agents, names] = await Promise.all([
      readSnapshot(from),
      deps.agents(scope),
      deps.names(scope),
    ]);
    const result = convertOxagenTree({
      files,
      organization: names.organization,
      workspace: names.workspace,
      relinked: from.relinked,
      ruleKinds: state.rule_kinds,
      constraintEffects: state.constraint_effects,
      agents,
      ...(steering ?? {}),
    });
    if (!result.ok) throw conflict(result.reason, result.message);
    return result.conversion;
  };

  // 1. Read the source and check the conversion before anything changes.
  if (!reached(state, "record_source")) {
    const head = await deps.readSteeringHead(scope);
    switch (head.kind) {
      case "provisioned":
        state.status = "done";
        state.outcome = "nothing_to_import";
        state.steering_repository = head.fullName;
        await save();
        return resultOf(state);
      case "unsupported":
        throw conflict(
          "steering_import_provider_unsupported",
          `The workspace is steered by ${head.fullName} on ${head.provider}. The import reads .oxagen/ from GitHub only.`,
        );
      case "unreachable":
        throw conflict(
          "steering_import_source_unreachable",
          `Oxagen can no longer reach ${head.fullName}, the repository that steers this workspace. Connect it again, then run the import.`,
        );
      case "legacy":
        throw conflict(
          "steering_import_legacy_connection",
          `The workspace reads ${head.fullName} through a sources connection with no binding. The import reads only a bound repository, and Oxagen cannot bind a legacy connection, so this workspace cannot import yet.`,
        );
      case "none":
        state.source = null;
        break;
      case "repository": {
        const { kind: _kind, ...repository } = head;
        const opened = await openSource(repository);
        const commit = await opened.host.branchHead(
          opened.repo,
          repository.default_branch,
        );
        if (commit === null)
          throw conflict(
            "steering_import_source_unreachable",
            `${repository.full_name} has no branch ${repository.default_branch}, so the import cannot read .oxagen/.`,
          );
        const from: ImportSource = {
          ...repository,
          commit,
          relinked: githubRepoRef(repository.owner, repository.name),
        };
        const checked = await convert(from, null);
        if (
          checked.rulesNeedingKind.length > 0 ||
          checked.constraintsNeedingEffect.length > 0
        ) {
          state.status = "waiting";
          state.outcome = "needs_choices";
          state.rules_needing_kind = checked.rulesNeedingKind;
          state.constraints_needing_effect = checked.constraintsNeedingEffect;
          await save();
          return resultOf(state);
        }
        state.source = from;
        break;
      }
    }
    state.rules_needing_kind = [];
    state.constraints_needing_effect = [];
    state.outcome = null;
    state.step = "record_source";
    await save();
  }

  // 2. The old head stops steering. The bind refuses while it steers.
  if (!reached(state, "demote")) {
    if (state.source !== null && !(await deps.demote(scope, state.source.head_id))) {
      // Forget the source, so the next run reads the steering head again
      // instead of retrying a head that is gone.
      const gone = state.source.full_name;
      state.source = null;
      state.step = null;
      throw conflict(
        "steering_import_source_gone",
        `The binding of ${gone} is gone. Run the import again to read the workspace afresh.`,
      );
    }
    state.step = "demote";
    await save();
  }

  // 3. The steering repo.
  if (!reached(state, "provision")) {
    try {
      await deps.provision(scope);
    } catch (err) {
      // Put the old head back so the workspace keeps its steering. When the
      // bind already made a new steering head, the restore refuses, and the
      // next run finishes provisioning instead.
      if (
        state.source !== null &&
        (await deps.restore(scope, state.source.head_id))
      )
        state.step = null;
      throw err;
    }
    state.step = "provision";
    await save();
  }

  // 4. The import steering PRs.
  if (!reached(state, "import")) {
    const steering = await deps.openSteering(scope);
    state.steering_repository = steering.repo.fullName;
    if (state.source !== null) {
      if (state.steering_base === null) {
        const base = await steering.host.branchHead(
          steering.repo,
          steering.repo.defaultBranch,
        );
        if (base === null)
          throw conflict(
            "steering_repo_not_ready",
            `${steering.repo.fullName} has no branch ${steering.repo.defaultBranch} yet.`,
          );
        state.steering_base = base;
        await save();
      }
      const base = state.steering_base;
      const [workspaceToml, governanceToml] = await Promise.all([
        steering.host.readFile(steering.repo, WORKSPACE_TOML_PATH, base),
        steering.host.readFile(steering.repo, GOVERNANCE_TOML_PATH, base),
      ]);
      conversion = await convert(state.source, { workspaceToml, governanceToml });
      for (const branch of conversion.branches) {
        if (state.pull_requests.some((pr) => pr.branch === branch.branch)) continue;
        state.pull_requests.push(
          await openImportPullRequest(steering, base, conversion, branch, state.source.relinked),
        );
        await save();
      }
      state.left_for_a_person = leftForAPerson(conversion);
    }
    state.step = "import";
    await save();
  }

  // 5. The cleanup PR on the old repository.
  if (!reached(state, "cleanup")) {
    if (state.source !== null && state.cleanup === null) {
      const from = state.source;
      const opened = await openSource(from);
      if (state.cleanup_base === null) {
        const base = await opened.host.branchHead(opened.repo, from.default_branch);
        if (base === null)
          throw conflict(
            "steering_import_source_unreachable",
            `${from.full_name} has no branch ${from.default_branch}, so the import cannot open the cleanup PR.`,
          );
        state.cleanup_base = base;
        await save();
      }
      const base = state.cleanup_base;
      conversion ??= await convert(from, await steeringFiles(scope, state, deps));
      const present = new Set(
        await opened.host.listFiles(opened.repo, base, LEGACY_OXAGEN_DIR),
      );
      const candidates = conversion.cleanupPaths.filter((path) => present.has(path));
      // A file that changed after the run read it holds an edit the import
      // did not carry, so the cleanup keeps it for a person.
      const kept = await changedSince(
        opened,
        base,
        from.commit,
        candidates,
        await readSnapshot(from),
      );
      const paths = candidates.filter((path) => !kept.includes(path));
      state.cleanup_kept = kept;
      state.left_for_a_person = leftForAPerson(conversion) + kept.length;
      if (paths.length > 0) {
        state.cleanup = await openCleanupPullRequest(opened, base, {
          steeringRepository: state.steering_repository ?? "",
          pullRequests: state.pull_requests,
          paths,
          commit: from.commit,
          kept,
          dropped: conversion.dropped,
        });
      }
    }
    state.step = "cleanup";
    state.status = "done";
    state.outcome = state.source === null ? "provisioned" : "imported";
    await save();
  }

  return resultOf(state);
}

/** workspace.toml and governance.toml at the pinned steering base. */
async function steeringFiles(
  scope: ImportScope,
  state: SteeringImportState,
  deps: SteeringImportDeps,
): Promise<{ workspaceToml: string | null; governanceToml: string | null } | null> {
  if (state.steering_base === null) return null;
  const steering = await deps.openSteering(scope);
  const [workspaceToml, governanceToml] = await Promise.all([
    steering.host.readFile(steering.repo, WORKSPACE_TOML_PATH, state.steering_base),
    steering.host.readFile(steering.repo, GOVERNANCE_TOML_PATH, state.steering_base),
  ]);
  return { workspaceToml, governanceToml };
}

/**
 * Open, or find, one import steering PR. The branch starts at `base`, and the
 * files are committed only while the branch is still there, so a resumed run
 * never commits them twice. A branch that holds anything else is refused.
 */
async function openImportPullRequest(
  steering: OpenedRepository,
  base: string,
  conversion: OxagenTreeConversion,
  branch: ImportBranch,
  relinked: string,
): Promise<ImportPullRequest> {
  const { host, repo } = steering;
  try {
    const title = importPullRequestTitle(conversion, branch);
    await commitOnce(steering, base, branch.branch, title, branch.files);
    const open = await host.findOpenPullRequest(repo, {
      head: branch.branch,
      base: repo.defaultBranch,
    });
    if (open) return { branch: branch.branch, number: open.number, url: open.htmlUrl };
    const opened = await host.openPullRequest(repo, {
      title,
      head: branch.branch,
      base: repo.defaultBranch,
      body: importPullRequestBody(conversion, branch, relinked),
      labels: OXAGEN_PR_LABELS,
    });
    return { branch: branch.branch, number: opened.number, url: opened.htmlUrl };
  } catch (err) {
    throw githubRefused(err);
  }
}

/**
 * Open, or find, the cleanup PR on the old repository. The branch holds one
 * commit that removes `paths`, and a branch that holds anything else is
 * refused.
 */
async function openCleanupPullRequest(
  source: OpenedRepository,
  base: string,
  args: {
    steeringRepository: string;
    pullRequests: readonly ImportPullRequest[];
    paths: readonly string[];
    commit: string;
    kept: readonly string[];
    dropped: Readonly<Record<string, readonly string[]>>;
  },
): Promise<{ number: number; url: string }> {
  const { host, repo } = source;
  try {
    const title = "Remove the .oxagen/ files the steering repo now holds";
    await commitOnce(
      source,
      base,
      IMPORT_CLEANUP_BRANCH,
      title,
      args.paths.map((path) => ({ path, content: null })),
    );
    const open = await host.findOpenPullRequest(repo, {
      head: IMPORT_CLEANUP_BRANCH,
      base: repo.defaultBranch,
    });
    if (open) return { number: open.number, url: open.htmlUrl };
    const opened = await host.openPullRequest(repo, {
      title,
      head: IMPORT_CLEANUP_BRANCH,
      base: repo.defaultBranch,
      body: cleanupPullRequestBody(args),
    });
    return { number: opened.number, url: opened.htmlUrl };
  } catch (err) {
    throw githubRefused(err);
  }
}
