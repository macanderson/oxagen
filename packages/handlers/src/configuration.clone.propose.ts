// audit-exempt: clone proposals publish nothing and create no agent identity; the kernel audits this write.
import { applyCloneIdentity } from "./configuration-clone-draft";
import { parse } from "smol-toml";
import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import { CONTEXT_RECORD_LABEL_MAX } from "@oxagen/oxagen/context-record-label";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { configurationClonePropose } from "@oxagen/oxagen/contracts/configuration.clone.propose";
import { agentPropose } from "@oxagen/oxagen/contracts/agent.propose";
import { skillPropose } from "@oxagen/oxagen/contracts/skill.propose";
import { contextProposalCreate } from "@oxagen/oxagen/contracts/context.proposal.create";
import {
  createProposeAgentHandler,
  readAgentProposalFacts,
} from "./agent.propose";
import { createProposeSkillHandler } from "./skill.propose";
import { createProposeRecordHandler } from "./context.proposal.create";
import { type SteeringGitHub } from "./context.steering.github";
import { createSteeringHost } from "./context.steering.host";
import {
  postgresSteeringStore,
  type SteeringStore,
} from "./context.steering.store";
import {
  configurationNameTaken,
  configurationSourceDigest,
  readConfigurationSource,
} from "./configuration-clone-source";

// The GitHub seams have no option for a create-only proposal, so the two
// methods that decide reuse are overridden here. The store does
// (`insertProposal(values, { createOnly })`), and the record path passes it
// through `createProposeRecordHandler` instead of wrapping the store.
function overrideMethods<T extends object>(
  target: T,
  overrides: Partial<T>,
): T {
  return new Proxy(target, {
    get(object, key) {
      if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
      const value: unknown = Reflect.get(object, key, object);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(object)
        : value;
    },
  });
}

export function createOnlyCloneGitHub(github: SteeringGitHub): SteeringGitHub {
  return overrideMethods(github, {
    async findOpenPullRequest(
      repo: Parameters<SteeringGitHub["findOpenPullRequest"]>[0],
      args: Parameters<SteeringGitHub["findOpenPullRequest"]>[1],
    ) {
      if (await github.findOpenPullRequest(repo, args))
        throw new HandlerError({
          code: "conflict",
          reason: "clone_name_taken",
          message:
            "A proposal already holds this clone name. Refresh the draft.",
        });
      return null;
    },
    ensureBranch: (
      repo: Parameters<SteeringGitHub["ensureBranch"]>[0],
      branch: string,
      base: string,
    ) => github.ensureBranch(repo, branch, base, { exclusive: true }),
  });
}

export function createConfigurationCloneProposeHandler(deps: {
  source: typeof readConfigurationSource;
  taken: typeof configurationNameTaken;
  github: SteeringGitHub;
  facts: typeof readAgentProposalFacts;
  store: SteeringStore;
}): CapabilityHandler<typeof configurationClonePropose> {
  return async (input, ctx) => {
    // The draft allows 200 characters for every kind, and a record's name is
    // its label (ADR-178). Refuse a long one here, before the record parse
    // throws an untyped ZodError. The MCP tool spreads the contract's
    // `.shape`, so the contract cannot carry a per-kind refinement.
    if (input.kind === "record" && input.name.length > CONTEXT_RECORD_LABEL_MAX)
      throw new CapabilityError(
        configurationClonePropose.name,
        "invalid_input",
        `A record's label is at most ${CONTEXT_RECORD_LABEL_MAX} characters. Choose a shorter name.`,
      );
    const userId = await resolveActingUserId(ctx);
    await assertOrgRole({ ...ctx, userId }, { org: ["Owner", "Admin"] });
    const original = await deps.source(ctx, input.kind, input.sourceId);
    if (configurationSourceDigest(original) !== input.sourceDigest)
      throw new HandlerError({
        code: "conflict",
        reason: "clone_source_changed",
        message:
          "The source changed after this draft opened. Refresh the clone draft.",
      });
    if (await deps.taken(ctx, original, input.slug, input.name))
      throw new HandlerError({
        code: "conflict",
        reason: "clone_name_taken",
        message:
          "Another configuration already holds this slug or name. Choose another.",
      });
    const github = createOnlyCloneGitHub(deps.github);
    const source = applyCloneIdentity(input);
    const rationale = `Clone ${original.slug} from ${input.sourceDigest}. Retiring the source is a separate action.`;
    if (input.kind === "agent") {
      const doc = parse(source);
      if (
        doc.slug !== input.slug ||
        doc.name !== input.name ||
        input.files.length
      )
        throw new HandlerError({
          code: "conflict",
          reason: "clone_identity_mismatch",
          message: "The draft name and slug must match the proposed source",
        });
      const proposal = await createProposeAgentHandler({
        github,
        facts: deps.facts,
      })(
        agentPropose.input.parse({
          slug: input.slug,
          harness: input.harness,
          source,
          rationale,
        }),
        ctx,
      );
      return {
        slug: proposal.slug,
        proposalId: null,
        pullRequest: proposal.pullRequest,
      };
    }
    if (input.kind === "skill") {
      if (input.name !== input.slug)
        throw new HandlerError({
          code: "conflict",
          reason: "clone_identity_mismatch",
          message: "A skill uses its name as its source directory",
        });
      // A clone never takes the replacement path, including when publication races the earlier name check.
      const target = `.oxagen/skills/${input.slug}/SKILL.md`;
      const skillGitHub: SteeringGitHub = overrideMethods(github, {
        async readFile(
          repo: Parameters<SteeringGitHub["readFile"]>[0],
          path: string,
          ref: string,
        ) {
          const body = await github.readFile(repo, path, ref);
          if (path === target && body !== null)
            throw new HandlerError({
              code: "conflict",
              reason: "clone_name_taken",
              message: "A published skill already holds this clone name",
            });
          return body;
        },
      });
      const proposal = await createProposeSkillHandler({ github: skillGitHub })(
        skillPropose.input.parse({
          origin: "upload",
          name: input.slug,
          body: source,
          files: input.files,
          rationale,
        }),
        ctx,
      );
      return {
        slug: proposal.name,
        proposalId: null,
        pullRequest: proposal.pullRequest,
      };
    }
    const record = contextProposalCreate.input.parse({
      record: parse(source),
      rationale,
      support: {
        evidenceLinks: [`configuration:${original.slug}@${input.sourceDigest}`],
      },
    });
    if (
      record.record.lineageId !== input.slug ||
      record.record.label !== input.name ||
      input.files.length
    )
      throw new HandlerError({
        code: "conflict",
        reason: "clone_identity_mismatch",
        message: "The draft name and lineage must match the proposed source",
      });
    const proposal = await createProposeRecordHandler({
      store: deps.store,
      createOnly: true,
    })(record, ctx);
    return {
      slug: input.slug,
      proposalId: proposal.proposalId,
      pullRequest: null,
    };
  };
}
export const configurationCloneProposeHandler =
  createConfigurationCloneProposeHandler({
    source: readConfigurationSource,
    taken: configurationNameTaken,
    github: createSteeringHost(),
    facts: readAgentProposalFacts,
    store: postgresSteeringStore,
  });
