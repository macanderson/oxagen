// audit-exempt: opening the pull request publishes nothing (the skill resolves nowhere until a person merges it, MC spec §10.6); the kernel's capability.invoke_* audit records the call.
//
// propose_skill (MC spec §10.2, §10.6; Appendix E; ADR-090; roadmap
// creation-spec §4). The last step of the skill wizard: a pull request against
// the workspace's main repository, never a row.
//
// Flow:
//   1. Role gate: org Owner or Admin (assertOrgRole, INV-29), for the signed-in
//      user. An API key carries no user, so the call is refused there.
//   2. The main repository and its production branch, from the repository
//      binding (the SteeringGitHub seam, the one open_context_pr uses).
//   3. What is merged today: the skill's SKILL.md on the production branch
//      (a replacement must carry a strictly greater version) and the search
//      budget from `.oxagen/skills.toml` (the default when it names none).
//   4. The six checks over the bytes the operator saw. Any failure refuses the
//      call with `skill_check_<name>` naming the failing check, and nothing
//      reaches GitHub.
//   5. The branch `skills/<name>` from the production branch, one commit per
//      file, then the branch's open pull request is reused or a new one opened.
//      The lookup runs before the first write, so a second proposal on the same
//      name lands on the pull request already under review.
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import {
  checkSkill,
  DEFAULT_SKILL_LOAD_BUDGET,
  estimateSkillTokens,
  readSearchBudget,
  readSkillFrontmatter,
  SKILL_DIR,
  SKILLS_CONFIG_PATH,
  skillBranch,
  skillPath,
  skillPropose,
} from "@oxagen/oxagen/contracts/skill.propose";
import {
  createSteeringGitHub,
  type SteeringGitHub,
} from "./context.steering.github";
import { sha256Hex } from "./registry-digest";

export type ProposeSkillDeps = {
  github: Pick<
    SteeringGitHub,
    | "resolveRepository"
    | "readFile"
    | "ensureBranch"
    | "deleteBranch"
    | "reconcileFiles"
    | "putFile"
    | "findOpenPullRequest"
    | "openPullRequest"
  >;
};

/** The canonical bytes a digest is taken over: LF line ends, nothing else changed. */
function canonical(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function prBody(args: {
  name: string;
  version: string;
  replaces: string | null;
  origin: "describe" | "upload";
  digest: string;
  tokens: number;
  budget: number;
  rationale: string | undefined;
  files: readonly string[];
}): string {
  const lines = [
    args.replaces === null
      ? `Adds the skill \`${args.name}\` at ${args.version}.`
      : `Replaces \`${args.name}\` ${args.replaces} with ${args.version}.`,
    "",
    args.origin === "describe"
      ? "Drafted in the Oxagen skill wizard from a description, and edited by the person who opened this pull request."
      : "Read out of an uploaded bundle in the Oxagen skill wizard.",
    "",
    `- Digest at open: \`${args.digest}\`. The checks cover these submitted bytes. Later pushes require a new review.`,
    `- Load cost: about ${args.tokens.toLocaleString("en-US")} tokens, inside the ${args.budget.toLocaleString("en-US")}-token search budget.`,
    "- This file grants nothing. Every action it names still goes through the toolbelt and the policy that governs it.",
    "",
    "Files:",
    ...args.files.map((f) => `- \`${f}\``),
  ];
  if (args.rationale?.trim()) {
    lines.push(
      "",
      "What the author asked for:",
      "",
      `> ${args.rationale.trim().replace(/\n/g, "\n> ")}`,
    );
  }
  return lines.join("\n");
}

export function createProposeSkillHandler(
  deps: ProposeSkillDeps,
): CapabilityHandler<typeof skillPropose> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"] },
    );

    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const repo = await deps.github.resolveRepository(scope);
    const base = repo.defaultBranch;
    const path = skillPath(input.name);

    const [merged, config] = await Promise.all([
      deps.github.readFile(repo, path, base),
      deps.github.readFile(repo, SKILLS_CONFIG_PATH, base),
    ]);
    const replaces =
      merged === null
        ? null
        : (readSkillFrontmatter(merged)?.fields.version ?? null);
    if (merged !== null && replaces === null) {
      throw new HandlerError({
        code: "conflict",
        reason: "skill_merged_unversioned",
        message: `${path} is merged with no version in its frontmatter; fix it on the production branch first`,
      });
    }
    const budget = readSearchBudget(config) ?? DEFAULT_SKILL_LOAD_BUDGET;

    const body = canonical(input.body);
    const files = input.files.map((f) => ({
      path: f.path,
      content: canonical(f.content),
    }));
    const checks = checkSkill({
      name: input.name,
      body,
      files,
      replacing: replaces,
      budget,
    });
    const failed = checks.find((c) => !c.passed);
    if (failed) {
      throw new HandlerError({
        code: "conflict",
        // The reason names the check, so a surface can say which one failed
        // without parsing the message: skill_check_version, skill_check_grants.
        reason: `skill_check_${failed.name}`,
        message: `The ${failed.name} check failed (${failed.code ?? "failed"}); nothing was written`,
      });
    }

    const version = readSkillFrontmatter(body)?.fields.version ?? "";
    const digest = `sha256:${sha256Hex(body)}`;
    const tokens = estimateSkillTokens(body);
    const branch = skillBranch(input.name);
    const written = [
      path,
      ...files.map((f) => `${SKILL_DIR}/${input.name}/${f.path}`),
    ];

    if (branch === base) {
      throw new HandlerError({
        code: "conflict",
        reason: "production_branch_is_proposal_branch",
        message:
          "The proposal branch is the production branch. Change the repository binding before proposing files.",
      });
    }

    const open = await deps.github.findOpenPullRequest(repo, {
      head: branch,
      base,
    });
    if (open === null) await deps.github.deleteBranch(repo, branch);
    await deps.github.ensureBranch(repo, branch, base);
    await deps.github.reconcileFiles(repo, {
      branch,
      roots: [`${SKILL_DIR}/${input.name}`],
      files: written,
    });

    const message =
      replaces === null
        ? `skills: add ${input.name} ${version}`
        : `skills: ${input.name} ${replaces} to ${version}`;
    let commitSha = "";
    ({ commitSha } = await deps.github.putFile(repo, {
      path,
      content: body,
      message,
      branch,
    }));
    for (const f of files) {
      ({ commitSha } = await deps.github.putFile(repo, {
        path: `${SKILL_DIR}/${input.name}/${f.path}`,
        content: f.content,
        message,
        branch,
      }));
    }

    const pullRequest =
      open ??
      (await deps.github.openPullRequest(repo, {
        title:
          replaces === null
            ? `Skill: ${input.name}`
            : `Skill: ${input.name} ${version}`,
        head: branch,
        base,
        body: prBody({
          name: input.name,
          version,
          replaces,
          origin: input.origin,
          digest,
          tokens,
          budget,
          rationale: input.rationale,
          files: written,
        }),
      }));

    return {
      name: input.name,
      path,
      branch,
      repository: repo.fullName,
      baseRef: base,
      version,
      replaces,
      digest,
      tokens,
      budget,
      checks,
      commitSha,
      pullRequest: { number: pullRequest.number, url: pullRequest.htmlUrl },
    };
  };
}

// Built once: the GitHub seam keys its clients by the repository handle each
// call resolves, so one instance serves every workspace. The initializer is
// the factory call, which is what the INV-29 role-check test reads.
export const proposeSkillHandler: CapabilityHandler<typeof skillPropose> =
  createProposeSkillHandler({ github: createSteeringGitHub() });
