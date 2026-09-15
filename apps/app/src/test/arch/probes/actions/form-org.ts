"use server";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export async function revokeKey(form: FormData): Promise<ActionResult<null>> {
  const ctx = await requireViewer("acme");
  return kernelWrite(ctx, apiKeyRevoke, {
    orgId: String(form.get("orgId")),
    keyId: String(form.get("key_id")),
  });
}
