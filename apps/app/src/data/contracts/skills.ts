// The Skills page's view model (ARCHITECTURE.md §3.3, §3.4; #3098): the skill
// names this workspace's harness sessions reported at start, from
// `list_skills`. The record carries names only, so no version, digest, source,
// cost or decision exists here, and no Money (INV-09). A window in which no
// session reported an inventory has a null reported count, never a zero.
import { z } from "zod";

const Count = z.number().int().nonnegative();
const Instant = z.string().datetime();

export const SkillInventory = z.object({
  window: z.object({ from: Instant, to: Instant }),
  /** Sessions started in the window. */
  sessions: Count,
  /** Sessions that reported an inventory; null when none did. */
  reportedSessions: Count.positive().nullable(),
  /** Sessions whose inventory is null. */
  notReportedSessions: Count,
  skills: z.array(
    z.object({
      /** The name as the harness reported it. */
      name: z.string().min(1),
      /** Sessions in the window that reported it. */
      sessions: Count.positive(),
      /** Harness labels, each once. */
      harnesses: z.array(z.string().min(1)).min(1),
      lastSeenAt: Instant,
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type SkillInventory = z.infer<typeof SkillInventory>;
