"use server";
import { runOutcomesSettingsSet } from "@oxagen/oxagen/contracts/run.outcomes.settings.set";
import type { RunOutcomesPolicy } from "@oxagen/oxagen/run-outcomes";
import { kernelWrite, type ActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export async function setRunOutcomesConsentAction(
  at: { org: string; ws: string },
  customerEnabled: boolean,
): Promise<ActionResult<RunOutcomesPolicy>> {
  const ctx = await requireViewer(at.org, at.ws);
  return kernelWrite(ctx, runOutcomesSettingsSet, { customerEnabled });
}
