"use server";
import { runOutcomesSettingsSet } from "@oxagen/oxagen/contracts/run.outcomes.settings.set";
import type { RunOutcomesPolicy } from "@/data/contracts/run-work";
import { kernelWrite } from "@/server/kernel";
import type { ActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export async function setRunOutcomesConsentAction(
  at: { org: string; ws: string },
  customerEnabled: boolean,
): Promise<ActionResult<RunOutcomesPolicy>> {
  const ctx = await requireViewer(at.org, at.ws);
  return kernelWrite(ctx, runOutcomesSettingsSet, { customerEnabled });
}
