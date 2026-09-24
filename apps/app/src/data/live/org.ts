// The organization port on the kernel (ARCHITECTURE.md §3.3): the members and
// pending invitations of the viewer's organization (list_members
// {scope:"org"}), its roles with the permission catalogue (list_iam_roles), its
// workspaces including the archived ones (list_workspaces) and the keys it
// holds (list_api_keys), each a noBillingGate read made with the organization
// viewer's context, and each refused by its handler for a viewer below the role
// it names.
//
// `apiKeys` is the exception to "made with the organization viewer's context":
// it takes a WsCtx, because an API key names a workspace (ADR-073).
// `auth.api_keys` is policy class `standard`, so under the org-only sentinel
// the list matches no key that exists and a mint writes one into a workspace
// that does not. The page picks a workspace and resolves into it first.
import "server-only";
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import { costCenterList } from "@oxagen/oxagen/contracts/cost_center.list";
import { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
import { orgDataPlaneGet } from "@oxagen/oxagen/contracts/org.data_plane.get";
import { orgModelCredentialGet } from "@oxagen/oxagen/contracts/org.model_credential.get";
import { orgSsoList } from "@oxagen/oxagen/contracts/org.sso.list";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  ApiKeyList,
  CostCenterList,
  DataPlane,
  MemberList,
  ModelCredential,
  RoleCatalog,
  SsoSettings,
  WorkspaceList,
} from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toApiKeys,
  toCostCenterList,
  toDataPlane,
  toMemberList,
  toModelCredential,
  toRoleCatalog,
  toSsoSettings,
  toWorkspaceList,
} from "./mappers/org";

/** The mapped value parsed at the boundary; a record the view refuses is `record_unmappable`, reported once. */
function view<S extends z.ZodType>(
  orgId: string,
  schema: S,
  mapped: z.input<S>,
  read: string,
): Read<z.output<S>> {
  const parsed = schema.safeParse(mapped);
  if (parsed.success) return readOk(parsed.data);
  captureError({
    error: parsed.error,
    source: "app",
    orgId,
    context: `${read} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

/** The largest page `list_iam_roles` allows, so the walk below is the shortest one. */
const ROLE_PAGE = 200;
/**
 * A stop on the walk. 40 pages is 8,000 roles — orders of magnitude past any
 * real permission model — so reaching it means the contract stopped clearing
 * `hasMore`, and looping for ever on a server render is worse than showing the
 * catalogue up to here.
 */
const ROLE_PAGE_CEILING = 40;

export const org: DataSource["org"] = {
  async members(ctx) {
    const read = await kernelRead(ctx, {
      contract: listMembers,
      input: { scope: "org" },
      page: "organization",
    });
    if (!read.ok) return read;
    // The contract answers a scope union; only the org branch is a roster.
    if (read.value.scope !== "org") {
      captureError({
        error: new Error("list_members answered workspace scope"),
        source: "app",
        orgId: ctx.orgId,
        context: "org.members record_unmappable",
      });
      return readError("record_unmappable", 502);
    }
    return view(ctx.orgId, MemberList, toMemberList(read.value), "org.members");
  },

  async roles(ctx) {
    // `list_iam_roles` pages, and the read used to send neither bound — so it
    // took the contract's 100 default and the mapper dropped `total` and
    // `hasMore` with it. The Roles section has no paging control and is not
    // meant to have one: it is the organization's whole catalogue, and a role
    // past the first page is a role nobody can see, edit or delete. So the
    // read asks for the largest page the contract allows and walks the rest,
    // and the section is handed every role there is.
    const first = await kernelRead(ctx, {
      contract: iamRoleList,
      input: { includeGrants: true, limit: ROLE_PAGE, offset: 0 },
      page: "organization",
    });
    if (!first.ok) return first;
    const roles = [...first.value.roles];
    let hasMore = first.value.hasMore;
    // `catalog` and `enforcement` are properties of the organization, not of
    // the page, so the first page's are the whole read's.
    for (let page = 1; hasMore && page < ROLE_PAGE_CEILING; page += 1) {
      // Serial by necessity: a page's offset is the previous page's, and
      // `total` is known only from a page, so there is nothing to fan out.
      const next = await kernelRead(ctx, {
        contract: iamRoleList,
        input: {
          includeGrants: true,
          limit: ROLE_PAGE,
          offset: page * ROLE_PAGE,
        },
        page: "organization",
      });
      if (!next.ok) return next;
      roles.push(...next.value.roles);
      hasMore = next.value.hasMore;
    }
    return view(
      ctx.orgId,
      RoleCatalog,
      toRoleCatalog({ ...first.value, roles }),
      "org.roles",
    );
  },

  async workspaces(ctx) {
    const read = await kernelRead(ctx, {
      contract: workspaceList,
      input: { orgSlug: ctx.orgSlug, includeArchived: true },
      page: "organization",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      WorkspaceList,
      toWorkspaceList(read.value),
      "org.workspaces",
    );
  },

  async costCenters(ctx) {
    const read = await kernelRead(ctx, {
      contract: costCenterList,
      input: {},
      page: "organization",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      CostCenterList,
      toCostCenterList(read.value),
      "org.costCenters",
    );
  },

  async apiKeys(ctx) {
    const read = await kernelRead(ctx, {
      contract: apiKeyList,
      input: {},
      page: "organization",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, ApiKeyList, toApiKeys(read.value), "org.apiKeys");
  },

  // The organisation's own model key: org-scoped (the credential pays for
  // every workspace's assistant turns), Owner-or-Admin in its handler.
  async modelCredential(ctx) {
    const read = await kernelRead(ctx, {
      contract: orgModelCredentialGet,
      input: {},
      page: "organization",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      ModelCredential,
      toModelCredential(read.value),
      "org.modelCredential",
    );
  },

  // Where the organisation's Postgres data lives (ADR-042): org-scoped,
  // Owner-or-Admin in its contract, redacted by the contract. The Data plane
  // tab reads the Postgres binding because it is the one every tenant table
  // sits on; the graph and event stores follow the same binding rules.
  async dataPlane(ctx) {
    const read = await kernelRead(ctx, {
      contract: orgDataPlaneGet,
      input: { kind: "postgres" },
      page: "organization",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, DataPlane, toDataPlane(read.value), "org.dataPlane");
  },

  // The organisation's identity providers and its SSO policy (ADR-145):
  // org-scoped, Owner-or-Admin in its handler, no secret in the answer.
  async sso(ctx) {
    const read = await kernelRead(ctx, {
      contract: orgSsoList,
      input: {},
      page: "organization",
    });
    if (!read.ok) return read;
    return view(ctx.orgId, SsoSettings, toSsoSettings(read.value), "org.sso");
  },
};
