// The Library's Assistant memory shelf (roadmap pages/steering-memory.md). The
// hub reads the memories, because a workspace with none is this shelf's empty
// state and the empty state takes the gold from the header (../steering.tsx);
// the body is drawn from that one read.
//
// The shelf holds what Oxagen's own assistant saved, from list_memories. The
// memories the workspace's agents write in their harnesses are on the
// Memories tab (#4914). Mac ruled that the assistant never receives those, so
// the two stores stay apart, and the hint above the shelf says where the
// other one is.
import { useTranslations } from "next-intl";
import type { MemoryPage } from "@/data/contracts/steering";
import { MemoryShelfBody } from "../memory-shelf";
import { ShelfEmpty } from "../page-state";
import { Note } from "../tab-parts";
import type { SteeringAt } from "../view";

export function MemoryShelf({
  at,
  page,
}: {
  at: SteeringAt;
  page: MemoryPage;
}) {
  const t = useTranslations("steering.bodies.memory");
  return (
    <div className="flex flex-col gap-3.5">
      <Note testId="memory-shelf-hint">{t("hint")}</Note>
      {page.total === 0 ? (
        // Nothing on this shelf is authored here, so the empty state has no action.
        <ShelfEmpty testId="memory-empty" title={t("empty.title")}>
          {t("empty.body")}
        </ShelfEmpty>
      ) : (
        <MemoryShelfBody at={at} memories={page.memories} total={page.total} />
      )}
    </div>
  );
}
