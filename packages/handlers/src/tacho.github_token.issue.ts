// tacho.github_token.issue.ts — a GitHub App installation token for one
// repository governed by the calling host's workspace (ADR-151).
//
// Git in a wrapped run asks tacho's credential helper for a credential; the
// daemon asks here. The answer is a token scoped to one repository's
// immutable id with `contents: write`, minted from the installation attached
// to the workspace's live GitHub connection. The host names the repository;
// it never names the installation, for the reason `bind_main_repository`
// gives (ADR-027).
import type { CapabilityHandler } from "@oxagen/oxagen";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen";
import {
  tachoGithubTokenIssue,
  type TachoGithubTokenIssueOutput,
} from "@oxagen/oxagen/contracts/tacho.github_token.issue";
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import {
  createAppInstallationToken,
  type InstallationTokenResult,
} from "@oxagen/github";
import { and, eq, sql } from "drizzle-orm";
import { resolveEnrolledHost } from "./lib/tacho-host";
import { logger } from "./logger";
import {
  GITHUB_PROVIDER,
  resolveWorkspaceGithubInstallation,
} from "./repository.github-connection";

const CAPABILITY = "create_github_token";

/**
 * The server half of the flag. Both halves must be on: the host configures a repository
 * with `tacho github configure`, and this deployment sets the variable.
 */
export const GITHUB_BROKER_ENV = "OXAGEN_TACHO_GITHUB_BROKER";

type Scope = { orgId: string; workspaceId: string };

/** A repository bound to the workspace, as its current binding names it. */
export interface GovernedRepository {
  owner: string;
  name: string;
  fullName: string;
  providerRepositoryId: string;
  role: "main" | "linked";
}

/**
 * The repository bound to this workspace at `owner/name`, or null. GitHub
 * treats owner and name case-insensitively, and so does git's remote URL, so
 * the match does too.
 */
export async function selectGovernedRepository(
  tx: Tx,
  scope: Scope,
  owner: string,
  name: string,
): Promise<GovernedRepository | null> {
  const [row] = await tx
    .select({
      owner: schema.repositoryBindings.providerOwner,
      name: schema.repositoryBindings.providerName,
      fullName: schema.repositoryBindings.providerFullName,
      providerRepositoryId: schema.repositoryBindingHeads.providerRepositoryId,
      role: schema.repositoryBindingHeads.role,
    })
    .from(schema.repositoryBindingHeads)
    .innerJoin(
      schema.repositoryBindings,
      eq(
        schema.repositoryBindings.id,
        schema.repositoryBindingHeads.currentBindingId,
      ),
    )
    .where(
      and(
        eq(schema.repositoryBindingHeads.orgId, scope.orgId),
        eq(schema.repositoryBindingHeads.workspaceId, scope.workspaceId),
        eq(schema.repositoryBindingHeads.provider, GITHUB_PROVIDER),
        sql`lower(${schema.repositoryBindings.providerOwner}) = lower(${owner})`,
        sql`lower(${schema.repositoryBindings.providerName}) = lower(${name})`,
      ),
    )
    .limit(1);
  if (!row) return null;
  return { ...row, role: row.role === "main" ? "main" : "linked" };
}

export interface GithubTokenIssueDeps {
  enabled(): boolean;
  governedRepository: typeof selectGovernedRepository;
  installation(scope: Scope): Promise<{ installationId: string } | null>;
  mint(args: {
    installationId: string;
    repositoryId: number;
  }): Promise<InstallationTokenResult>;
}

export const githubTokenIssueDeps: GithubTokenIssueDeps = {
  enabled: () => process.env[GITHUB_BROKER_ENV] === "1",
  governedRepository: selectGovernedRepository,
  installation: resolveWorkspaceGithubInstallation,
  async mint({ installationId, repositoryId }) {
    const appId = process.env["GITHUB_APP_ID"];
    const privateKey = process.env["GITHUB_APP_PRIVATE_KEY"];
    if (!appId || !privateKey) {
      throw new Error(
        "GitHub App is not configured: GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY unset",
      );
    }
    // Uncached on purpose: each run gets its own token, so revoking one run's
    // token never pulls the credential out from under another run.
    return createAppInstallationToken({
      appId,
      privateKey,
      installationId,
      repositoryIds: [repositoryId],
      permissions: { contents: "write", metadata: "read" },
    });
  },
};

export function createTachoGithubTokenIssueHandler(
  deps: GithubTokenIssueDeps,
): CapabilityHandler<typeof tachoGithubTokenIssue> {
  return async (input, ctx): Promise<TachoGithubTokenIssueOutput> => {
    if (!deps.enabled()) {
      throw new HandlerError({
        code: "forbidden",
        reason: "github_broker_disabled",
        message: `Brokered GitHub credentials are off on this deployment (${GITHUB_BROKER_ENV} is not 1)`,
      });
    }
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const repo = await withTenantDb(async (tx) => {
      const host = await resolveEnrolledHost(
        CAPABILITY,
        ctx,
        tx as never,
        input.host_enrollment_id,
      );
      if (host.status !== "active")
        throw new HandlerError({
          code: "forbidden",
          reason: "host_inactive",
          message: "The host must be active to use GitHub custody.",
        });
      return deps.governedRepository(tx, scope, input.owner, input.name);
    });
    if (!repo) {
      throw new HandlerError({
        code: "not_found",
        reason: "repository_not_governed",
        message: `${input.owner}/${input.name} is not bound to this workspace`,
      });
    }
    if (
      !/^[1-9]\d{0,15}$/.test(repo.providerRepositoryId) ||
      !Number.isSafeInteger(Number(repo.providerRepositoryId))
    ) {
      // The id goes into GitHub's mint body; a malformed stored value must
      // not reach it as something else.
      throw new HandlerError({
        code: "conflict",
        reason: "repository_id_invalid",
        message: `The binding for ${repo.fullName} carries no usable GitHub repository id`,
      });
    }
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ["Owner", "Admin"] },
    );
    const installation = await deps.installation(scope);
    if (!installation) {
      throw new HandlerError({
        code: "conflict",
        reason: "github_not_connected",
        message:
          "This workspace has no GitHub App installation attached; attach one from the Repositories page first",
      });
    }
    let minted: InstallationTokenResult;
    try {
      minted = await deps.mint({
        installationId: installation.installationId,
        repositoryId: Number(repo.providerRepositoryId),
      });
    } catch (err) {
      logger.error(
        { err, repository: repo.fullName },
        "GitHub refused the scoped token mint",
      );
      throw new HandlerError({
        code: "conflict",
        reason: "github_refused",
        message:
          "GitHub refused the scoped token. Check the workspace installation.",
      });
    }
    logger.info(
      {
        ...scope,
        host: input.host_enrollment_id,
        repository: repo.fullName,
        runTokenId: input.run_token_id ?? null,
      },
      "tacho.github_token.issue: minted",
    );
    return {
      token: minted.token,
      expires_at: new Date(minted.expiresAt).toISOString(),
      repository: {
        owner: repo.owner,
        name: repo.name,
        full_name: repo.fullName,
        role: repo.role,
      },
    };
  };
}

export const tachoGithubTokenIssueHandler =
  createTachoGithubTokenIssueHandler(githubTokenIssueDeps);
