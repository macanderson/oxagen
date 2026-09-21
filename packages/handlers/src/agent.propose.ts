// audit-exempt: opening the pull request creates nothing (register_agent creates the identity after merge, MC spec §6.2); the kernel's capability.invoke_* audit records the call.
//
// propose_agent (MC spec §6.2, §10.2; roadmap creation-spec §1, the agent
// wizard). The last step of New agent: a pull request against the workspace's
// main repository, never a row. Register an agent is the other way in, for an
// agent that already runs; it is `register_agent`, and this is not it.
//
// Flow:
//   1. Role gate: org Owner or Admin (assertOrgRole, INV-29), for the signed-in
//      user. Registration after merge creates the principal.
//   2. The file is parsed. A file that does not parse fails the schema check.
//   3. What the checks read, in one tenant transaction: whether the slug is
//      held by an agent in this workspace (the slug index covers retired and
//      soft-deleted rows, ADR-024), the namespaces the agent key is made of,
//      the workspace's tool registry for the belt, and, for an enterprise
//      organization, which capabilities in the belt the author does not hold.
//   4. The main repository and its production branch, from the repository
//      binding. A definition already merged at the path also holds the slug.
//   5. The six checks. Any failure refuses the call with `agent_check_<name>`
//      and nothing reaches GitHub.
//   6. The branch `agents/<slug>`, the definition and the generated subagent
//      file, then the branch's open pull request is reused or a new one opened.
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import {
  composeAgentKey,
  resolveNamespacePrefix,
} from "@oxagen/agent/handlers/_agent-definition";
import { canAccessACL, resolveOrgTier } from "@oxagen/billing";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  type CapabilityHandler,
  HandlerError,
  listCapabilities,
} from "@oxagen/oxagen";
import {
  type AgentDefinitionDoc,
  agentBranch,
  agentDefinitionPath,
  agentPropose,
  type BeltRegistry,
  beltOf,
  checkAgentDefinition,
  generatedAgentPath,
  generateSubagentFile,
  instructionsOf,
  SUBAGENT_FILE_HARNESSES,
} from "@oxagen/oxagen/contracts/agent.propose";
import type { PlanTier } from "@oxagen/oxagen/types";
import { and, eq, isNull } from "drizzle-orm";
import { parse } from "smol-toml";
import {
  capabilityToolsOf,
  toolsBeyondCeiling,
} from "./agent.definition.commit";
import {
  createSteeringGitHub,
  type SteeringGitHub,
} from "./context.steering.github";
import { sha256Hex } from "./registry-digest";

/** What the checks read from Postgres. Nothing here is written. */
export type AgentProposalFacts = {
  slugTaken: boolean;
  agentKey: string | null;
  registry: BeltRegistry;
  /** Capabilities in the belt the author does not hold; empty below enterprise. */
  exceeded: string[];
};

export type ProposeAgentDeps = {
  github: Pick<
    SteeringGitHub,
    | "resolveRepository"
    | "readFile"
    | "ensureBranch"
    | "reconcileFiles"
    | "putFile"
    | "findOpenPullRequest"
    | "openPullRequest"
    | "updatePullRequest"
  >;
  facts(args: {
    orgId: string;
    workspaceId: string;
    userId: string;
    slug: string;
    belt: readonly string[];
    planTier: PlanTier | undefined;
  }): Promise<AgentProposalFacts>;
};

/** The canonical bytes a digest is taken over: LF line ends, nothing else changed. */
function canonical(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function parseDefinition(source: string): AgentDefinitionDoc | null {
  try {
    return parse(source) as AgentDefinitionDoc;
  } catch {
    return null;
  }
}

function prBody(args: {
  slug: string;
  agentKey: string | null;
  harness: string;
  digest: string;
  files: readonly string[];
  rationale: string | undefined;
}): string {
  const lines = [
    `Adds the agent \`${args.slug}\`, written for ${args.harness}.`,
    "",
    "Drafted in the Oxagen agent wizard from a description, and edited by the person who opened this pull request.",
    "",
    args.agentKey === null
      ? "- After merge, register this agent under the same slug to create its identity and credential."
      : `- After merge, register \`${args.agentKey}\` under the same slug to create its identity and credential.`,
    `- Definition digest at open: \`${args.digest}\`.`,
    "- `tools` is a request, not a grant. What the agent can reach is that list intersected with the roles it holds and with the grants of the person it acts for.",
    ...(SUBAGENT_FILE_HARNESSES.includes(args.harness)
      ? [
          "- The subagent file is generated from the definition. Change the definition, not the generated file.",
        ]
      : []),
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

async function registryOf(tx: Tx, workspaceId: string): Promise<BeltRegistry> {
  const rows = await tx
    .select({
      slug: schema.tools.slug,
      version: schema.toolVersions.versionNumber,
    })
    .from(schema.tools)
    .innerJoin(
      schema.toolVersions,
      eq(schema.toolVersions.toolId, schema.tools.id),
    )
    .where(
      and(
        eq(schema.tools.workspaceId, workspaceId),
        isNull(schema.tools.deletedAt),
      ),
    );
  const bySlug = new Map<string, number[]>();
  for (const r of rows) {
    const slug = String(r.slug);
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), r.version]);
  }
  return {
    tools: [...bySlug].map(([slug, versions]) => ({ slug, versions })),
    capabilities: listCapabilities().map((c) => c.name),
  };
}

