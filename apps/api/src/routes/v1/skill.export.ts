import { Hono } from "hono";
import { skillExport } from "@oxagen/oxagen/contracts/skill.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillExportRoute = new Hono<AppEnv>();

skillExportRoute.get("/", async (c) => {
  const skillId = c.req.query("skillId");
  const versionNumberRaw = c.req.query("versionNumber");
  const versionNumber =
    versionNumberRaw !== undefined ? Number(versionNumberRaw) : undefined;

  const input = skillExport.input.parse({ skillId, versionNumber });
  const ctx = capabilityContext(c);
  const out = await invoke(skillExport.name, input, ctx, { surface: "api" });
  const parsed = skillExport.output.parse(out);

  return c.body(parsed.content, 200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": `attachment; filename="${parsed.filename}"`,
    "X-Skill-Version": String(parsed.versionNumber),
  });
});
