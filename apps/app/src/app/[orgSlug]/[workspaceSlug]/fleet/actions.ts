"use server";

/**
 * actions.ts — the Fleet screen's one read: every machine enrolled in this
 * workspace, with the enforcement tier each of its apps reaches (ADR-069).
 *
 * Same shape as the other app-side capability calls:
 *   1. getSessionOrRedirect()  — session guard
 *   2. resolveOrg / resolveWorkspace — IDOR + slug resolution
 *   3. assertOrgMember()       — apps/app does NOT bootstrap IAM and invoke()
 *      skips role checks, so the gate is explicit at the call site
 *   4. invoke() with surface "api" — `list_tacho_hosts` declares
 *      surfaces ["api", "mcp"], so "app" would throw surface_denied
 */

import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { tachoHostList } from "@oxagen/oxagen/contracts/tacho.host.list";
import type { TachoHostListOutput } from "@oxagen/oxagen/contracts/tacho.host.list";
import { logger } from "@oxagen/handlers/logger";
import { getSessionOrRedirect } from "@/lib/session";
import {
  assertOrgMember,
  resolveOrg,
  resolveWorkspace,
} from "@/lib/resolve-org";

export type FleetHost = TachoHostListOutput["hosts"][number];

export type ListFleetResult =
  | { ok: true; hosts: FleetHost[]; nextCursor: string | null }
  | { ok: false; error: string };

export async function listFleetAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  status?: FleetHost["status"];
  cursor?: string;
}): Promise<ListFleetResult> {
  try {
    const session = await getSessionOrRedirect();
    const org = await resolveOrg(input.orgSlug);
    await assertOrgMember(org.id, session.user.id);
    const workspace = await resolveWorkspace(org.id, input.workspaceSlug);

    const output = (await runInTenantScope(
      {
        orgId: org.id,
        workspaceId: workspace.id,
        userId: session.user.id,
        capabilityName: tachoHostList.name,
      },
      () =>
        invoke(
          tachoHostList.name,
          {
            limit: 50,
            ...(input.status ? { status: input.status } : {}),
            ...(input.cursor ? { cursor: input.cursor } : {}),
          },
          {
            orgId: org.id,
            workspaceId: workspace.id,
            userId: session.user.id,
            apiKeyId: null,
            requestId: crypto.randomUUID(),
            surface: "app",
            messageId: null,
          },
          { surface: "api" },
        ),
    )) as TachoHostListOutput;

    return { ok: true, hosts: output.hosts, nextCursor: output.nextCursor };
  } catch (error) {
    logger.error(
      { err: error, orgSlug: input.orgSlug },
      "fleet: list_tacho_hosts failed",
    );
    return {
      ok: false,
      error:
        error instanceof Error ? error.message : "Could not load the fleet",
    };
  }
}
