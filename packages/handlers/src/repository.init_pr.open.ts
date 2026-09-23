// repository.init_pr.open.ts — `open_init_pr` (Mission Control spec §10.2; the
// Repositories page's init wizard).
//
// Flow:
//   1. Role gate: org Owner or Admin (repository-binding spec section 2.3).
//   2. The two files the person reviewed are checked before anything reaches
//      GitHub: governance.toml must parse and declare exactly the mode they
//      chose (the Context PR gate reads it on every open and merge, and a file
//      it cannot read refuses both), workspace.toml must parse, neither file
//      may carry a credential or personal data (`secret_pii_scan`), and
//      neither may declare a grant of authority (`no_authority`): a tool, a
//      tier, a budget, a permission. The repository-binding spec §2.3 names
//      the five checks; these are the two that read the files alone.
//   3. The bound repository by its binding id, a client for the workspace's
//      installation, and the check that GitHub's repository at those
//      coordinates is still the one the binding carries the id of.
//   4. An init pull request already open is answered as it is.
//   5. The production branch must not be `oxagen/init` itself, must exist,
//      and must carry no `.oxagen/` yet.
//   6. `oxagen/init` is created from the production branch (an existing
//      branch is reused), the six files are pushed to it one commit each,
//      and one pull request is opened back into the production branch.
//
// Nothing is written to the production branch and nothing is merged: the
// pull request is where a person decides.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { OXAGEN_PR_LABELS } from "@oxagen/github";
import {
  INIT_BRANCH,
  repositoryInitPrOpen,
  type RepositoryInitPrOpenOutput,
} from "@oxagen/oxagen/contracts/repository.init_pr.open";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { parse } from "smol-toml";
import { findSecretsAndPii } from "./context.steering.checks";
import {
  GOVERNANCE_PATH,
  parseGovernanceMode,
} from "./context.steering.policy";
import { logger } from "./logger";
import {
  githubRefused,
  isGithubNotFound,
  readBoundRepository,
  repositoryNotInstalled,
  requireBoundRepoInfo,
  requireWorkspaceGithub,
  workspaceGithub,
  type WorkspaceGithub,
} from "./repository.bound";
import { OXAGEN_DIR, WORKSPACE_TOML_PATH } from "./repository.tree.get";

/** The lines `.gitignore` must carry so the machine-local link is never committed. */
export const GITIGNORE_LINES = [".oxagen/workspace.json", ".stella/private/"];

const KEEP_FILES = [
  ".oxagen/rules/.gitkeep",
  ".oxagen/proposals/.gitkeep",
  ".oxagen/agents/.gitkeep",
];

/**
 * `.gitignore` with every line in {@link GITIGNORE_LINES} present, or null
 * when the file already carries them all and needs no commit.
 */
export function gitignoreWithOxagen(current: string | null): string | null {
  const text = current ?? "";
  const present = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length === 0) return null;
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  const header =
    "# Oxagen: this machine's link to a workspace; never committed.\n";
  return `${base}${base === "" ? "" : "\n"}${header}${missing.join("\n")}\n`;
}

function tomlRefused(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

/**
 * A key that, wherever it sits in the tree, reads as a grant: a tool an
 * agent may call, a tier or budget it runs under, a permission it holds.
 * `.oxagen/workspace.toml` v0.1 says which workspace a repository belongs
 * to and nothing more, so no such key has a place in it; one that appears
 * is refused rather than merged and then argued about. `role` is not in the
 * list: `[repository] role` is the repository's role, main or linked.
 */
const GRANT_KEYS = new Set([
  "tool",
  "tools",
  "grant",
  "grants",
  "allow",
  "allowed",
  "permission",
  "permissions",
  "mandate",
  "mandates",
  "authority",
  "budget",
  "budgets",
  "tier",
  "tiers",
  "capability",
  "capabilities",
  "spend",
  "limit",
  "limits",
]);

/** Every key path in a parsed TOML tree that names a grant, dotted. */
export function findAuthorityGrants(
  tree: unknown,
  at: string[] = [],
): string[] {
  if (Array.isArray(tree)) {
    return tree.flatMap((value, index) =>
      findAuthorityGrants(value, [...at, String(index)]),
    );
  }
  if (typeof tree !== "object" || tree === null) return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = [...at, key];
    if (GRANT_KEYS.has(key.toLowerCase())) found.push(path.join("."));
    else found.push(...findAuthorityGrants(value, path));
  }
  return found;
}

