// repository.list.ts — `list_repositories` (Mission Control spec §10.1).
//
// Every binding head in this workspace joined to the binding version it points
// at, and left-joined to its connection so a retired connection reads as
// `connectionLive: false` instead of dropping the repository from the list —
// the same judgement `get_main_repository` makes, through the same predicate.
// No GitHub call: a settings read renders while GitHub is down. The role gate
// runs first: org Owner or Admin, or workspace Owner or Member, as the
// contract declares.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  repositoryList,
  type RepositoryListOutput,
} from "@oxagen/oxagen/contracts/repository.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, sql } from "drizzle-orm";
import { assertContractRole } from "./lib/capability-role-guard";
import { isLiveConnectionRow } from "./repository.github-connection";
import { gitlabDeliveryConfigOf } from "./repository.gitlab-connection";

type EventDelivery = RepositoryListOutput["repositories"][number]["events"];

/**
 * Whether GitHub can deliver this repository's events, from the connection
 * row and the installation registry row the list joined. Ordered by what a
 * person has to do about it: a retired connection needs a re-bind, an
 * uninstalled or suspended App needs GitHub, a paused connection needs a
 * resume.
 */
export function eventDelivery(row: {
  provider?: string;
  deliveryConfig?: unknown;
  connectionLive: boolean;
  connectionStatus: string | null;
  installationRowId: string | null;
  installationSuspendedAt: Date | null;
  installationDeletedAt: Date | null;
}): EventDelivery {
  if (!row.connectionLive) return "retired";
  if (row.provider === "gitlab") {
    // No App installation: the project webhook `attach_gitlab_project`
    // registered is what delivers events.
    if (row.connectionStatus === "paused") return "paused";
    return gitlabDeliveryConfigOf(row.deliveryConfig)?.webhookId != null
      ? "installed"
      : "unknown";
  }
  if (row.installationRowId === null) return "unknown";
  if (row.installationDeletedAt !== null) return "uninstalled";
  if (row.installationSuspendedAt !== null) return "suspended";
  if (row.connectionStatus === "paused") return "paused";
  return "installed";
}

export const repositoryListHandler: CapabilityHandler<
  typeof repositoryList
> = async (_input, ctx): Promise<RepositoryListOutput> => {
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #3340). A
  // workspace Viewer or an org Billing member would otherwise read every
  // private repository name, binding id, and approved ref.
  await assertContractRole(repositoryList, ctx);
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        bindingId: schema.repositoryBindings.publicId,
        role: schema.repositoryBindingHeads.role,
        provider: schema.repositoryBindings.provider,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
        owner: schema.repositoryBindings.providerOwner,
        name: schema.repositoryBindings.providerName,
        fullName: schema.repositoryBindings.providerFullName,
        defaultRef: schema.repositoryBindings.configuredDefaultRef,
        boundAt: schema.repositoryBindingHeads.createdAt,
        connectionStatus: schema.sourceConnections.status,
        connectionDeletedAt: schema.sourceConnections.deletedAt,
        installationRowId: schema.githubInstallations.id,
        installationSuspendedAt: schema.githubInstallations.suspendedAt,
        installationDeletedAt: schema.githubInstallations.deletedAt,
      })
      .from(schema.repositoryBindingHeads)
      .innerJoin(
        schema.repositoryBindings,
        eq(
          schema.repositoryBindings.id,
          schema.repositoryBindingHeads.currentBindingId,
        ),
      )
      .leftJoin(
        schema.sourceConnections,
        eq(
          schema.sourceConnections.id,
          schema.repositoryBindingHeads.connectionId,
        ),
      )
      // The installation registry is a shared catalog keyed by GitHub's
      // installation id, which the connection carries in its delivery config.
      .leftJoin(
        schema.githubInstallations,
        eq(
          schema.githubInstallations.installationId,
          sql`${schema.sourceConnections.deliveryConfig} ->> 'installationId'`,
        ),
      )
      .where(
        and(
          eq(schema.repositoryBindingHeads.orgId, ctx.orgId),
          eq(schema.repositoryBindingHeads.workspaceId, ctx.workspaceId),
        ),
      ),
  );

  const repositories = rows
    .map((r) => {
      const connectionLive = isLiveConnectionRow({
        status: r.connectionStatus,
        deletedAt: r.connectionDeletedAt,
      });
      return {
        bindingId: r.bindingId,
        // The contract still names the steering head "main". A `steering`
        // head (S1 binds every new steering repo with that role) is the same
        // head under its new name, and passing it through unmapped made the
        // output parse refuse the whole list for that workspace.
        role: r.role === "linked" ? ("linked" as const) : ("main" as const),
        provider:
          r.provider === "gitlab" ? ("gitlab" as const) : ("github" as const),
        owner: r.owner,
        name: r.name,
        fullName: r.fullName,
        defaultRef: r.defaultRef,
        htmlUrl:
          r.provider === "gitlab"
            ? `https://gitlab.com/${r.fullName}`
            : `https://github.com/${r.fullName}`,
        boundAt: r.boundAt.toISOString(),
        connectionLive,
        events: eventDelivery({ ...r, connectionLive }),
      };
    })
    .sort((a, b) =>
      a.role === b.role
        ? a.fullName.localeCompare(b.fullName)
        : a.role === "main"
          ? -1
          : 1,
    );

  return { repositories };
};
