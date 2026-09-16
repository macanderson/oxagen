// The Skills page body (#3098; ARCHITECTURE.md §1.2): one page of the skill
// names this workspace's harness sessions reported at start, read through the
// skills port (`list_skills`, noBillingGate). A read that does not answer
// replaces the body with its state.
import "server-only";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { SkillsFailure, SkillsInventory } from "./sections";

type SkillsProps = {
  ctx: WsCtx;
  source: DataSource;
  /** The inventory page the URL names; null for the first. */
  cursor: string | null;
};

export async function Skills({ ctx, source, cursor }: SkillsProps) {
  const at = { org: ctx.orgSlug, ws: ctx.wsSlug, cursor };
  const read = await source.skills.inventory(ctx, { cursor });
  return read.ok ? (
    <SkillsInventory inventory={read.value} at={at} />
  ) : (
    <SkillsFailure read={read} at={at} />
  );
}
