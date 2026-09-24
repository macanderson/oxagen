"use server";
// The register gate's own reads and writes beside the onboarding actions
// (register-name, register-wrap and register-run specs), each through the
// kernel seam for the viewer the URL names.
//
// `readRegisterPlace` is a read made at render: the name step needs the
// namespaces the agent key is built from and the workspace's main repository,
// and neither is on a DataSource port. It resolves its own viewer, exactly as a
// write does (INV-19), so a page that calls it adds no route of its own.
//
// Cancel retires the identity the name step minted (`retire_agent`), which is
// the one write that leaves nothing live behind: the credential, every host
// enrollment and every mandate are revoked with it, and the record stays so
// the audit trail keeps its subject. The SDK tab's credential is issued by
// `rotate_agent_credential`, because the one `register_agent` returned was
// never shown. Every contract here admits an organization Owner or Admin,
// checked in its handler (INV-29).
import { agentCredentialRotate } from "@oxagen/oxagen/contracts/agent.credential.rotate";
import { agentRetire } from "@oxagen/oxagen/contracts/agent.retire";
import { repositoryMainGet } from "@oxagen/oxagen/contracts/repository.main.get";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";

export type RegisterPlace = {
  /** `org_ns.ws_ns`, the first two segments of every agent key in this workspace. */
  keyPrefix: string;
  /** The main repository as `owner/name`; null while the workspace binds none. */
  repository: string | null;
};

/** The agent key's namespaces and the main repository, for the name step's hints. */
export async function readRegisterPlace(
  org: string,
  ws: string,
): Promise<ActionResult<RegisterPlace>> {
  const ctx = await requireViewer(org, ws);
  const [workspaces, main] = await Promise.all([
    kernelRead(ctx, {
      contract: workspaceList,
      input: { orgSlug: ctx.orgSlug, includeArchived: false },
      page: "onboarding",
    }),
    kernelRead(ctx, {
      contract: repositoryMainGet,
      input: {},
      page: "onboarding",
    }),
  ]);
  const listed = readToActionResult(workspaces);
  if (!listed.ok) return listed;
  const bound = readToActionResult(main);
  if (!bound.ok) return bound;
  const workspace = listed.value.workspaces.find(
    (row) => row.slug === ctx.wsSlug,
  );
  if (workspace === undefined)
    return { ok: false, reason: "not_found", code: "workspace_not_found" };
  return {
    ok: true,
    value: {
      keyPrefix: `${listed.value.organization.namespace}.${workspace.namespace}`,
      repository: bound.value.repository?.fullName ?? null,
    },
  };
}

/** Retires the identity this registration minted and answers where Cancel lands. */
export async function cancelRegistration(
  org: string,
  ws: string,
  agentId: string,
): Promise<ActionResult<{ to: SafePath }>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentRetire, {
    agentId,
    reason: "Registration cancelled before the first frame opened it.",
  });
  return result.ok
    ? { ok: true, value: { to: routes.fleet(ctx.orgSlug, ctx.wsSlug) } }
    : result;
}

type IssuedCredential = {
  /** Shown once and never recoverable. */
  secret: string;
  expiresAt: string;
};

/** Mints the agent's long-lived credential for the SDK path, retiring the one before it. */
export async function issueAgentCredential(
  org: string,
  ws: string,
  agentId: string,
): Promise<ActionResult<IssuedCredential>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, agentCredentialRotate, { agentId });
  return result.ok
    ? {
        ok: true,
        value: {
          secret: result.value.credential.secret,
          expiresAt: result.value.credential.expiresAt,
        },
      }
    : result;
}
