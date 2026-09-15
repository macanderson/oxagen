"use server";
import type { ActionResult } from "@/server/kernel";
import { requireUser } from "@/server/viewer";

export async function pick({
  orgId,
}: {
  orgId: string;
}): Promise<ActionResult<string>> {
  await requireUser();
  return { ok: true, value: orgId };
}
