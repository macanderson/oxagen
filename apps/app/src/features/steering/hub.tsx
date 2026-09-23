import { useTranslations } from "next-intl";
import { SafeLink } from "@/ui/navigation";
import {
  LIBRARY_SHELVES,
  type LibraryShelf,
  type SteeringAt,
  steeringLink,
} from "./view";

const chip =
  "inline-flex min-h-11 shrink-0 items-center rounded-md border border-border px-3 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:border-foreground aria-[current=page]:text-foreground";

export function LibraryShelves({
  at,
  current,
}: {
  at: SteeringAt;
  current: LibraryShelf;
}) {
  const t = useTranslations("steering.library");
  return (
    <nav aria-label={t("label")} className="flex flex-wrap gap-2">
      {LIBRARY_SHELVES.map((shelf) => (
        <SafeLink
          key={shelf}
          to={steeringLink(at, { tab: "library", shelf })}
          aria-current={current === shelf ? "page" : undefined}
          className={chip}
        >
          {t(shelf)}
        </SafeLink>
      ))}
    </nav>
  );
}

export function ProposalSections({
  at,
  current,
}: {
  at: SteeringAt;
  current: "candidates" | "prs";
}) {
  const t = useTranslations("steering.proposalSections");
  return (
    <nav aria-label={t("label")} className="flex flex-wrap gap-2">
      {(["candidates", "prs"] as const).map((section) => (
        <SafeLink
          key={section}
          to={steeringLink(at, { tab: "proposals", section })}
          aria-current={current === section ? "page" : undefined}
          className={chip}
        >
          {t(section)}
        </SafeLink>
      ))}
    </nav>
  );
}

export function GovernanceLink({ at }: { at: SteeringAt }) {
  const t = useTranslations("steering");
  return (
    <SafeLink
      to={steeringLink(at, { tab: "proposals", section: "prs" })}
      className={`${chip} self-start`}
    >
      {t("governance")}
    </SafeLink>
  );
}
