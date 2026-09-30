// The skills port on the kernel (ARCHITECTURE.md §3.3; #3098): one page of the
// skill names this workspace's harness sessions reported at start
// (`list_skills`, a noBillingGate read). A refusal passes through as the
// kernel classified it; an answer the view model refuses is reported once as
// record_unmappable.
import "server-only";
import { skillConfigGet } from "@oxagen/oxagen/contracts/skill.config.get";
import { skillList } from "@oxagen/oxagen/contracts/skill.list";
import { captureError } from "@oxagen/telemetry";
import {
  SKILL_PAGE,
  SkillInventory,
  SkillConfiguration,
} from "@/data/contracts/skills";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toSkillInventory } from "./mappers/skills";

export const skills: DataSource["skills"] = {
  async configuration(ctx) {
    const read = await kernelRead(ctx, {
      contract: skillConfigGet,
      input: {},
      page: "skills",
    });
    if (!read.ok) return read;
    const parsed = SkillConfiguration.safeParse(read.value);
    if (parsed.success) return readOk(parsed.data);
    captureError({
      error: parsed.error,
      source: "app",
      orgId: ctx.orgId,
      context: "skills.configuration record_unmappable",
    });
    return readError("record_unmappable", 502);
  },
  async inventory(ctx, q) {
    const read = await kernelRead(ctx, {
      contract: skillList,
      // The default size stays off the input, so a default read is the one
      // list_skills answered before it took a size (#4693).
      input: {
        ...(q.cursor === null ? {} : { cursor: q.cursor }),
        ...(q.limit === undefined || q.limit === SKILL_PAGE
          ? {}
          : { limit: q.limit }),
      },
      page: "skills",
    });
    if (!read.ok) return read;
    const parsed = SkillInventory.safeParse(toSkillInventory(read.value));
    if (parsed.success) return readOk(parsed.data);
    captureError({
      error: parsed.error,
      source: "app",
      orgId: ctx.orgId,
      context: "skills.inventory record_unmappable",
    });
    return readError("record_unmappable", 502);
  },
};
