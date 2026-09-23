// The Library's shelf row (roadmap pages/steering.md): All, Records,
// Instructions, Skills, Memory and Ontology, each with its count in a dim
// span and each carrying `aria-pressed`, inside a group named "Library
// shelves". Picking a shelf is a navigation, so a shelf has an address
// somebody can send and the back button walks the shelves.
//
// Instructions renders only where the workspace has one. A shelf whose count
// has no read yet prints "not recorded" in place of a number, so All is the
// sum of the numbers beside it and never a guess at the rest. It renders on
// the Library alone: an artifact kind is not a peer of an assignment or a
// lifecycle.
import { useTranslations } from "next-intl";
import { buttonSecondary } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import {
  LIBRARY_SHELVES,
  type LibraryShelf,
  type SteeringAt,
  shelfLink,
} from "./view";

/** A count per shelf; null where no read counts that shelf yet. */
export type ShelfCounts = Record<LibraryShelf, number | null>;

const chip = `${buttonSecondary} min-h-7 px-2.5 py-1 text-[12.5px] aria-pressed:border-rule aria-pressed:bg-hl aria-pressed:text-foreground`;

export function ShelfRow({
  at,
  current,
  counts,
}: {
  at: SteeringAt;
  current: LibraryShelf;
  counts: ShelfCounts;
}) {
  const t = useTranslations("steering.shelves");
  const shelves = LIBRARY_SHELVES.filter(
    (shelf) =>
      shelf !== "instructions" ||
      (counts.instructions !== null && counts.instructions > 0),
  );
  return (
    <div
      role="group"
      aria-label={t("label")}
      data-testid="steering-shelves"
      className="flex min-w-0 snap-x gap-1.5 overflow-x-auto pb-0.5"
    >
      {shelves.map((shelf) => {
        const count = counts[shelf];
        return (
          <SafeLink
            key={shelf}
            role="button"
            to={shelfLink(at, shelf)}
            data-shelf={shelf}
            aria-pressed={shelf === current}
            className={`${chip} shrink-0 snap-start`}
          >
            {t(shelf)}
            <span
              className="font-mono text-[11px] text-dim"
              data-count={count === null ? "not-recorded" : String(count)}
            >
              {count === null ? t("notRecorded") : count}
            </span>
          </SafeLink>
        );
      })}
    </div>
  );
}
