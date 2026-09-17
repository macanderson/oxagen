"use server";
import type { ActionResult } from "@/server/kernel";
import { requireUser } from "@/server/viewer";

export async function pick(input: {
  workspaceId: string;
}): Promise<ActionResult<string>> {
  await requireUser();
  return { ok: true, value: input.workspaceId };
}