/** The Postgres half of the checks: reads only, in the caller's tenant scope. */
export async function readAgentProposalFacts(
  args: Parameters<ProposeAgentDeps["facts"]>[0],
): Promise<AgentProposalFacts> {
  const scope = { orgId: args.orgId, workspaceId: args.workspaceId };
  const tier = args.planTier ?? (await resolveOrgTier(args.orgId));
  return withTenantDb(async (tx) => {
    // No deletedAt filter: a slug is reserved for good once any agent held it.
    const [held] = await tx
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.workspaceId, args.workspaceId),
          eq(schema.agents.slug, args.slug),
        ),
      )
      .limit(1);
    const { orgNamespace, workspaceNamespace } = await resolveNamespacePrefix(
      tx,
      args.orgId,
      args.workspaceId,
    );
    const registry = await registryOf(tx, args.workspaceId);
    let exceeded: string[] = [];
    if (canAccessACL(tier)) {
      const tools = capabilityToolsOf(args.belt);
      const beyond = await toolsBeyondCeiling(
        tx,
        { ...scope, userId: args.userId },
        tools,
        new Date(),
      );
      exceeded = beyond === "no_principal" ? tools : beyond;
    }
    return {
      slugTaken: held !== undefined,
      agentKey: composeAgentKey(orgNamespace, workspaceNamespace, args.slug),
      registry,
      exceeded,
    };
  });
}

export function createProposeAgentHandler(
  deps: ProposeAgentDeps,
): CapabilityHandler<typeof agentPropose> {
  return async (input, ctx) => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"] },
    );
    // assertOrgRole refused a call with no acting user.
    const userId = actingUserId as string;

    const source = canonical(input.source);
    const doc = parseDefinition(source);
    const facts = await deps.facts({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId,
      slug: input.slug,
      belt: beltOf(doc),
      planTier: ctx.planTier,
    });

    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const repo = await deps.github.resolveRepository(scope);
    const base = repo.defaultBranch;
    const path = agentDefinitionPath(input.slug);
    const merged = await deps.github.readFile(repo, path, base);

    const checks = checkAgentDefinition({
      slug: input.slug,
      source,
      doc,
      keyTaken: facts.slugTaken || merged !== null,
      registry: facts.registry,
      exceeded: facts.exceeded,
    });
    const failed = checks.find((c) => !c.passed);
    if (failed || doc === null) {
      const name = failed?.name ?? "schema";
      throw new HandlerError({
        code: "conflict",
        // The reason names the check, so a surface can say which one failed
        // without parsing the message: agent_check_belt, agent_check_key.
        reason: `agent_check_${name}`,
        message: `The ${name} check failed (${failed?.code ?? "not_toml"}); nothing was written`,
      });
    }

    const digest = `sha256:${sha256Hex(source)}`;
    const generatedPath = SUBAGENT_FILE_HARNESSES.includes(input.harness)
      ? generatedAgentPath(input.slug)
      : null;
    const description = doc.description;
    const generated = generateSubagentFile({
      slug: input.slug,
      description:
        typeof description === "string"
          ? description
          : typeof doc.name === "string"
            ? doc.name
            : input.slug,
      instructions: instructionsOf(doc),
      digest,
    });
    const branch = agentBranch(input.slug);

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
    await deps.github.ensureBranch(repo, branch, base, {
      exclusive: open === null,
    });
    await deps.github.reconcileFiles(repo, {
      branch,
      roots: [path, generatedAgentPath(input.slug)],
      files: [path, ...(generatedPath === null ? [] : [generatedPath])],
    });
    const message = `agents: add ${input.slug}`;
    let { commitSha } = await deps.github.putFile(repo, {
      path,
      content: source,
      message,
      branch,
    });
    if (generatedPath !== null)
      ({ commitSha } = await deps.github.putFile(repo, {
        path: generatedPath,
        content: generated,
        message: `agents: generate ${generatedPath} from ${path}`,
        branch,
      }));

    const metadata = {
      title: `Agent: ${input.slug}`,
      body: prBody({
        slug: input.slug,
        agentKey: facts.agentKey,
        harness: input.harness,
        digest,
        files: [path, ...(generatedPath === null ? [] : [generatedPath])],
        rationale: input.rationale,
      }),
    };
    const pullRequest = open
      ? await deps.github.updatePullRequest(repo, {
          number: open.number,
          ...metadata,
        })
      : await deps.github.openPullRequest(repo, {
          head: branch,
          base,
          ...metadata,
        });

    return {
      slug: input.slug,
      agentKey: facts.agentKey,
      path,
      generatedPath,
      branch,
      repository: repo.fullName,
      baseRef: base,
      digest,
      checks,
      commitSha,
      pullRequest: { number: pullRequest.number, url: pullRequest.htmlUrl },
    };
  };
}

// Built once: the GitHub seam keys its clients by the repository handle each
// call resolves, so one instance serves every workspace. The initializer is
// the factory call, which is what the INV-29 role-check test reads.
export const proposeAgentHandler: CapabilityHandler<typeof agentPropose> =
  createProposeAgentHandler({
    github: createSteeringGitHub(),
    facts: readAgentProposalFacts,
  });
