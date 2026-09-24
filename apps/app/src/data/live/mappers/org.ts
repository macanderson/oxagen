// The Organization contract outputs to their view models (ARCHITECTURE.md
// §3.4): list_members {scope:"org"} to People, narrowed to the org branch of
// its scope union (the adapter answers the workspace branch as unmappable);
// list_iam_roles to the role and permission catalogue, folded to the
// vocabulary the editor speaks; list_workspaces to the Workspaces section;
// list_cost_centers to the Cost centers section; and
// list_api_keys to the keys the organization holds. Each carries the public id
// so no database uuid reaches the page (INV-11), and each is typed from the
// contract's `_output`, so a nullable contract field cannot land in a required
// view field.
import type { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import type { costCenterList } from "@oxagen/oxagen/contracts/cost_center.list";
import type { agentList } from "@oxagen/oxagen/contracts/agent.list";
import type { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
import type { orgDataPlaneGet } from "@oxagen/oxagen/contracts/org.data_plane.get";
import type { orgModelCredentialGet } from "@oxagen/oxagen/contracts/org.model_credential.get";
import type { orgSsoList } from "@oxagen/oxagen/contracts/org.sso.list";
import type { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import type { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import type { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import type { z } from "zod";
import type {
  ApiKeyList,
  CostCenterList,
  DataPlane,
  MemberList,
  ModelCredential,
  RoleCatalog,
  SsoSettings,
  WorkspaceFacts,
  WorkspaceList,
} from "@/data/contracts/org";
import type { ContractOutput } from "@/server/kernel";

type OrgRoster = Extract<ContractOutput<typeof listMembers>, { scope: "org" }>;

export function toMemberList(out: OrgRoster): z.input<typeof MemberList> {
  return {
    members: out.members.map((member) => ({
      id: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
      joinedAt: member.joinedAt,
    })),
    invitations: out.invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      invitedAt: invitation.invitedAt,
      expiresAt: invitation.expiresAt,
    })),
  };
}

/**
 * A role's capability grants are already folded into catalogue permissions by
 * the read (ADR-063), so the view carries the permissions and drops the
 * per-capability grant rows: the editor speaks the catalogue, and a grant a
 * permission does not cover has no control to change it.
 */
export function toRoleCatalog(
  out: ContractOutput<typeof iamRoleList>,
): z.input<typeof RoleCatalog> {
  return {
    roles: out.roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      scope: role.scopeKind,
      kind: role.kind,
      builtIn: role.isSystemDefault,
      permissions: role.permissions,
      heldBy: role.memberCount,
      createdBy: role.createdBy,
      createdAt: role.createdAt,
    })),
    catalog: out.catalog.map((entry) => ({
      permission: entry.id,
      group: entry.group,
      description: entry.description,
      capabilities: entry.capabilities,
    })),
    enforcement: {
      tier: out.enforcement.tier,
      enforced: out.enforcement.enforced,
    },
  };
}

export function toWorkspaceList(
  out: ContractOutput<typeof workspaceList>,
): z.input<typeof WorkspaceList> {
  return {
    orgId: out.organization.publicId,
    workspaces: out.workspaces.map((workspace) => ({
      id: workspace.publicId,
      slug: workspace.slug,
      namespace: workspace.namespace,
      name: workspace.name,
      role: workspace.role,
      archivedAt: workspace.archivedAt,
      costCenter: workspace.costCenter,
    })),
  };
}

/**
 * list_repositories and list_agents, read inside one workspace, to its
 * Workspaces row: each binding's role, full name and approved production ref,
 * and the identity total over the whole workspace (never the page length).
 */
/**
 * The built-in interactive agent every workspace is seeded with
 * (`INTERACTIVE_AGENT_SLUG`, packages/oxagen/src/interactive-agent.ts).
 * `archive_workspace` leaves it out of the agents it refuses over. It is
 * spelled here rather than imported, because that module carries the agent's
 * whole definition and node:crypto, and the app's import graph admits neither.
 */
const INTERACTIVE_AGENT_SLUG = "qa-chat";

