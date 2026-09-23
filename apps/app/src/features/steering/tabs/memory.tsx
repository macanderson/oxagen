// The Library's Memory shelf (roadmap pages/steering-memory.md). The hub reads
// the memories, because a workspace with none is this shelf's empty state and
// the empty state takes the gold from the header (../steering.tsx); the body
// is drawn from that one read.
import { useTranslations } from "next-intl";
import type { MemoryPage } from "@/data/contracts/steering";
import { MemoryShelfBody } from "../memory-shelf";
import { ShelfEmpty } from "../page-state";
import type { SteeringAt } from "../view";

export function MemoryShelf({
  at,
  page,
}: {
  at: SteeringAt;
  page: MemoryPage;
}) {
  const t = useTranslations("steering.bodies.memory");
  if (page.total === 0) {
    // Nothing on this shelf is authored here, so the empty state has no action.
    return (
      <ShelfEmpty testId="memory-empty" title={t("empty.title")}>
        {t("empty.body")}
      </ShelfEmpty>
    );
  }
  return (
    <MemoryShelfBody at={at} memories={page.memories} total={page.total} />
  );
}