/**
 * Checks 4 and 5 of the init lane, over the two reviewed files. Run before
 * the first GitHub call: a file pushed to a branch is already in the
 * repository's history, and a pull request is not where a secret is caught.
 */
function refuseSecretsAndGrants(files: {
  workspace: { text: string; tree: unknown };
  governance: { text: string; tree: unknown };
}): void {
  const named = (path: string, findings: string[]) =>
    findings.map((finding) => `${path}: ${finding}`);
  const secrets = [
    ...named(WORKSPACE_TOML_PATH, findSecretsAndPii(files.workspace.text)),
    ...named(GOVERNANCE_PATH, findSecretsAndPii(files.governance.text)),
  ];
  if (secrets.length > 0) {
    throw tomlRefused(
      "secret_found",
      `the files carry what must not be committed: ${secrets.join("; ")}`,
    );
  }
  const grants = [
    ...named(WORKSPACE_TOML_PATH, findAuthorityGrants(files.workspace.tree)),
    ...named(GOVERNANCE_PATH, findAuthorityGrants(files.governance.tree)),
  ];
  if (grants.length > 0) {
    throw tomlRefused(
      "authority_declared",
      `the files declare a grant of authority, which the init tree never carries: ${grants.join("; ")}`,
    );
  }
}

export interface InitPrDeps {
  github: WorkspaceGithub;
  readBound: typeof readBoundRepository;
  now: () => Date;
}

