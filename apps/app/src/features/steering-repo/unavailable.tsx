// The steering repo panel while no capability answers its read. It names the
// missing capability and draws no state: a placeholder status would read as a
// record. It takes the look of the Steering page's NotBacked panel.
import { useTranslations } from "next-intl";
import { mono, panel, panelBody } from "@/ui/control-styles";

export function SteeringRepoUnavailable({
  capability,
}: {
  /** The capability the read needs, such as `get_steering_repo`. */
  capability: string;
}) {
  const t = useTranslations("repositories.steeringRepo.unavailable");
  return (
    <section
      data-testid="steering-repo-unavailable"
      data-not-backed=""
      data-capability={capability}
      className={`${panel} ${panelBody} flex flex-col gap-1 text-[13px] text-muted-foreground`}
    >
      <p>{t("body")}</p>
      <p>
        {t.rich("capability", {
          capability,
          code: (chunks) => <code className={mono}>{chunks}</code>,
        })}
      </p>
    </section>
  );
}
