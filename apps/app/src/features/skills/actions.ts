"use server";

import { skillConfigUpdate } from "@oxagen/oxagen/contracts/skill.config.update";
import { skillSearchPreview } from "@oxagen/oxagen/contracts/skill.search.preview";
import type {
  SkillConfigChange,
  SkillSearchPreview,
} from "@/data/contracts/skills";
import type { ActionResult } from "@/server/kernel";
import { kernelRead, kernelWrite, readToActionResult } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export async function previewSkillSearch(
  org: string,
  ws: string,
  version: string,
  query: string,
): Promise<ActionResult<SkillSearchPreview>> {
  const ctx = await requireViewer(org, ws);
  return readToActionResult(
    await kernelRead(ctx, {
      contract: skillSearchPreview,
      input: { version, query },
      page: "skills",
    }),
  );
}

export async function proposeSkillConfig(
  org: string,
  ws: string,
  text: string,
): Promise<ActionResult<SkillConfigChange>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, skillConfigUpdate, { action: "propose", text });
}

export async function publishSkillConfig(
  org: string,
  ws: string,
  pullRequestNumber: number,
): Promise<ActionResult<SkillConfigChange>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, skillConfigUpdate, {
    action: "publish",
    pullRequestNumber,
  });
}

export async function importSkillConfig(
  org: string,
  ws: string,
): Promise<ActionResult<SkillConfigChange>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, skillConfigUpdate, { action: "import" });
}
