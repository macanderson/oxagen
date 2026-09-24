// An element of a Steering tab whose backend does not exist yet (roadmap
// pages/steering.md, Data sources: a row with no store renders NotBacked in
// production). It names what is missing and the issue that tracks it, and it
// draws no figure: a placeholder number would read as a record.
import { useTranslations } from "next-intl";
import { panel, panelBody } from "@/ui/control-styles";

export function NotBacked({
  what,
  issue,
  testId,
}: {
  /** What the element would show, already translated. */
  what: string;
  /** The tracking issue on macanderson/oxagen; 0 while none is filed. */
  issue: number;
  testId: string;
}) {
  const t = useTranslations("steering.bodies");
  return (
    <section
      data-testid={testId}
      data-not-backed=""
      data-issue={issue === 0 ? undefined : String(issue)}
      className={`${panel} ${panelBody} flex flex-col gap-1 text-[13px] text-muted-foreground`}
    >
      <p>{t("notBacked", { what })}</p>
      {issue === 0 ? null : <p>{t("issue", { number: String(issue) })}</p>}
    </section>
  );
}