export function toWorkspaceFacts(
  repositories: ContractOutput<typeof repositoryList>,
  agents: ContractOutput<typeof agentList>,
): z.input<typeof WorkspaceFacts> {
  return {
    repositories: repositories.repositories.map((repo) => ({
      role: repo.role,
      fullName: repo.fullName,
      defaultRef: repo.defaultRef,
    })),
    agents: agents.totals.identities,
    archiveBlockers: {
      count: agents.items.filter(
        (agent) =>
          agent.slug !== INTERACTIVE_AGENT_SLUG && agent.status !== "retired",
      ).length,
      more: agents.nextCursor !== null,
    },
  };
}

/** list_cost_centers to the Cost centers section; the public id is the only id it carries. */
export function toCostCenterList(
  out: ContractOutput<typeof costCenterList>,
): z.input<typeof CostCenterList> {
  return {
    costCenters: out.costCenters.map((center) => ({
      id: center.id,
      label: center.label,
      description: center.description,
      agents: center.agents,
      workspaces: center.workspaces,
    })),
  };
}

/**
 * The key's public id is the only id the view carries (INV-11). Every field is
 * named here, so a field the contract gains later — a secret among them —
 * reaches the page only when this mapper is changed to copy it.
 */
export function toApiKeys(
  out: ContractOutput<typeof apiKeyList>,
): z.input<typeof ApiKeyList> {
  return out.items.map((key) => ({
    id: key.publicId,
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    rotatable: key.rotatable,
  }));
}

/**
 * `get_model_credential` onto the page's view model. Field for field: the
 * contract already returns the redacted shape the page shows, and no key.
 */
export function toModelCredential(
  out: ContractOutput<typeof orgModelCredentialGet>,
): z.input<typeof ModelCredential> {
  return {
    configured: out.configured,
    provider: out.provider,
    status: out.status,
    keyHint: out.keyHint,
    baseUrl: out.baseUrl,
    modelMap: out.modelMap,
    lastVerifiedAt: out.lastVerifiedAt,
    rotatedAt: out.rotatedAt,
  };
}

/**
 * `list_sso_providers` onto the Single sign-on page's view model. The OIDC
 * scopes and the timestamps stay behind: the page shows neither. Nothing here
 * can carry a secret, because the contract returns none.
 */
export function toSsoSettings(
  out: ContractOutput<typeof orgSsoList>,
): z.input<typeof SsoSettings> {
  return {
    providers: out.providers.map((provider) => ({
      providerRef: provider.providerId,
      displayName: provider.displayName,
      protocol: provider.protocol,
      domain: provider.domain,
      domainVerified: provider.domainVerified,
      issuer: provider.issuer,
      groupsClaim: provider.groupsClaim,
      verification: {
        recordName: provider.domainVerification.recordName,
        recordValue: provider.domainVerification.recordValue,
      },
      callbackUrl: provider.callbackUrl,
      spMetadataUrl: provider.spMetadataUrl,
      oidc:
        provider.oidc === null
          ? null
          : {
              clientRef: provider.oidc.clientId,
              clientSecretSet: provider.oidc.clientSecretSet,
            },
      saml:
        provider.saml === null
          ? null
          : {
              entryPoint: provider.saml.entryPoint,
              spPrivateKeySet: provider.saml.spPrivateKeySet,
            },
      groupRoles: provider.groupRoles.map((m) => ({
        group: m.group,
        role: m.role,
      })),
    })),
    policy: { ssoRequired: out.policy.ssoRequired },
    entitled: out.entitled,
    scim: {
      baseUrl: out.scim.baseUrl,
      token:
        out.scim.token === null
          ? null
          : {
              prefix: out.scim.token.tokenPrefix,
              createdAt: out.scim.token.createdAt,
              lastUsedAt: out.scim.token.lastUsedAt,
            },
    },
  };
}

/**
 * `get_data_plane` onto the Data plane tab. The binding is already redacted
 * by the contract (ADR-042 §4), and every field is named here, so nothing the
 * contract gains later reaches the page unless this mapper copies it.
 */
export function toDataPlane(
  out: ContractOutput<typeof orgDataPlaneGet>,
): z.input<typeof DataPlane> {
  return {
    mode: out.mode,
    status: out.status,
    host: out.host,
    database: out.database,
    schemaVersion: out.schemaVersion,
    lastVerifiedAt: out.lastVerifiedAt,
    rotatedAt: out.rotatedAt,
  };
}
