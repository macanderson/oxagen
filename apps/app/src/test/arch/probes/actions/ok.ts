"use server";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";
import { redirectTo } from "@/shared/navigation";

async function viewerFor(form: FormData) {
  return requireViewer(String(form.get("org_slug")));
}

export async function revokeKey(form: FormData): Promise<ActionResult<null>> {
  const ctx = await viewerFor(form);
  return kernelWrite(ctx, apiKeyRevoke, { keyId: String(form.get("key_id")) });
}

export const leave = async (): Promise<never> => {
  await requireViewer("acme");
  return redirectTo(routes.root());
};

export type RevokeState = ActionResult<null> | null;