export function createInitPrOpenHandler(
  deps: InitPrDeps,
): CapabilityHandler<typeof repositoryInitPrOpen> {
  return async (input, ctx): Promise<RepositoryInitPrOpenOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"] },
    );

    const declared = parseGovernanceMode(input.governanceToml);
    if (typeof declared !== "string") {
      throw tomlRefused("governance_toml_invalid", declared.error);
    }
    if (declared !== input.governanceMode) {
      throw tomlRefused(
        "governance_toml_invalid",
        `governance.toml declares mode ${declared}; the chosen mode is ${input.governanceMode}`,
      );
    }
    let workspaceTree: unknown;
    try {
      workspaceTree = parse(input.workspaceToml);
    } catch (err) {
      throw tomlRefused(
        "workspace_toml_invalid",
        `workspace.toml is not TOML: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    refuseSecretsAndGrants({
      workspace: { text: input.workspaceToml, tree: workspaceTree },
      // governance.toml parsed above, through parseGovernanceMode.
      governance: {
        text: input.governanceToml,
        tree: parse(input.governanceToml),
      },
    });

    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const bound = await deps.readBound(scope, input.bindingId);
    const base = bound.productionBranch;
    // The files go to `oxagen/init`. When that is also the production branch,
    // pushing to it is a write to the production branch, which this never
    // makes. Refused before any GitHub call.
    if (base === INIT_BRANCH) {
      throw new HandlerError({
        code: "conflict",
        reason: "production_branch_is_init_branch",
        message: `${bound.fullName} records ${INIT_BRANCH} as its production branch. Set another production branch first.`,
      });
    }
    const gh = await requireWorkspaceGithub(deps.github, scope);
    const at = { owner: bound.owner, repo: bound.name };
    const openedAt = deps.now().toISOString();

    // Before the first read, and long before the first write: the repository
    // at these coordinates has to be the one this binding was made against.
    // `owner/name` is a label a person can move — delete a repository, create
    // another under the same name, and this handler would push governance
    // files and open a pull request on a stranger's repository. The immutable
    // id is what the binding holds, so it is what is checked.
    await requireBoundRepoInfo(gh, bound);

    let existing;
    try {
      existing = await gh.findOpenPullRequest({
        ...at,
        head: INIT_BRANCH,
        base,
      });
    } catch (err) {
      if (isGithubNotFound(err)) throw repositoryNotInstalled(bound.fullName);
      throw err;
    }
    if (existing) {
      return {
        bindingId: bound.bindingId,
        fullName: bound.fullName,
        branch: INIT_BRANCH,
        base,
        pullRequest: { number: existing.number, htmlUrl: existing.htmlUrl },
        files: [],
        reused: true,
        openedAt,
      };
    }

    const head = await gh.getBranch({ ...at, branch: base });
    if (!head) {
      throw new HandlerError({
        code: "conflict",
        reason: "production_branch_missing",
        message: `${bound.fullName} has no branch ${base}; set the production branch first`,
      });
    }
    const tree = await gh.getTree({ ...at, ref: base });
    if (tree.some((path) => path.startsWith(OXAGEN_DIR))) {
      throw new HandlerError({
        code: "conflict",
        reason: "oxagen_tree_exists",
        message: `${bound.fullName} already has .oxagen/ on ${base}; change it with an ordinary pull request`,
      });
    }

    const gitignore = gitignoreWithOxagen(
      tree.includes(".gitignore")
        ? await gh.getFileContent({ ...at, path: ".gitignore", ref: base })
        : null,
    );
    const writes: Array<{ path: string; content: string }> = [
      { path: WORKSPACE_TOML_PATH, content: input.workspaceToml },
      { path: GOVERNANCE_PATH, content: input.governanceToml },
      ...KEEP_FILES.map((path) => ({ path, content: "" })),
      ...(gitignore === null
        ? []
        : [{ path: ".gitignore", content: gitignore }]),
    ];

    try {
      await gh.createBranch({ ...at, branch: INIT_BRANCH, fromBranch: base });
    } catch (err) {
      // A branch left by an earlier attempt whose pull request was closed.
      // Pushing onto it is what a retry means; the files overwrite in place.
      if (
        !(err instanceof Error && /Reference already exists/i.test(err.message))
      )
        throw githubRefused(err);
    }

    try {
      for (const file of writes) {
        await gh.putFile({
          ...at,
          path: file.path,
          content: file.content,
          message: `oxagen: add ${file.path}`,
          branch: INIT_BRANCH,
        });
      }
    } catch (err) {
      throw githubRefused(err);
    }

    let pr;
    try {
      pr = await gh.openPullRequest({
        ...at,
        title: "Add Oxagen to this repository",
        head: INIT_BRANCH,
        base,
        labels: OXAGEN_PR_LABELS,
        body: [
          `Adds the \`.oxagen/\` tree to ${bound.fullName}, opened from Oxagen.`,
          "",
          `- \`.oxagen/workspace.toml\`: the workspace this repository belongs to, as reviewed.`,
          `- \`.oxagen/rules/governance.toml\`: mode = ${input.governanceMode}. The Context PR gate reads it on every open and every merge.`,
          "- `.gitkeep` files for `rules/`, `proposals/` and `agents/`.",
          gitignore === null
            ? "- `.gitignore` already ignores `.oxagen/workspace.json` and `.stella/private/`."
            : "- `.gitignore`: ignores `.oxagen/workspace.json`, which is one machine's link and never reviewed.",
          "",
          "Nothing in this tree grants authority. Merging it is yours.",
        ].join("\n"),
      });
    } catch (err) {
      throw githubRefused(err);
    }

    logger.info(
      { ...scope, repository: bound.fullName, pullRequest: pr.number },
      "repository.init_pr.open: init pull request opened",
    );

    return {
      bindingId: bound.bindingId,
      fullName: bound.fullName,
      branch: INIT_BRANCH,
      base,
      pullRequest: { number: pr.number, htmlUrl: pr.htmlUrl },
      files: writes.map((file) => file.path),
      reused: false,
      openedAt,
    };
  };
}

export const repositoryInitPrOpenHandler = createInitPrOpenHandler({
  github: workspaceGithub,
  readBound: readBoundRepository,
  now: () => new Date(),
});
