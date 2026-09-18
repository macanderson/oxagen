/**
 * `list_skills`: the skills the harness sessions of this workspace reported
 * when they started, over a window of session start times (#3098).
 *
 * The record is `tacho.sessions.skills_available`, the name list a wrapped
 * harness reports at session start. This read says which skills the harness
 * actually had, and nothing more: the row carries names only, so the output
 * carries no version, digest, source, token cost or decision.
 *
 * That is a different question from which skills the workspace's config let
 * the agent find. Oxagen governs that — skill *resolution* (ADR-090) — and
 * still never runs a skill (ADR-043). Resolution is read through the
 * `skills.*` capabilities over `.oxagen/skills.toml`; this contract is not
 * one of them and is not the place to add version, digest or decision.
 *
 * A session whose inventory is null did not report one; it counts toward
 * `notReportedSessions` and never as a session with no skills.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/** The longest window a read may ask for, in days. */
export const SKILL_WINDOW_DAYS_MAX = 90;
/** The window a read gets when it names none, in days. */
export const SKILL_WINDOW_DAYS_DEFAULT = 30;
/** Skill names per page. */
export const SKILL_PAGE_SIZE = 100;
/**
 * The longest cursor a read may carry. A cursor base64url-encodes JSON holding
 * the window's two instants and a skill name of up to 512 UTF-16 units; a name
 * whose every unit JSON-escapes to `\uXXXX` is 3072 bytes, so the encoding tops
 * out near 4.2k characters. The bound therefore admits every cursor the handler
 * can write — a smaller one would reject the handler's own next page.
 */
export const SKILL_CURSOR_MAX = 8192;

export const skillInventoryRowSchema = z
  .object({
    /** The name as the harness reported it. */
    name: z.string().min(1).max(512),
    /** Sessions in the window whose inventory named this skill. */
    sessions: z.number().int().positive(),
    /** The harnesses of those sessions, sorted, each once. */
    harnesses: z.array(z.string().min(1)).min(1),
    /** The earliest and latest start of those sessions (RFC 3339). */
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
  })
  .strict();

export const skillList = registerCapability({
  name: "list_skills",
  domain: "skill",
  description:
    "List the skills this workspace's harness sessions reported when they started, over a window of session start times: each name with the sessions that reported it, their harnesses and when it was first and last seen, plus the window's session count and how many sessions reported no inventory.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      /** Sessions started in the last N days; default 30. */
      windowDays: z
        .number()
        .int()
        .min(1)
        .max(SKILL_WINDOW_DAYS_MAX)
        .default(SKILL_WINDOW_DAYS_DEFAULT),
      /** The `nextCursor` of the previous page; it carries that page's window. */
      cursor: z.string().min(1).max(SKILL_CURSOR_MAX).optional(),
    })
    .strict(),
  output: z
    .object({
      /** Sessions started at or after `from` and before `to` (RFC 3339). */
      window: z
        .object({
          from: z.string().datetime(),
          to: z.string().datetime(),
        })
        .strict(),
      /** Sessions started in the window. */
      sessions: z.number().int().nonnegative(),
      /** Sessions in the window that reported an inventory; null when none did. */
      reportedSessions: z.number().int().positive().nullable(),
      /** Sessions in the window whose inventory is null. */
      notReportedSessions: z.number().int().nonnegative(),
      /** One row per reported name, by name. */
      skills: z.array(skillInventoryRowSchema).max(SKILL_PAGE_SIZE),
      nextCursor: z.string().nullable(),
    })
    .strict(),
});

export type SkillListInput = z.output<typeof skillList.input>;
export type SkillListOutput = z.output<typeof skillList.output>;
export type SkillInventoryRow = z.output<typeof skillInventoryRowSchema>;
