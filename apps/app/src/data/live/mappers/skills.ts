// `list_skills` output to the Skills page's view model (ARCHITECTURE.md §3.4).
// Typed from the contract's `_output`, so a field the contract may leave null
// cannot land in a required view field. Every figure is copied as the handler
// counted it; nothing here fills a count the record did not carry.
import type { skillList } from "@oxagen/oxagen/contracts/skill.list";
import type { z } from "zod";
import type { SkillInventory } from "@/data/contracts/skills";
import type { ContractOutput } from "@/server/kernel";

export function toSkillInventory(
  out: ContractOutput<typeof skillList>,
): z.input<typeof SkillInventory> {
  return {
    window: { from: out.window.from, to: out.window.to },
    sessions: out.sessions,
    reportedSessions: out.reportedSessions,
    notReportedSessions: out.notReportedSessions,
    skills: out.skills.map((skill) => ({
      name: skill.name,
      sessions: skill.sessions,
      harnesses: skill.harnesses,
      harnessCount: skill.harnessCount,
      lastSeenAt: skill.lastSeenAt,
    })),
    nextCursor: out.nextCursor,
  };
}
