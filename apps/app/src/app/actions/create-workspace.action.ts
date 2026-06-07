"use server";

import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg } from "@/lib/resolve-org";
import { createWorkspaceAction } from "@/app/[orgSlug]/new-workspace/actions";

export interface CreateWorkspaceInlineInput {
  orgSlug: string;
  workspaceSlug: string;
  name: string;
  slug: string;
}

export type CreateWorkspaceInlineResult =
  | { ok: true; workspaceSlug: string }
  | { ok: false; error: string };

export async function createWorkspaceInlineAction(
  input: CreateWorkspaceInlineInput,
): Promise<CreateWorkspaceInlineResult> {
  try {
    await getSessionOrRedirect();
    await resolveOrg(input.orgSlug);
  } catch {
    return { ok: false, error: "Not authenticated or org not found." };
  }

  const fd = new FormData();
  fd.set("name", input.name);
  fd.set("slug", input.slug);

  return createWorkspaceAction(input.orgSlug, fd);
}
