// Toolbelts (mockup `tools.md`, Toolbelts tab): the named sets of tool
// versions assigned to agents, and who carries which. A toolbelt is the only
// edge from the registry to an agent, and it decides what a model is shown,
// never what it may call.
//
// Nothing stores a toolbelt yet. A belt exists today only as the tool list
// computed for each agent (`get_agent_toolbelt`), so there is no named set, no
// owner and no assignment record to read (#3852). Both panels keep their
// heading, caption and New toolbelt, and say what is missing in place of the
// rows; an empty table would read as "no belt exists", which the record cannot
// say either way. Each agent's computed list is on its own Toolbelt tab, which
// the Assignments panel links to so the chain does not end here.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import {
  linkText,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { NotBacked } from "./not-backed";
import { StubAction, StubField } from "./stub-action";
import type { ToolsAt } from "./view";

export function Toolbelts({
  at,
  canCreate,
}: {
  at: ToolsAt;
  /** An org Owner or Admin: who would hold `toolbelt.create`. */
  canCreate: boolean;
}) {
  const t = useTranslations("tools.toolbelts");
  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="tools-toolbelts" className={panel}>
        <div className={panelHeader}>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id="tools-toolbelts" className={panelTitle}>
              {t("title")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("caption")}</p>
          </div>
          {canCreate ? (
            <StubAction
              label={t("new.open")}
              tone="primary"
              title={t("new.title")}
              gap="toolbelts"
              note={t("new.note")}
              confirm={t("new.confirm")}
              testId="tools-belt-new"
            >
              <StubField id="belt-name" label={t("new.name")} />
              <StubField id="belt-purpose" label={t("new.purpose")} />
              <StubField
                id="belt-owner"
                label={t("new.owner")}
                options={["platform", "finops", "security"]}
                hint={t("new.ownerHint")}
              />
            </StubAction>
          ) : null}
        </div>
        <div className={`${panelBody} flex flex-col gap-3`}>
          <NotBacked gap="toolbelts" testId="tools-toolbelts-not-backed">
            {t("notBacked")}
          </NotBacked>
          <p className="max-w-prose border-l-2 border-gold pl-3 text-[13px] text-muted-foreground">
            {t("note")}
          </p>
        </div>
      </section>
      <section aria-labelledby="tools-assignments" className={panel}>
        <div className={panelHeader}>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id="tools-assignments" className={panelTitle}>
              {t("assignments.title")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("assignments.caption")}
            </p>
          </div>
        </div>
        <div className={`${panelBody} flex flex-col gap-3`}>
          <NotBacked gap="toolbelts" testId="tools-assignments-not-backed">
            {t("assignments.notBacked")}
          </NotBacked>
          <SafeLink
            to={routes.agents(at.org, at.ws)}
            data-testid="tools-assignments-agents"
            className={`${linkText} text-[13px]`}
          >
            {t("assignments.agents")}
          </SafeLink>
        </div>
      </section>
    </div>
  );
}
