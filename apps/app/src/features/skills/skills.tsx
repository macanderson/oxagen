import "server-only";
import { useTranslations } from "next-intl";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { SkillsFailure, SkillsInventory, SkillsLede } from "./sections";
import { SkillSearch } from "./search";
import { SkillVersions } from "./versions";

type SkillsProps = {
  ctx: WsCtx;
  source: DataSource;
  cursor: string | null;
  view?: string;
};
const VIEWS = ["catalog", "search", "versions"] as const;

export async function Skills({
  ctx,
  source,
  cursor,
  view: rawView,
}: SkillsProps) {
  const view = VIEWS.find((value) => value === rawView) ?? "catalog";
  const at = { org: ctx.orgSlug, ws: ctx.wsSlug, cursor, view };
  const read =
    view === "catalog"
      ? await source.skills.inventory(ctx, { cursor })
      : await source.skills.configuration(ctx);
  let body;
  if (!read.ok) body = <SkillsFailure read={read} at={at} />;
  else if ("skills" in read.value)
    body = <SkillsInventory inventory={read.value} at={at} />;
  else if (view === "search")
    body = <SkillSearch at={at} configuration={read.value} />;
  else
    body = (
      <SkillVersions
        at={at}
        configuration={read.value}
        canEdit={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
      />
    );
  return (
    <div className="flex flex-col gap-4">
      <SkillsLede />
      <SkillViews at={at} view={view} />
      {body}
    </div>
  );
}

function SkillViews({
  at,
  view,
}: {
  at: { org: string; ws: string };
  view: string;
}) {
  const t = useTranslations("skills.console");
  return (
    <nav aria-label={t("views")} className="flex flex-wrap gap-2">
      {VIEWS.map((value) => (
        <SafeLink
          key={value}
          className={buttonSecondary}
          aria-current={view === value ? "page" : undefined}
          to={routes.steering(at.org, at.ws, {
            tab: "skills",
            view: value === "catalog" ? undefined : value,
          })}
        >
          {t(value)}
        </SafeLink>
      ))}
    </nav>
  );
}
