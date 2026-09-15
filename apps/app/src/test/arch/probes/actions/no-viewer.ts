"use server";
import type { ActionResult } from "@/server/kernel";

export async function ping(): Promise<ActionResult<null>> {
  return { ok: true, value: null };
}
