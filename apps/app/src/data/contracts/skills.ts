// The Skills page's view model (ARCHITECTURE.md §3.3, §3.4; #3098): the skill
// names this workspace's harness sessions reported at start, from
// `list_skills`. The record carries names only, so no version, digest, source,
// cost or decision exists here, and no Money (INV-09). A window in which no
// session reported an inventory has a null reported count, never a zero.
//
// `harnesses` round-trips exactly what a session reported, including an empty
// string, up to the read's per-row cap; `harnessCount` carries the true
// distinct count behind the name past that cap — never rejected or re-split
// from a delimited string (ADR-104, #3103).
import { z } from "zod";

const Count = z.number().int().nonnegative();
const Instant = z.iso.datetime();

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
      /** Harness labels, each once, up to the read's per-row cap. */
      harnesses: z.array(z.string()).min(1),
      /** The true distinct harness count behind this name, past that cap. */
      harnessCount: Count.positive(),
      lastSeenAt: Instant,
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type SkillInventory = z.infer<typeof SkillInventory>;
