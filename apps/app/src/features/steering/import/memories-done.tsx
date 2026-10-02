"use client";
// What the Import Markdown dialog says about memories once the commit ran
// (memory-collection spec, Bulk import: Commit): how many waiting memories it
// stored, a link to the Memories tab where they wait for review, and each
// memory row it left out with what that row repeats. A commit that carried
// no memory row draws nothing here.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { linkText } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import type { ImportCommitted } from "./actions";

type Skip = ImportCommitted["memories"]["skipped"][number];

function useSkipNote(): (skip: Skip) => string {
  const t = useTranslations("steering.import.done.skip");
  return (skip) => {
    const at = { line: skip.line, file: skip.file };
    switch (skip.reason) {
      case "waiting":
        return t("waiting", { ...at, memory: skip.memory ?? "" });
      case "rejected":
        return t("rejected", at);
      case "import":
        return t("import", at);
      case "stored":
        return t("stored", at);
    }
  };
}

export function CommittedMemories({
  org,
  ws,
  memories,
}: {
  org: string;
  ws: string;
  memories: ImportCommitted["memories"];
}) {
  const t = useTranslations("steering.import.done");
  const noteOf = useSkipNote();
  if (memories.stored === 0 && memories.skipped.length === 0) return null;
  return (
    <div data-testid="import-memories-done" className="flex flex-col gap-2">
      <p data-testid="import-memories-stored">
        {t("stored", { count: memories.stored })}
      </p>
      {memories.stored > 0 ? (
        <p className="text-muted-foreground">{t("memoriesNote")}</p>
      ) : null}
      {memories.skipped.length === 0 ? null : (
        <ul
          data-testid="import-memories-skipped"
          className="flex list-disc flex-col gap-0.5 pl-5 text-muted-foreground"
        >
          {memories.skipped.map((skip) => (
            <li key={`${skip.file}:${String(skip.line)}`} data-reason={skip.reason}>
              {noteOf(skip)}
            </li>
          ))}
        </ul>
      )}
      <SafeLink
        to={routes.steeringMemories(org, ws)}
        className={linkText}
        data-testid="import-memories-link"
      >
        {t("memoriesLink")}
      </SafeLink>
    </div>
  );
}
